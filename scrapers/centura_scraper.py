"""
Centura tile scraper — uses Drupal JSON API
Strategy:
  Pass 1: Fetch all products + variations (paginated, no image include)
  Pass 2: Batch-fetch all media IDs collected in pass 1
  Pass 3: Assemble final product JSON
Output: centura_products.json
"""

import requests
import json
import time
from datetime import datetime, timezone
from urllib.parse import urlencode

BASE_URL = "https://www.centura.ca"
API_BASE = f"{BASE_URL}/en/jsonapi/commerce_product/tile"
MEDIA_BASE = f"{BASE_URL}/en/jsonapi/media/image"
PAGE_SIZE = 50
MEDIA_BATCH = 20
RATE_LIMIT = 1.2

session = requests.Session()
session.headers.update({
    "Accept": "application/vnd.api+json",
    "User-Agent": "Mozilla/5.0 (compatible; tile-catalog-scraper/1.0)",
})


def get(url: str, params: dict = {}, retries: int = 3) -> dict:
    for attempt in range(retries):
        try:
            r = session.get(url, params=params, timeout=45)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            if attempt == retries - 1:
                raise
            wait = (attempt + 1) * 3
            print(f"    Retry {attempt+1} after {wait}s ({e})")
            time.sleep(wait)


def fetch_all_products() -> tuple[list, dict]:
    """Pass 1: fetch all products and variations. Returns (products, variations_map)."""
    all_items = []
    variations_map = {}
    offset = 0
    page = 0

    while True:
        print(f"  Page {page + 1} (offset {offset})...")
        data = get(API_BASE, {
            "page[limit]": PAGE_SIZE,
            "page[offset]": offset,
        })

        items = data.get("data", [])
        if not items:
            break

        all_items.extend(items)

        # Collect variation IDs for batch fetch
        for item in items:
            for vref in item.get("relationships", {}).get("variations", {}).get("data", []):
                if isinstance(vref, dict) and vref.get("id"):
                    variations_map[vref["id"]] = None  # placeholder

        if "next" not in data.get("links", {}):
            break

        offset += PAGE_SIZE
        page += 1
        time.sleep(RATE_LIMIT)

    print(f"  → {len(all_items)} products, {len(variations_map)} variation IDs collected")
    return all_items, list(variations_map.keys())


def fetch_all_variations(variation_ids: list) -> dict:
    """Batch-fetch all variation data by ID. Returns {variation_id: variation_item}."""
    VAR_BASE = f"{BASE_URL}/en/jsonapi/commerce_product_variation/tile"
    result = {}
    ids = [vid for vid in variation_ids if vid]
    print(f"\nFetching {len(ids)} variations in batches of {MEDIA_BATCH}...")
    for i in range(0, len(ids), MEDIA_BATCH):
        batch = ids[i:i + MEDIA_BATCH]
        params = {}
        for j, vid in enumerate(batch):
            params[f"filter[id][value][{j}]"] = vid
        params["filter[id][operator]"] = "IN"
        try:
            data = get(VAR_BASE, params)
            for item in data.get("data", []):
                result[item["id"]] = item
        except Exception as e:
            print(f"    Variation batch {i//MEDIA_BATCH + 1} failed: {e}")
        if i % (MEDIA_BATCH * 5) == 0:
            print(f"  Batch {i//MEDIA_BATCH + 1}/{(len(ids)-1)//MEDIA_BATCH + 1} ({len(result)} resolved)")
        time.sleep(RATE_LIMIT)
    print(f"  → {len(result)} variations fetched")
    return result


def collect_media_ids(items: list) -> dict:
    """Build map of media_id → product_id from all product relationships."""
    media_to_product = {}
    product_to_media = {}
    for item in items:
        pid = item["id"]
        rels = item.get("relationships", {})
        ill_data = rels.get("field_illustrations", {}).get("data", [])
        if isinstance(ill_data, dict):
            ill_data = [ill_data]
        media_ids = [d["id"] for d in ill_data if d.get("id")]
        product_to_media[pid] = media_ids
        for mid in media_ids:
            media_to_product[mid] = pid
    return product_to_media, media_to_product


def fetch_all_media(media_ids: list) -> dict:
    """Pass 2: batch-fetch all media → file URL map. Returns {media_id: image_url}."""
    media_url_map = {}
    ids = list(set(media_ids))
    print(f"\nFetching {len(ids)} media items in batches of {MEDIA_BATCH}...")

    for i in range(0, len(ids), MEDIA_BATCH):
        batch = ids[i:i + MEDIA_BATCH]
        # Build filter[id][value][0..N]=uuid&filter[id][operator]=IN
        params = {"include": "field_media_image"}
        for j, mid in enumerate(batch):
            params[f"filter[id][value][{j}]"] = mid
        params["filter[id][operator]"] = "IN"

        try:
            data = get(MEDIA_BASE, params)
            # Build file lookup
            file_map = {}
            for inc in data.get("included", []):
                if inc.get("type") == "file--file":
                    uri = inc.get("attributes", {}).get("uri", {}).get("url", "")
                    fname = inc.get("attributes", {}).get("filename", "")
                    file_map[inc["id"]] = {
                        "url": BASE_URL + uri if uri.startswith("/") else uri,
                        "label": fname,
                    }
            # Map media_id → image file
            for media_item in data.get("data", []):
                mid = media_item["id"]
                file_ref = media_item.get("relationships", {}).get("field_media_image", {}).get("data", {})
                fid = file_ref.get("id") if file_ref else None
                if fid and fid in file_map:
                    media_url_map[mid] = file_map[fid]
        except Exception as e:
            print(f"    Media batch {i//MEDIA_BATCH + 1} failed: {e}")

        print(f"  Batch {i//MEDIA_BATCH + 1}/{(len(ids)-1)//MEDIA_BATCH + 1} done ({len(media_url_map)} resolved)")
        time.sleep(RATE_LIMIT)

    return media_url_map


def parse_product(item: dict, variations_map: dict, product_to_media: dict, media_url_map: dict) -> dict:
    attrs = item.get("attributes", {})
    rels = item.get("relationships", {})

    title = attrs.get("title", "")
    path_alias = attrs.get("path", {}).get("alias", "")
    url_key = path_alias.lstrip("/").split("/")[-1] if path_alias else ""
    source_url = BASE_URL + "/en" + path_alias if path_alias else ""

    # Description from metatags
    description = ""
    for tag in attrs.get("metatag", []):
        if tag.get("attributes", {}).get("name") == "description":
            description = tag["attributes"].get("content", "")
            break

    # Images
    media_ids = product_to_media.get(item["id"], [])
    images = [media_url_map[mid] for mid in media_ids if mid in media_url_map]
    thumbnail_url = images[0]["url"] if images else ""

    # Variations
    variants = []
    dimensions = set()
    prices = []

    variation_refs = rels.get("variations", {}).get("data", [])
    if isinstance(variation_refs, dict):
        variation_refs = [variation_refs]

    for vref in variation_refs:
        v = variations_map.get(vref.get("id"))
        if not v:
            continue
        va = v.get("attributes", {})

        sku = va.get("sku", "")
        vtitle = va.get("field_p21_item_desc_en") or va.get("title") or sku

        # Vancouver retail price
        price_van = va.get("field_p21_retail_van")
        price_num = None
        try:
            if isinstance(price_van, dict):
                n = float(price_van.get("number", 0) or 0)
            elif price_van is not None:
                n = float(price_van)
            else:
                n = 0
            if n > 0:
                price_num = n
                prices.append(price_num)
        except (ValueError, TypeError):
            pass

        # Dimensions
        length = va.get("field_nominal_length")
        width = va.get("field_nominal_width")
        dim_str = f"{length}x{width}" if length and width else ""
        if dim_str:
            dimensions.add(dim_str)

        stock = "IN_STOCK" if va.get("field_visibility_van") else "OUT_OF_STOCK"

        variants.append({
            "sku": sku,
            "name": vtitle,
            "price_cad": price_num,
            "dimension": dim_str,
            "stock_status": stock,
            "images": [],
        })

    # Category from path
    path_parts = path_alias.strip("/").split("/")
    category_names = []
    if len(path_parts) >= 3:
        category_names.append(path_parts[2].replace("-", " ").title())

    price_min = min(prices) if prices else None
    price_max = max(prices) if prices else None

    return {
        "supplier": "centura",
        "source_url": source_url,
        "sku": url_key.upper(),
        "name": title,
        "url_key": url_key,
        "description_html": f"<p>{description}</p>" if description else "",
        "short_description": description,
        "price_cad_min": price_min,
        "price_cad_max": price_max,
        "currency": "CAD",
        "thumbnail_url": thumbnail_url,
        "images": images,
        "colours": [],
        "finishes": [],
        "dimensions": list(dimensions),
        "category_names": category_names,
        "configurable_options": {},
        "variants": variants,
        "variant_count": len(variants),
        "scraped_at": datetime.now(timezone.utc).isoformat(),
    }


def main():
    print("=== Centura scraper ===\n")

    # Pass 1: products (no includes)
    print("Pass 1: Fetching products...")
    items, variation_ids = fetch_all_products()

    # Pass 2: fetch variations
    print("\nPass 2: Fetching variations...")
    variations_map = fetch_all_variations(variation_ids)

    # Pass 3: media
    # Collect all media IDs
    product_to_media, media_to_product = collect_media_ids(items)
    all_media_ids = list(media_to_product.keys())
    print(f"  Found {len(all_media_ids)} media references across {len(items)} products")

    media_url_map = fetch_all_media(all_media_ids)

    # Pass 4: assemble
    print("\nAssembling products...")
    all_products = []
    for item in items:
        product = parse_product(item, variations_map, product_to_media, media_url_map)
        if product["url_key"]:
            all_products.append(product)

    out_path = "centura_products.json"
    with open(out_path, "w") as f:
        json.dump(all_products, f, indent=2)

    print(f"\n=== Done! {len(all_products)} products saved to {out_path} ===")
    with_images = sum(1 for p in all_products if p["images"])
    with_price = sum(1 for p in all_products if p["price_cad_min"])
    with_variants = sum(1 for p in all_products if p["variants"])
    print(f"  With images:   {with_images}/{len(all_products)}")
    print(f"  With price:    {with_price}/{len(all_products)}")
    print(f"  With variants: {with_variants}/{len(all_products)}")


if __name__ == "__main__":
    main()
