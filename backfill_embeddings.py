#!/usr/bin/env python3
"""
Backfill product_embeddings for products that were analyzed (analyzed_at IS NOT NULL)
but have no embedding yet (from the failed first run where upsert was blocked by 403).
Reads analysis fields directly from products table — no Claude calls needed.
"""

import asyncio
import json
import time
from datetime import datetime, timezone

import httpx
from openai import OpenAI

SUPABASE_URL = "https://dnghimclwgjmtnesxdmo.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRuZ2hpbWNsd2dqbXRuZXN4ZG1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTAyOTA5NCwiZXhwIjoyMDk2NjA1MDk0fQ.pkSlai_x2w347sDFgwne0GViYu4bXtWPpTkK-cdFi2M"
OPENAI_API_KEY = "os.environ['OPENAI_API_KEY']"
EMBED_MODEL = "text-embedding-3-small"

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}


def build_embed_text(name: str, p: dict) -> str:
    parts = [
        f"Product: {name}",
        f"Style: {', '.join(p.get('style_tags') or [])}",
        f"Material: {p.get('material_look') or ''}",
        f"Mood: {', '.join(p.get('mood_tags') or [])}",
        f"Pattern: {p.get('pattern_type') or ''}",
        f"Finish: {p.get('finish_look') or ''}",
        f"Colors: {', '.join(p.get('color_palette') or [])}",
        f"Rooms: {', '.join(p.get('room_suitability') or [])}",
    ]
    return ". ".join(p2 for p2 in parts if p2.split(": ", 1)[1])


async def fetch_orphans(client: httpx.AsyncClient) -> list:
    """Products with analyzed_at set but no embedding row."""
    # Fetch all analyzed product_ids that have embeddings
    embedded = set()
    offset = 0
    while True:
        r = await client.get(f"{SUPABASE_URL}/rest/v1/product_embeddings",
            headers=HEADERS, params={"select": "product_id", "limit": 1000, "offset": offset})
        rows = r.json()
        for row in rows:
            embedded.add(row["product_id"])
        if len(rows) < 1000:
            break
        offset += 1000

    # Fetch all analyzed products
    orphans = []
    offset = 0
    while True:
        r = await client.get(f"{SUPABASE_URL}/rest/v1/products",
            headers=HEADERS, params={
                "select": "id,name,style_tags,material_look,mood_tags,pattern_type,finish_look,color_palette,room_suitability",
                "analyzed_at": "not.is.null",
                "limit": 1000,
                "offset": offset,
            })
        rows = r.json()
        for row in rows:
            if row["id"] not in embedded:
                orphans.append(row)
        if len(rows) < 1000:
            break
        offset += 1000

    return orphans


async def main():
    openai_client = OpenAI(api_key=OPENAI_API_KEY)
    semaphore = asyncio.Semaphore(10)

    async with httpx.AsyncClient(timeout=30.0) as http:
        orphans = await fetch_orphans(http)
        print(f"Orphans to backfill: {len(orphans)}")

        stats = {"done": 0, "errors": 0, "total": len(orphans), "start": time.monotonic()}

        async def process(p):
            async with semaphore:
                try:
                    embed_text = build_embed_text(p["name"], p)
                    embedding = openai_client.embeddings.create(model=EMBED_MODEL, input=embed_text).data[0].embedding
                    now_iso = datetime.now(timezone.utc).isoformat()
                    upsert_headers = {**HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal"}
                    r = await http.post(
                        f"{SUPABASE_URL}/rest/v1/product_embeddings",
                        headers=upsert_headers,
                        params={"on_conflict": "product_id"},
                        json={"product_id": p["id"], "embed_text": embed_text, "embedding": embedding, "model": EMBED_MODEL, "created_at": now_iso},
                    )
                    r.raise_for_status()
                    stats["done"] += 1
                    print(f"  [OK] #{p['id']} {p['name'][:40]} | {stats['done']}/{stats['total']}")
                except Exception as e:
                    stats["errors"] += 1
                    print(f"  [FAIL] #{p['id']} {p['name']}: {e}")

        await asyncio.gather(*[process(p) for p in orphans])

    elapsed = time.monotonic() - stats["start"]
    print(f"\nDone in {elapsed:.1f}s | OK={stats['done']} | errors={stats['errors']}")


if __name__ == "__main__":
    asyncio.run(main())
