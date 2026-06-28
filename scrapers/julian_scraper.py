#!/usr/bin/env python3
"""
Julian Tile scraper — Squarespace ?format=json API
All 667 products live in a single collection: /floor-wall-tile
Paginate with &offset=N (200 per page).
No JS rendering needed — all data in JSON.
"""

import json
import re
import time
from datetime import datetime, timezone
from typing import Optional

import requests

BASE = "https://www.juliantile.com"
COLLECTION = "/floor-wall-tile"
PAGE_SIZE = 200
RATE_LIMIT = 1.0  # seconds between requests
SUPPLIER = "julian"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "application/json",
}

session = requests.Session()
session.headers.update(HEADERS)


def fetch_page(offset: int) -> list:
    url = f"{BASE}{COLLECTION}?format=json&offset={offset}"
    r = session.get(url, timeout=20)
    r.raise_for_status()
    return r.json().get("items", [])


def squarespace_img_url(asset_url: str, width: int = 800) -> str:
    """Append Squarespace format param for a reasonable resolution."""
    if not asset_url:
        return ""
    return f"{asset_url}?format={width}w"


def parse_dimensions_from_attrs(attrs: dict) -> list[str]:
    dims = []
    for v in attrs.values():
        # Match patterns like "24 x 24", "3x6", "12x24"
        m = re.match(r'^(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)', str(v).strip())
        if m:
            w, h = m.group(1), m.group(2)
            wf, hf = float(w), float(h)
            ws = str(int(wf)) if wf == int(wf) else w
            hs = str(int(hf)) if hf == int(hf) else h
            dims.append(f"{ws}x{hs}")
    return dims


def parse_item(item: dict) -> Optional[dict]:
    title = (item.get("title") or "").strip()
    if not title:
        return None

    url_id = item.get("urlId", "")
    full_url = f"{BASE}{item.get('fullUrl', f'/floor-wall-tile/p/{url_id}')}"

    # Primary image
    thumbnail_url = squarespace_img_url(item.get("assetUrl", ""))

    # Additional images from sub-items
    images = []
    if thumbnail_url:
        images.append({"url": thumbnail_url, "label": title})
    for si in item.get("items", []):
        au = si.get("assetUrl", "")
        if au:
            img_url = squarespace_img_url(au)
            if img_url not in [i["url"] for i in images]:
                images.append({"url": img_url, "label": title})

    # Variants
    raw_variants = item.get("variants", [])
    variants = []
    prices = []
    dimensions = []
    colours = []
    finishes = []

    for v in raw_variants:
        sku = v.get("sku", "")
        price_money = v.get("priceMoney", {})
        try:
            price = float(price_money.get("value", 0)) if price_money else 0.0
        except (ValueError, TypeError):
            price = 0.0

        attrs = v.get("attributes", {})
        dims = parse_dimensions_from_attrs(attrs)
        if dims:
            dimensions.extend(dims)

        # Colour/finish from attributes
        colour = attrs.get("Color") or attrs.get("Colour") or attrs.get("color") or ""
        finish = attrs.get("Finish") or attrs.get("finish") or ""
        shape = attrs.get("shapes") or attrs.get("Shapes") or ""
        size = attrs.get("Sizes") or attrs.get("sizes") or attrs.get("Size") or ""

        # Build variant name
        variant_parts = [p for p in [colour, finish, shape, size] if p]
        variant_name = f"{title} - {', '.join(variant_parts)}" if variant_parts else title

        if colour and colour not in colours:
            colours.append(colour)
        if finish and finish not in finishes:
            finishes.append(finish)

        if price > 0:
            prices.append(price)

        variants.append({
            "sku": sku,
            "name": variant_name,
            "price_cad": price if price > 0 else None,
            "colour": colour or None,
            "finish": finish or None,
            "dimension": dims[0] if dims else (size or None),
            "stock_status": "IN_STOCK",
            "images": [],
        })

    # Deduplicate dimensions
    dimensions = list(dict.fromkeys(dimensions))

    # Price range
    price_min = min(prices) if prices else None
    price_max = max(prices) if prices else None

    # SKU — use first variant SKU, or derive from tags
    sku = ""
    if variants:
        sku = variants[0]["sku"]
    if not sku:
        # Look for SKU-like tag (all caps + digits)
        for tag in item.get("tags", []):
            if re.match(r'^[A-Z]{2,}[A-Z0-9\-]{2,}$', tag):
                sku = tag
                break
    if not sku:
        sku = url_id.upper().replace("-", "")[:20]

    # Tags → category + colour hints
    tags = item.get("tags", [])
    category_names = []

    # Description from body
    body = item.get("body") or ""
    # Strip HTML
    description = re.sub(r'<[^>]+>', ' ', body).strip() if body else ""

    return {
        "supplier": SUPPLIER,
        "source_url": full_url,
        "sku": sku,
        "name": title,
        "url_key": url_id,
        "description_html": body or "",
        "short_description": description[:300] if description else "",
        "price_cad_min": price_min,
        "price_cad_max": price_max,
        "currency": "CAD",
        "thumbnail_url": thumbnail_url,
        "images": images,
        "colours": colours,
        "finishes": finishes,
        "dimensions": dimensions,
        "category_names": category_names,
        "configurable_options": {},
        "variants": variants,
        "variant_count": len(variants),
        "scraped_at": datetime.now(timezone.utc).isoformat(),
    }


def main():
    print("=== Julian Tile scraper ===\n")

    all_items = []
    offset = 0
    while True:
        print(f"  Fetching offset={offset}...", end=" ", flush=True)
        items = fetch_page(offset)
        print(f"{len(items)} items")
        if not items:
            break
        all_items.extend(items)
        if len(items) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
        time.sleep(RATE_LIMIT)

    print(f"\nTotal raw items: {len(all_items)}")

    products = []
    errors = 0
    for item in all_items:
        try:
            p = parse_item(item)
            if p:
                products.append(p)
        except Exception as e:
            errors += 1
            print(f"  ERROR parsing {item.get('urlId','?')}: {e}")

    # Save
    out = "/Users/grahamdobson/Documents/GitHub/interior-app/julian_products.json"
    with open(out, "w") as f:
        json.dump(products, f, indent=2)

    with_images = sum(1 for p in products if p["images"])
    with_price = sum(1 for p in products if p["price_cad_min"])
    with_variants = sum(1 for p in products if p["variants"])

    print(f"\n=== Done! {len(products)} products saved to julian_products.json ===")
    print(f"  With images  : {with_images}/{len(products)}")
    print(f"  With price   : {with_price}/{len(products)}")
    print(f"  With variants: {with_variants}/{len(products)}")
    print(f"  Errors       : {errors}")


if __name__ == "__main__":
    main()
