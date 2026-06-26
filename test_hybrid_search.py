#!/usr/bin/env python3
"""
Test hybrid vs semantic-only search using a query image.
Prints results side-by-side ranked by each method.
"""

import asyncio
import io
import sys
import torch
from PIL import Image
from transformers import CLIPModel, CLIPProcessor
import httpx
import openai

SUPABASE_URL = "https://dnghimclwgjmtnesxdmo.supabase.co"
KEY = os.environ['SUPABASE_SERVICE_KEY']
OPENAI_KEY = "os.environ['OPENAI_API_KEY']"

HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

TEST_IMAGE_URL = sys.argv[1] if len(sys.argv) > 1 else \
    "https://stone-tile.com/media/catalog/product/c/o/concrete-mosaic.jpg"

CLIP_MODEL = "openai/clip-vit-base-patch32"


def load_clip():
    print(f"Loading CLIP…")
    model = CLIPModel.from_pretrained(CLIP_MODEL)
    proc  = CLIPProcessor.from_pretrained(CLIP_MODEL)
    model.eval()
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    return model.to(device), proc, device


def embed_image(model, proc, device, pil_img):
    inputs = proc(images=pil_img, return_tensors="pt").to(device)
    with torch.no_grad():
        feat = model.get_image_features(**inputs)
        feat = feat / feat.norm(dim=-1, keepdim=True)
    return feat[0].cpu().tolist()


async def fetch_image(client, url) -> Image.Image:
    r = await client.get(url, timeout=20, follow_redirects=True)
    r.raise_for_status()
    return Image.open(io.BytesIO(r.content)).convert("RGB")


async def text_embed(text: str) -> list[float]:
    oc = openai.AsyncOpenAI(api_key=OPENAI_KEY)
    res = await oc.embeddings.create(model="text-embedding-3-small", input=text)
    return res.data[0].embedding


async def rpc(client, fn, payload) -> list[dict]:
    r = await client.post(
        f"{SUPABASE_URL}/rest/v1/rpc/{fn}",
        headers=HEADERS,
        json=payload,
    )
    if r.status_code not in (200, 201):
        raise RuntimeError(f"{fn}: {r.status_code} {r.text[:300]}")
    return r.json()


async def main():
    print(f"\nTest image: {TEST_IMAGE_URL}\n")

    model, proc, device = load_clip()

    async with httpx.AsyncClient() as client:
        # Fetch and embed the test image
        print("Fetching query image…")
        pil_img = await fetch_image(client, TEST_IMAGE_URL)
        print(f"  Image size: {pil_img.size}")

        # CLIP visual embedding of query image
        clip_vec = embed_image(model, proc, device, pil_img)
        print(f"  CLIP embedding dim: {len(clip_vec)}")

        # Text embedding (describe from image name / path)
        query_text = "concrete mosaic tile grey textured matte surface"
        text_vec   = await text_embed(query_text)
        print(f"  Text embedding dim: {len(text_vec)}")

        # ── Semantic-only search ─────────────────────────────────────────────
        print("\nRunning semantic-only search…")
        try:
            semantic_results = await rpc(client, "search_similar_tiles", {
                "query_embedding": text_vec,
                "match_count": 10,
            })
        except Exception as e:
            print(f"  ERROR: {e}")
            semantic_results = []

        # ── Hybrid search ───────────────────────────────────────────────────
        print("Running hybrid search…")
        try:
            hybrid_results = await rpc(client, "search_similar_tiles_hybrid", {
                "query_embedding": text_vec,
                "query_clip_embedding": clip_vec,
                "match_count": 10,
            })
        except Exception as e:
            print(f"  ERROR (hybrid RPC not yet deployed?): {e}")
            hybrid_results = []

        # ── Side-by-side comparison ─────────────────────────────────────────
        print("\n" + "=" * 80)
        print(f"{'SEMANTIC-ONLY':^39} │ {'HYBRID (0.6×text + 0.4×CLIP)':^38}")
        print("=" * 80)

        max_rows = max(len(semantic_results), len(hybrid_results))
        for i in range(max_rows):
            s = semantic_results[i] if i < len(semantic_results) else None
            h = hybrid_results[i]   if i < len(hybrid_results)   else None

            s_str = f"{i+1:2}. {(s['name'] or '')[:24]:<24} {float(s['similarity'])*100:5.1f}%" if s else " " * 39
            h_str = f"{i+1:2}. {(h['name'] or '')[:24]:<24} {float(h['similarity'])*100:5.1f}% (sem={float(h.get('semantic_score',0))*100:.0f}% clip={float(h.get('clip_score') or 0)*100:.0f}%)" if h else ""
            print(f"{s_str} │ {h_str}")

        print("=" * 80)

        # Rank-change analysis
        # semantic RPC returns product_id; hybrid returns id
        def pid(r, is_sem):
            return r["product_id"] if is_sem else r["id"]

        if semantic_results and hybrid_results:
            sem_rank = {pid(r, True): i  for i, r in enumerate(semantic_results)}
            hyb_rank = {pid(r, False): i for i, r in enumerate(hybrid_results)}
            all_ids  = set(sem_rank) | set(hyb_rank)
            moved    = [(hyb_rank.get(p, 10) - sem_rank.get(p, 10), p,
                         next((r["name"] for r in hybrid_results if r["id"] == p), "?"))
                        for p in all_ids]
            moved.sort()
            print("\nRank changes (negative = promoted by CLIP, positive = demoted):")
            for delta, p, name in moved:
                if delta != 0:
                    print(f"  {delta:+d}  {name[:40]}")
        else:
            print("\nNote: Run the SQL migration and generate_clip_embeddings.py first for hybrid results.")


if __name__ == "__main__":
    asyncio.run(main())
