#!/usr/bin/env python3
"""
Ames Tile scraper — Magento server-rendered HTML.
Outputs: ~/Documents/GitHub/interior-app/ames_products.json
"""

import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

BASE   = "https://www.amestile.com"
OUTPUT = Path(__file__).parent.parent / "ames_products.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-CA,en;q=0.9",
}

SESSION = requests.Session()
SESSION.headers.update(HEADERS)

SCRAPED_AT = datetime.now(timezone.utc).isoformat()


# ── Listing pages ─────────────────────────────────────────────────────────────

def fetch_listing_page(page: int) -> list[str]:
    url = f"{BASE}/products" if page == 1 else f"{BASE}/products?p={page}"
    time.sleep(1)
    r = SESSION.get(url, timeout=20)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    links = []
    for a in soup.select("a.product-item-photo"):
        href = a.get("href", "")
        if href.startswith(BASE):
            links.append(href)
    return links


def collect_all_urls() -> list[str]:
    urls = []
    seen = set()
    page = 1
    while True:
        print(f"  Listing page {page}…", end=" ", flush=True)
        try:
            page_urls = fetch_listing_page(page)
        except Exception as e:
            print(f"ERROR: {e}")
            break
        new = [u for u in page_urls if u not in seen]
        seen.update(new)
        urls.extend(new)
        print(f"{len(page_urls)} products ({len(urls)} total)")
        if not page_urls:
            break
        page += 1
    return urls


# ── Product detail ────────────────────────────────────────────────────────────

def _text(soup, selector: str) -> str:
    el = soup.select_one(selector)
    return el.get_text(" ", strip=True) if el else ""


def _spec(soup, label: str) -> str:
    for th in soup.select("th"):
        if th.get_text(strip=True) == label:
            td = th.find_next_sibling("td")
            if td:
                return td.get_text(" ", strip=True)
    return ""


def _gallery_images(soup) -> list[dict]:
    """Extract full-res and thumb URLs from Magento fotorama gallery JSON."""
    script_text = " ".join(s.string or "" for s in soup.find_all("script"))
    m = re.search(r'"data"\s*:\s*(\[.*?\])\s*,\s*"options"', script_text, re.DOTALL)
    if not m:
        return []
    try:
        data = json.loads(m.group(1))
        return [{"url": item["full"], "label": item.get("caption", "")} for item in data]
    except Exception:
        return []


def _parse_dimension_from_name(name: str):
    """Extract dimension string like '24x48' from product name."""
    m = re.search(r'(\d+(?:\.\d+)?)["”]?\s*[xX×]\s*(\d+(?:\.\d+)?)["”]?', name)
    if m:
        return f'{m.group(1)}x{m.group(2)}'
    return None


def _parse_colors_from_colour_spec(colour: str) -> list[str]:
    """'Earth - 24"x 48" Matte' → ['Earth']"""
    if not colour:
        return []
    # Strip dimension and finish suffix
    colour_clean = re.sub(r'\s*-?\s*\d+["”]?\s*[xX×]\s*\d+.*', '', colour).strip()
    colour_clean = colour_clean.rstrip(" -")
    return [colour_clean] if colour_clean else []


def scrape_product(url: str):
    time.sleep(1)
    try:
        r = SESSION.get(url, timeout=20)
        r.raise_for_status()
    except Exception as e:
        print(f"    ✗ {url}: {e}", file=sys.stderr)
        return None

    soup = BeautifulSoup(r.text, "html.parser")

    # url_key = last path segment
    url_key = url.rstrip("/").split("/")[-1]
    sku     = url_key.upper()

    # Name
    name_el = soup.find(itemprop="name")
    name    = name_el.get_text(strip=True) if name_el else url_key

    # Price from og:meta
    price_el = soup.find("meta", property="product:price:amount")
    price    = float(price_el["content"]) if price_el and price_el.get("content") else None

    # Description
    desc_el     = soup.select_one(".product.attribute.description .value")
    description = desc_el.get_text(" ", strip=True) if desc_el else ""
    if description == sku:
        description = ""

    # Images
    images = _gallery_images(soup)
    # Fallback: og:image
    if not images:
        og_img = soup.find("meta", property="og:image")
        if og_img and og_img.get("content"):
            images = [{"url": og_img["content"], "label": name}]

    thumbnail_url = images[0]["url"] if images else None

    # Specs
    colour           = _spec(soup, "Colour")
    tile_finish      = _spec(soup, "Tile Finish")
    product_type     = _spec(soup, "Product Type")
    series_name      = _spec(soup, "Series Name")
    rec_application  = _spec(soup, "Recommended Application")
    tile_type        = _spec(soup, "Tile Type")
    tile_edge        = _spec(soup, "Tile Edge")
    thickness_mm     = _spec(soup, "Thickness (mm)")

    colours  = _parse_colors_from_colour_spec(colour)
    finishes = [tile_finish] if tile_finish else []
    dims_str = _parse_dimension_from_name(name)
    dims     = [dims_str] if dims_str else []

    # Category names from product_type + tile_type
    cat_parts   = [p for p in [product_type, tile_type] if p]
    cat_names   = cat_parts if cat_parts else ["Tile"]

    # Build a richer short description from key specs
    spec_bits = []
    if series_name: spec_bits.append(f"Series: {series_name}")
    if colour:      spec_bits.append(f"Colour: {colour}")
    if tile_finish: spec_bits.append(f"Finish: {tile_finish}")
    if rec_application: spec_bits.append(f"Use: {rec_application}")
    short_description = " | ".join(spec_bits)

    # Extra configurable options captured from specs
    configurable_options = {}
    for label in ("Tile Edge", "Thickness (mm)", "Variation Rating",
                  "Water Absorption", "PEI", "MOHS", "DCOF", "MR Rating"):
        val = _spec(soup, label)
        if val:
            configurable_options[label] = val

    # Single variant (each Ames page is one SKU)
    variants = []
    if price is not None:
        variants.append({
            "sku":          sku,
            "name":         name,
            "price_cad":    price,
            "colour":       colours[0] if colours else "",
            "finish":       tile_finish,
            "dimension":    dims_str or "",
            "stock_status": "IN_STOCK",
            "images":       [],
        })

    return {
        "supplier":             "ames",
        "source_url":           url,
        "sku":                  sku,
        "name":                 name,
        "url_key":              url_key,
        "description_html":     f"<p>{description}</p>" if description else "",
        "short_description":    short_description,
        "price_cad_min":        price,
        "price_cad_max":        price,
        "currency":             "CAD",
        "thumbnail_url":        thumbnail_url,
        "images":               images,
        "colours":              colours,
        "finishes":             finishes,
        "dimensions":           dims,
        "category_names":       cat_names,
        "configurable_options": configurable_options,
        "variants":             variants,
        "variant_count":        len(variants),
        "scraped_at":           SCRAPED_AT,
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("=== Ames Tile Scraper ===")
    print("Collecting product URLs from listing pages…")
    urls = collect_all_urls()
    print(f"\nFound {len(urls)} product URLs. Fetching detail pages…\n")

    products  = []
    errors    = 0
    done      = 0
    start     = time.time()

    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = {pool.submit(scrape_product, u): u for u in urls}
        for future in as_completed(futures):
            result = future.result()
            done += 1
            if result:
                products.append(result)
            else:
                errors += 1
            if done % 50 == 0 or done == len(urls):
                elapsed = time.time() - start
                rate    = done / elapsed
                print(f"  [{done}/{len(urls)}] {elapsed:.0f}s elapsed  {rate:.1f}/s  "
                      f"ok={len(products)}  err={errors}")

    OUTPUT.write_text(json.dumps(products, indent=2, ensure_ascii=False))
    elapsed = time.time() - start
    print(f"\nDone in {elapsed:.1f}s — {len(products)} products, {errors} errors")
    print(f"Saved to {OUTPUT}")


if __name__ == "__main__":
    main()
