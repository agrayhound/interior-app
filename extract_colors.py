"""
Extract dominant color from each product's primary image using PIL.
Writes data/product_colors.json: { "product_id": "#rrggbb", ... }

Resumable — skips products already in the output file.
Run: python3 extract_colors.py
"""
import io
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional, Tuple

import requests
from dotenv import load_dotenv
from PIL import Image

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
OUTPUT_FILE = Path(__file__).parent / "data" / "product_colors.json"
PAGE_SIZE = 500
WORKERS = 10
REQUEST_TIMEOUT = 15

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
}


def supabase_get(table: str, params: dict) -> list:
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=HEADERS, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def dominant_color(img_bytes: bytes) -> Optional[str]:
    """
    Return the dominant non-background tile hex color from image bytes.

    Strategy:
    1. Center-crop to the middle 60% of the image — removes framing/backgrounds.
    2. Quantize to 8 clusters (more resolution than 5).
    3. Discard near-white (sum>680), near-black (sum<45), AND near-grey
       (chroma = max-min < 25) — this is the key fix: grout lines and grey
       backgrounds are low-saturation and must be excluded.
    4. Among remaining "colorful" clusters, pick the most frequent.
    5. If no colorful cluster survives, fall back to the most vivid (highest
       chroma) cluster regardless of frequency — better than returning grey.
    """
    try:
        img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        w, h = img.size

        # Center crop — middle 60% width × 70% height
        x0 = int(w * 0.20)
        y0 = int(h * 0.15)
        x1 = int(w * 0.80)
        y1 = int(h * 0.85)
        img = img.crop((x0, y0, x1, y1)).resize((100, 100))

        quantized = img.quantize(colors=8)
        palette = quantized.getpalette()
        counts = quantized.getcolors(maxcolors=10000) or []

        colorful = []  # passes all filters
        all_clusters = []

        for count, idx in counts:
            r, g, b = palette[idx * 3], palette[idx * 3 + 1], palette[idx * 3 + 2]
            total = r + g + b
            chroma = max(r, g, b) - min(r, g, b)  # 0=grey, 255=fully saturated
            all_clusters.append((count, chroma, r, g, b))
            if 45 < total < 680 and chroma >= 25:
                colorful.append((count, r, g, b))

        if colorful:
            # Best cluster by count × chroma — prevents high-count neutral grout
            # (e.g. count=536, chroma=34 → score=18224) from beating a vivid tile
            # cluster (e.g. count=200, chroma=103 → score=20600)
            _, r, g, b = max(colorful, key=lambda x: x[0] * (max(x[1], x[2], x[3]) - min(x[1], x[2], x[3])))  # count × chroma
        elif all_clusters:
            # Fallback: most vivid cluster (highest chroma) regardless of freq
            _, _, r, g, b = max(all_clusters, key=lambda x: x[1])
        else:
            return None

        return f"#{r:02x}{g:02x}{b:02x}"
    except Exception:
        return None


def process_product(product: dict) -> Tuple[str, Optional[str]]:
    pid = str(product["id"])
    url = product.get("thumbnail_url") or ""
    if not url.startswith("http"):
        return pid, None
    try:
        r = requests.get(url, timeout=REQUEST_TIMEOUT, headers={"User-Agent": "Mozilla/5.0"})
        if not r.ok:
            return pid, None
        return pid, dominant_color(r.content)
    except Exception:
        return pid, None


def main():
    OUTPUT_FILE.parent.mkdir(exist_ok=True)

    # Load existing results for resumability
    existing: dict[str, str] = {}
    if OUTPUT_FILE.exists():
        try:
            existing = json.loads(OUTPUT_FILE.read_text())
        except Exception:
            pass
    print(f"Already processed: {len(existing)} products")

    # Fetch all products with a thumbnail_url
    print("Fetching product list from Supabase…")
    all_products = []
    offset = 0
    while True:
        batch = supabase_get("products", {
            "select": "id,thumbnail_url",
            "thumbnail_url": "not.is.null",
            "limit": PAGE_SIZE,
            "offset": offset,
        })
        if not batch:
            break
        all_products.extend(batch)
        offset += PAGE_SIZE
        if len(batch) < PAGE_SIZE:
            break

    to_process = [p for p in all_products if str(p["id"]) not in existing]
    total = len(to_process)
    print(f"Products to process: {total} (total with images: {len(all_products)})")

    if total == 0:
        print("Nothing to do.")
        return

    results = dict(existing)
    done = 0
    errors = 0
    start = time.time()

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(process_product, p): p for p in to_process}
        for future in as_completed(futures):
            pid, hex_color = future.result()
            done += 1
            if hex_color:
                results[pid] = hex_color
            else:
                errors += 1

            if done % 100 == 0 or done == total:
                elapsed = time.time() - start
                rate = done / elapsed
                remaining = (total - done) / rate if rate > 0 else 0
                print(f"  {done}/{total} | {rate:.1f}/s | errors={errors} | ETA {remaining:.0f}s")
                # Checkpoint
                OUTPUT_FILE.write_text(json.dumps(results))

    OUTPUT_FILE.write_text(json.dumps(results))
    print(f"\nDone. {len(results)} colors written to {OUTPUT_FILE}")
    print(f"Errors/skipped: {errors}")


if __name__ == "__main__":
    main()
