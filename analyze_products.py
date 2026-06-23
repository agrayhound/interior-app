#!/usr/bin/env python3
"""
Vision analysis pipeline for interior-app tile products.
- Fetches products with analyzed_at IS NULL + their primary image
- Sends image to Claude claude-sonnet-4-6 for structured JSON extraction
- Generates OpenAI text-embedding-3-small vector from embed text
- Updates products table with analysis fields
- Upserts into product_embeddings table
- Rate limit: 20 requests/min to Claude (OpenAI embeddings are fast, no throttle)
"""

import asyncio
import json
import os
import sys
import time
import base64
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Optional

import httpx
import anthropic
from openai import OpenAI

# ── Config ──────────────────────────────────────────────────────────────────
SUPABASE_URL = "https://dnghimclwgjmtnesxdmo.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRuZ2hpbWNsd2dqbXRuZXN4ZG1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTAyOTA5NCwiZXhwIjoyMDk2NjA1MDk0fQ.pkSlai_x2w347sDFgwne0GViYu4bXtWPpTkK-cdFi2M"
ANTHROPIC_API_KEY = "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"
OPENAI_API_KEY = "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"

CLAUDE_MODEL = "claude-sonnet-4-6"
EMBED_MODEL = "text-embedding-3-small"
RATE_LIMIT_PER_MIN = 20
BATCH_PAGE_SIZE = 200
MAX_RETRIES = 3

SUPABASE_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}

VISION_PROMPT = """Analyze this tile/surface product image and return ONLY a valid JSON object with exactly these keys:

{
  "style_tags": ["<tag1>", "<tag2>", ...],
  "material_look": "<primary material appearance>",
  "mood_tags": ["<mood1>", "<mood2>", ...],
  "pattern_type": "<pattern description>",
  "finish_look": "<finish description>",
  "color_palette": ["<color1>", "<color2>", ...],
  "room_suitability": ["<room1>", "<room2>", ...]
}

Guidelines:
- style_tags: 3-6 tags like "minimalist", "rustic", "industrial", "coastal", "contemporary", "traditional", "Scandinavian", "Mediterranean"
- material_look: one of "marble", "concrete", "wood", "stone", "ceramic", "terrazzo", "travertine", "slate", "limestone", "porcelain", "mosaic", "brick", "metal", "glass"
- mood_tags: 2-4 tags like "warm", "cool", "earthy", "bright", "moody", "serene", "bold", "elegant", "cozy", "fresh"
- pattern_type: one of "solid", "veined", "geometric", "floral", "abstract", "textured", "mosaic", "striped", "herringbone", "chevron", "encaustic", "subway"
- finish_look: one of "matte", "gloss", "satin", "polished", "honed", "brushed", "textured", "lappato", "natural"
- color_palette: 2-5 dominant colors as plain color names like "white", "warm grey", "beige", "charcoal", "cream", "terracotta", "sage green"
- room_suitability: 2-5 rooms like "bathroom", "kitchen", "living room", "bedroom", "hallway", "outdoor", "laundry"

Return ONLY the JSON object, no markdown, no explanation."""


# ── Rate limiter (token bucket, 20/min) ─────────────────────────────────────
class RateLimiter:
    def __init__(self, per_minute: int):
        self.interval = 60.0 / per_minute
        self._lock = asyncio.Lock()
        self._last = 0.0

    async def acquire(self):
        async with self._lock:
            now = time.monotonic()
            wait = self._last + self.interval - now
            if wait > 0:
                await asyncio.sleep(wait)
            self._last = time.monotonic()


# ── Supabase helpers ─────────────────────────────────────────────────────────
async def supabase_get(client: httpx.AsyncClient, path: str, params: dict) -> list:
    r = await client.get(f"{SUPABASE_URL}/rest/v1/{path}", headers=SUPABASE_HEADERS, params=params)
    r.raise_for_status()
    return r.json()


async def supabase_patch(client: httpx.AsyncClient, path: str, match: dict, data: dict):
    params = {k: f"eq.{v}" for k, v in match.items()}
    r = await client.patch(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers=SUPABASE_HEADERS,
        params=params,
        json=data,
    )
    r.raise_for_status()


async def supabase_upsert(client: httpx.AsyncClient, path: str, data: dict, on_conflict: str):
    headers = {**SUPABASE_HEADERS, "Prefer": f"resolution=merge-duplicates,return=minimal"}
    r = await client.post(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers=headers,
        params={"on_conflict": on_conflict},
        json=data,
    )
    r.raise_for_status()


# ── Fetch products needing analysis ─────────────────────────────────────────
async def fetch_pending_products(client: httpx.AsyncClient, offset: int) -> list:
    """Returns products with analyzed_at IS NULL, joined with primary image URL."""
    rows = await supabase_get(client, "products", {
        "select": "id,name,analyzed_at",
        "analyzed_at": "is.null",
        "order": "id.asc",
        "limit": BATCH_PAGE_SIZE,
        "offset": offset,
    })
    return rows


async def fetch_primary_image(client: httpx.AsyncClient, product_id: int) -> Optional[str]:
    rows = await supabase_get(client, "product_images", {
        "select": "url",
        "product_id": f"eq.{product_id}",
        "is_primary": "eq.true",
        "limit": 1,
    })
    if rows:
        return rows[0]["url"]
    # fallback: first image
    rows = await supabase_get(client, "product_images", {
        "select": "url",
        "product_id": f"eq.{product_id}",
        "order": "position.asc",
        "limit": 1,
    })
    return rows[0]["url"] if rows else None


# ── Fetch image as base64 ────────────────────────────────────────────────────
async def fetch_image_b64(client: httpx.AsyncClient, url: str) -> tuple[str, str]:
    """Returns (base64_data, media_type)."""
    r = await client.get(url, timeout=30.0, follow_redirects=True)
    r.raise_for_status()
    ct = r.headers.get("content-type", "image/jpeg").split(";")[0].strip()
    if ct not in ("image/jpeg", "image/png", "image/gif", "image/webp"):
        ct = "image/jpeg"
    return base64.standard_b64encode(r.content).decode(), ct


# ── Claude vision analysis ───────────────────────────────────────────────────
def analyze_image_with_claude(
    anthropic_client: anthropic.Anthropic,
    image_b64: str,
    media_type: str,
) -> dict:
    msg = anthropic_client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=512,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": image_b64,
                    },
                },
                {"type": "text", "text": VISION_PROMPT},
            ],
        }],
    )
    text = msg.content[0].text.strip()
    # Strip markdown fences if present
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    return json.loads(text)


# ── Build embed text ─────────────────────────────────────────────────────────
def build_embed_text(product_name: str, analysis: dict) -> str:
    parts = [
        f"Product: {product_name}",
        f"Style: {', '.join(analysis.get('style_tags', []))}",
        f"Material: {analysis.get('material_look', '')}",
        f"Mood: {', '.join(analysis.get('mood_tags', []))}",
        f"Pattern: {analysis.get('pattern_type', '')}",
        f"Finish: {analysis.get('finish_look', '')}",
        f"Colors: {', '.join(analysis.get('color_palette', []))}",
        f"Rooms: {', '.join(analysis.get('room_suitability', []))}",
    ]
    return ". ".join(p for p in parts if p.split(": ", 1)[1])


# ── OpenAI embedding ─────────────────────────────────────────────────────────
def get_embedding(openai_client: OpenAI, text: str) -> list[float]:
    r = openai_client.embeddings.create(model=EMBED_MODEL, input=text)
    return r.data[0].embedding


# ── Process one product ──────────────────────────────────────────────────────
async def process_product(
    product: dict,
    http: httpx.AsyncClient,
    anthropic_client: anthropic.Anthropic,
    openai_client: OpenAI,
    rate_limiter: RateLimiter,
    stats: dict,
):
    pid = product["id"]
    name = product["name"]

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            image_url = await fetch_primary_image(http, pid)
            if not image_url:
                print(f"  [SKIP] #{pid} {name} — no image")
                stats["skipped"] += 1
                return

            image_b64, media_type = await fetch_image_b64(http, image_url)

            # Wait for rate limit slot before calling Claude
            await rate_limiter.acquire()

            analysis = analyze_image_with_claude(anthropic_client, image_b64, media_type)

            embed_text = build_embed_text(name, analysis)
            embedding = get_embedding(openai_client, embed_text)

            now_iso = datetime.now(timezone.utc).isoformat()

            # Update products table
            await supabase_patch(http, "products", {"id": pid}, {
                "style_tags": analysis.get("style_tags"),
                "material_look": analysis.get("material_look"),
                "mood_tags": analysis.get("mood_tags"),
                "pattern_type": analysis.get("pattern_type"),
                "finish_look": analysis.get("finish_look"),
                "color_palette": analysis.get("color_palette"),
                "room_suitability": analysis.get("room_suitability"),
                "analyzed_at": now_iso,
            })

            # Upsert product_embeddings
            await supabase_upsert(http, "product_embeddings", {
                "product_id": pid,
                "embed_text": embed_text,
                "embedding": embedding,
                "model": EMBED_MODEL,
                "created_at": now_iso,
            }, on_conflict="product_id")

            stats["done"] += 1
            elapsed = time.monotonic() - stats["start"]
            rate = stats["done"] / (elapsed / 60) if elapsed > 0 else 0
            print(
                f"  [OK] #{pid} {name[:40]} | "
                f"{stats['done']}/{stats['total']} done | "
                f"{rate:.1f}/min | "
                f"errors={stats['errors']}"
            )
            return

        except json.JSONDecodeError as e:
            print(f"  [WARN] #{pid} JSON parse error attempt {attempt}: {e}")
        except httpx.HTTPStatusError as e:
            print(f"  [WARN] #{pid} HTTP {e.response.status_code} attempt {attempt}")
            if e.response.status_code == 429:
                await asyncio.sleep(60)
        except Exception as e:
            print(f"  [WARN] #{pid} attempt {attempt}: {type(e).__name__}: {e}")

        if attempt < MAX_RETRIES:
            await asyncio.sleep(5 * attempt)

    print(f"  [FAIL] #{pid} {name} — gave up after {MAX_RETRIES} attempts")
    stats["errors"] += 1


# ── Main ─────────────────────────────────────────────────────────────────────
async def main():
    anthropic_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    openai_client = OpenAI(api_key=OPENAI_API_KEY)
    rate_limiter = RateLimiter(RATE_LIMIT_PER_MIN)

    # Concurrency: 20/min ≈ 1 every 3s. Run up to 5 concurrent so we stay
    # near 20/min with the rate limiter gating each Claude call individually.
    semaphore = asyncio.Semaphore(5)

    async with httpx.AsyncClient(timeout=60.0) as http:
        # Count pending
        count_rows = await supabase_get(http, "products", {
            "select": "id",
            "analyzed_at": "is.null",
            "limit": 1,
            "offset": 0,
        })
        # Use head count via Range header
        r = await http.get(
            f"{SUPABASE_URL}/rest/v1/products",
            headers={**SUPABASE_HEADERS, "Prefer": "count=exact"},
            params={"analyzed_at": "is.null", "select": "id", "limit": 1},
        )
        total = int(r.headers.get("content-range", "0/0").split("/")[-1]) if "/" in r.headers.get("content-range", "") else 0

        stats = {"done": 0, "errors": 0, "skipped": 0, "total": total, "start": time.monotonic()}
        print(f"Starting pipeline: {total} products to analyze at {RATE_LIMIT_PER_MIN}/min")
        print(f"Model: {CLAUDE_MODEL} → {EMBED_MODEL}")
        print("-" * 60)

        offset = 0
        while True:
            batch = await fetch_pending_products(http, offset)
            if not batch:
                break

            async def run(p):
                async with semaphore:
                    await process_product(p, http, anthropic_client, openai_client, rate_limiter, stats)

            await asyncio.gather(*[run(p) for p in batch])

            # Don't advance offset — completed rows are no longer returned by
            # the analyzed_at IS NULL filter, so the next page-0 fetch gets the
            # next unprocessed batch automatically.
            if len(batch) < BATCH_PAGE_SIZE:
                break

    elapsed = time.monotonic() - stats["start"]
    print("-" * 60)
    print(f"Done in {elapsed/60:.1f} min | "
          f"OK={stats['done']} | errors={stats['errors']} | skipped={stats['skipped']}")


if __name__ == "__main__":
    asyncio.run(main())
