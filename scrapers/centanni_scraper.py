#!/usr/bin/env python3
"""
Centanni Tile scraper — Wix CMS (centannitile.com)
Data is in wix-warmup-data script tag as SSR component props.
No JS rendering needed.

Sources:
  /master-colorways/  — 175 URLs (main catalog)
  /last-call/         — 38 URLs (discounted tiles)
"""

import json
import re
import time
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import unquote

import requests
from bs4 import BeautifulSoup

BASE = "https://www.centannitile.com"
RATE_LIMIT = 1.2
SUPPLIER = "centanni"

SITEMAPS = [
    f"{BASE}/dynamic-master-colorways_p_7383a64c_bee9_4847_bb98_57eb18fd3dfa_0_5000-sitemap.xml",
    f"{BASE}/dynamic-last-call_p_c7b5fdfb_eafc_4f9e_a305_d820986691d2_0_5000-sitemap.xml",
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

session = requests.Session()
session.headers.update(HEADERS)


def wix_image_url(uri: str, width: int = 800) -> str:
    """Convert a Wix image URI to a public CDN URL."""
    if not uri:
        return ""
    uri = uri.strip()
    # Handle wix:image://v1/{uri}/... format
    if uri.startswith("wix:image://"):
        m = re.match(r"wix:image://v1/([^/]+)", uri)
        if m:
            uri = m.group(1)
    return f"https://static.wixstatic.com/media/{uri}/v1/fit/w_{width},h_{width}/{uri}"


def html_text(html: str) -> str:
    """Strip HTML tags and decode entities."""
    if not html:
        return ""
    return BeautifulSoup(html, "html.parser").get_text(" ", strip=True)


def parse_dimensions(text: str) -> list:
    """Extract dimension strings like '12x24' from text like '12" x 24" | 24" x 24"'."""
    dims = []
    for m in re.finditer(r'(\d+(?:\.\d+)?)\s*["”″]?\s*[xX×]\s*(\d+(?:\.\d+)?)', text):
        w, h = float(m.group(1)), float(m.group(2))
        ws = str(int(w)) if w == int(w) else str(w)
        hs = str(int(h)) if h == int(h) else str(h)
        dims.append(f"{ws}x{hs}")
    return list(dict.fromkeys(dims))


def extract_price(text: str) -> Optional[float]:
    """Extract a CAD price from text like '$4.00' or '$12.00'."""
    m = re.search(r"\$\s*([\d,]+(?:\.\d{2})?)", text.replace(",", ""))
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass
    return None


def get_warmup_components(html: str) -> dict:
    """Extract merged component props from wix-warmup-data."""
    m = re.search(r'id="wix-warmup-data"[^>]*>(.*?)</script>', html, re.DOTALL)
    if not m:
        return {}
    try:
        d = json.loads(m.group(1))
    except (json.JSONDecodeError, ValueError):
        return {}
    updates = d.get("platform", {}).get("ssrPropsUpdates", [])
    merged = {}
    for u in updates:
        merged.update(u)
    return merged


def get_gallery_images(comp: dict) -> list:
    """Extract image URIs from a gallery component's items list."""
    images = []
    for item in comp.get("items", []):
        img = item.get("image", {})
        uri = img.get("uri") or item.get("uri", "")
        if uri:
            images.append(wix_image_url(uri))
    return images


def parse_page(url: str, html: str) -> Optional[dict]:
    comps = get_warmup_components(html)
    if not comps:
        return None

    slug = url.rstrip("/").split("/")[-1]
    url_key = unquote(slug).lower()

    # Separate html components from image/gallery components
    html_comps = []
    img_comps = []
    gallery_comps = []

    for k, v in comps.items():
        if isinstance(v, dict):
            if "html" in v:
                text = html_text(v["html"])
                if text and text != "​":  # skip zero-width space placeholders
                    html_comps.append((k, text))
            elif "uri" in v and v["uri"]:
                img_comps.append((k, v))
            elif "items" in v:
                gallery_comps.append((k, v))

    if not html_comps:
        return None

    # Identify fields by heuristics:
    # - Largest text = collection name (long, title-case)
    # - Second = colorway/product name
    # - Dimensions pattern
    # - Price pattern ($X.XX)
    # Sort html components by component ID to get consistent ordering
    html_comps.sort(key=lambda x: x[0])

    collection_name = ""
    product_name = ""
    dimensions = []
    prices = []
    description_parts = []
    finishes = []
    colours = []

    for k, text in html_comps:
        # Dimension string
        if re.search(r'\d+\s*["”]?\s*[xX×]\s*\d+', text):
            dims = parse_dimensions(text)
            if dims:
                dimensions.extend(dims)
                continue
        # Price
        if text.startswith("$") and re.match(r'^\$[\d,.]+$', text.strip()):
            p = extract_price(text)
            if p is not None:
                prices.append(p)
            continue
        # Percentage discount
        if re.match(r'^-?\d+%$', text.strip()):
            continue
        # Pure number (sqft or other)
        if re.match(r'^\d+(\.\d+)?$', text.strip()):
            continue
        # Finish/material single words
        if text.lower() in ("natural", "polished", "honed", "matte", "satin",
                            "textured", "lappato", "silk", "glossy", "gloss",
                            "brushed", "structured"):
            finishes.append(text)
            continue
        # Collection name — explicitly contains "Collection"
        if "collection" in text.lower():
            collection_name = text
            continue
        # Product name — first remaining substantive text
        if not product_name and len(text) < 80:
            product_name = text
            continue
        description_parts.append(text)

    if not product_name and collection_name:
        product_name = collection_name
        collection_name = ""

    # Dimensions dedup
    dimensions = list(dict.fromkeys(dimensions))

    # Price range
    price_min = min(prices) if prices else None
    price_max = max(prices) if prices else None

    # Images: primary + gallery
    images = []
    # Image components sorted — first is typically primary product shot
    for k, v in sorted(img_comps, key=lambda x: x[0]):
        img_url = wix_image_url(v.get("uri", ""))
        if img_url:
            label = v.get("alt") or v.get("title") or product_name
            images.append({"url": img_url, "label": label})

    # Gallery images
    for k, v in gallery_comps:
        for img_url in get_gallery_images(v):
            if img_url not in [i["url"] for i in images]:
                images.append({"url": img_url, "label": product_name})

    if not images:
        return None

    thumbnail_url = images[0]["url"] if images else ""

    # SKU from url_key
    sku = re.sub(r'[^a-zA-Z0-9]', '', url_key).upper()[:20]

    # Build variants from dimensions × prices
    variants = []
    dim_list = dimensions if dimensions else [None]
    price_list = prices if prices else [None]
    for dim in dim_list:
        p = price_list[0] if price_list else None
        variants.append({
            "sku": f"{sku}-{dim.replace('x', 'X')}" if dim else sku,
            "name": f"{product_name} - {dim}" if dim else product_name,
            "price_cad": p,
            "colour": None,
            "finish": finishes[0] if finishes else None,
            "dimension": dim,
            "stock_status": "IN_STOCK",
            "images": [],
        })

    description = " | ".join(description_parts) if description_parts else ""

    return {
        "supplier": SUPPLIER,
        "source_url": url,
        "sku": sku,
        "name": product_name or url_key,
        "url_key": url_key,
        "description_html": "",
        "short_description": description[:300],
        "price_cad_min": price_min,
        "price_cad_max": price_max,
        "currency": "CAD",
        "thumbnail_url": thumbnail_url,
        "images": images,
        "colours": colours,
        "finishes": finishes,
        "dimensions": dimensions,
        "category_names": [collection_name] if collection_name else [],
        "configurable_options": {},
        "variants": variants,
        "variant_count": len(variants),
        "scraped_at": datetime.now(timezone.utc).isoformat(),
    }


def get_all_urls() -> list:
    urls = []
    for sm_url in SITEMAPS:
        r = session.get(sm_url, timeout=15)
        r.raise_for_status()
        found = re.findall(r"<loc>(https://www\.centannitile\.com[^<]+)</loc>", r.text)
        urls.extend(found)
        time.sleep(RATE_LIMIT)
    return urls


def main():
    print("=== Centanni Tile scraper ===\n")

    urls = get_all_urls()
    print(f"Found {len(urls)} product URLs\n")

    products = []
    errors = 0
    skipped = 0

    for i, url in enumerate(urls, 1):
        try:
            r = session.get(url, timeout=15)
            if r.status_code == 404:
                skipped += 1
                continue
            r.raise_for_status()
            p = parse_page(url, r.text)
            if p:
                products.append(p)
            else:
                skipped += 1
        except Exception as e:
            errors += 1
            print(f"  ERROR [{i}/{len(urls)}] {url}: {e}")

        if i % 25 == 0:
            print(f"  [{i}/{len(urls)}] {len(products)} ok, {errors} errors, {skipped} skipped")

        time.sleep(RATE_LIMIT)

    out = "/Users/grahamdobson/Documents/GitHub/interior-app/centanni_products.json"
    with open(out, "w") as f:
        json.dump(products, f, indent=2)

    with_images = sum(1 for p in products if p["images"])
    with_price = sum(1 for p in products if p["price_cad_min"])
    with_dims = sum(1 for p in products if p["dimensions"])

    print(f"\n=== Done! {len(products)} products saved to centanni_products.json ===")
    print(f"  With images     : {with_images}/{len(products)}")
    print(f"  With price      : {with_price}/{len(products)}")
    print(f"  With dimensions : {with_dims}/{len(products)}")
    print(f"  Errors          : {errors}")
    print(f"  Skipped (404)   : {skipped}")


if __name__ == "__main__":
    main()
