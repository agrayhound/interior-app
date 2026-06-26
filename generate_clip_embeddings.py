#!/usr/bin/env python3
"""
Generate CLIP (512-dim) visual embeddings for all product primary images
and store them in product_embeddings.clip_embedding.

Requires the migration SQL to be run first:
  supabase/migrations/20260622213221_add_clip_embedding.sql
"""

import asyncio
import io
import os
import sys
import time
from pathlib import Path

import httpx
import torch
from PIL import Image
from transformers import CLIPModel, CLIPProcessor

# ── Config ──────────────────────────────────────────────────────────────────

SUPABASE_URL = "https://dnghimclwgjmtnesxdmo.supabase.co"
KEY = os.environ['SUPABASE_SERVICE_KEY']

HEADERS = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Content-Type": "application/json",
}
PATCH_HEADERS = {**HEADERS, "Prefer": "return=minimal"}

CLIP_MODEL = "openai/clip-vit-base-patch32"
CONCURRENCY = 5
IMG_TIMEOUT = 20.0

# ── CLIP setup ───────────────────────────────────────────────────────────────

print(f"Loading {CLIP_MODEL}…")
model = CLIPModel.from_pretrained(CLIP_MODEL)
processor = CLIPProcessor.from_pretrained(CLIP_MODEL)
model.eval()
device = "cpu"  # MPS/CUDA auto-detect if available
if torch.backends.mps.is_available():
    device = "mps"
elif torch.cuda.is_available():
    device = "cuda"
model = model.to(device)
print(f"  CLIP loaded on {device}")


def clip_embed_image(pil_img: Image.Image) -> list[float]:
    inputs = processor(images=pil_img, return_tensors="pt").to(device)
    with torch.no_grad():
        features = model.get_image_features(**inputs)
        features = features / features.norm(dim=-1, keepdim=True)  # L2 normalise
    return features[0].cpu().tolist()


def clip_embed_text(text: str) -> list[float]:
    inputs = processor(text=[text], return_tensors="pt", padding=True).to(device)
    with torch.no_grad():
        features = model.get_text_features(**inputs)
        features = features / features.norm(dim=-1, keepdim=True)
    return features[0].cpu().tolist()


# ── Supabase helpers ─────────────────────────────────────────────────────────

async def fetch_products_needing_clip(client: httpx.AsyncClient) -> list[dict]:
    """
    Return product_embeddings rows where clip_embedding IS NULL,
    joined with primary image URL.
    """
    # Get all embedding rows missing clip_embedding
    r = await client.get(
        f"{SUPABASE_URL}/rest/v1/product_embeddings",
        headers=HEADERS,
        params={
            "select": "id,product_id",
            "clip_embedding": "is.null",
        },
    )
    r.raise_for_status()
    embed_rows = r.json()
    print(f"  {len(embed_rows)} products need CLIP embeddings")
    if not embed_rows:
        return []

    # Fetch primary images for all these product_ids
    product_ids = [str(row["product_id"]) for row in embed_rows]
    chunks = [product_ids[i:i+200] for i in range(0, len(product_ids), 200)]
    image_map = {}  # product_id → url
    for chunk in chunks:
        id_filter = "(" + ",".join(chunk) + ")"
        r2 = await client.get(
            f"{SUPABASE_URL}/rest/v1/product_images",
            headers=HEADERS,
            params={
                "select": "product_id,url",
                "product_id": f"in.{id_filter}",
                "is_primary": "eq.true",
            },
        )
        r2.raise_for_status()
        for img in r2.json():
            image_map[img["product_id"]] = img["url"]

    # Attach image URL to each embedding row; skip if no image
    result = []
    for row in embed_rows:
        url = image_map.get(row["product_id"])
        if url:
            result.append({**row, "image_url": url})
        else:
            print(f"  SKIP product_id={row['product_id']} (no primary image)")
    return result


async def store_clip_embedding(
    client: httpx.AsyncClient, embed_id: int, vector: list[float]
) -> None:
    r = await client.patch(
        f"{SUPABASE_URL}/rest/v1/product_embeddings",
        headers=PATCH_HEADERS,
        params={"id": f"eq.{embed_id}"},
        json={"clip_embedding": vector},
    )
    if r.status_code not in (200, 204):
        raise RuntimeError(f"PATCH {embed_id}: {r.status_code} {r.text[:200]}")


# ── Worker ───────────────────────────────────────────────────────────────────

async def process_row(
    sem: asyncio.Semaphore,
    client: httpx.AsyncClient,
    row: dict,
    idx: int,
    total: int,
) -> None:
    product_id = row["product_id"]
    embed_id   = row["id"]
    img_url    = row["image_url"]

    async with sem:
        try:
            r = await client.get(img_url, timeout=IMG_TIMEOUT, follow_redirects=True)
            r.raise_for_status()
            pil_img = Image.open(io.BytesIO(r.content)).convert("RGB")
            vector  = clip_embed_image(pil_img)
            await store_clip_embedding(client, embed_id, vector)
            print(f"  [{idx}/{total}] ✓ product_id={product_id}")
        except Exception as e:
            print(f"  [{idx}/{total}] ✗ product_id={product_id}: {e}", file=sys.stderr)


# ── Main ─────────────────────────────────────────────────────────────────────

async def main() -> None:
    start = time.monotonic()

    async with httpx.AsyncClient(timeout=60.0) as client:
        rows = await fetch_products_needing_clip(client)
        if not rows:
            print("Nothing to do — all CLIP embeddings already present.")
            return

        sem = asyncio.Semaphore(CONCURRENCY)
        tasks = [
            process_row(sem, client, row, i + 1, len(rows))
            for i, row in enumerate(rows)
        ]
        await asyncio.gather(*tasks)

    elapsed = time.monotonic() - start
    print(f"\nDone in {elapsed:.1f}s")


if __name__ == "__main__":
    asyncio.run(main())
