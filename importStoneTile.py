#!/usr/bin/env python3
"""
Import Stone Tile products from stoneTileProducts.json into Supabase.

JSON format: one entry per variant (SimpleProduct) with embedded parent data.
  entry.sku / name / url_key / price_cad / colour / finish / dimension / attributes
  entry.parent.sku / name / url_key / price_cad_min / price_cad_max / thumbnail_url
               / media_gallery / categories / configurable_options / variant_count

Import strategy:
  1. Upsert products (deduplicated by parent url_key) → get back id map
  2. DELETE + INSERT variants scoped to these product IDs
  3. DELETE + INSERT product_images scoped to these product IDs
"""

import asyncio
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

SUPABASE_URL = "https://dnghimclwgjmtnesxdmo.supabase.co"
SUPABASE_KEY = os.environ['SUPABASE_SERVICE_KEY']

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}
UPSERT_RETURN = {**HEADERS, "Prefer": "resolution=merge-duplicates,return=representation"}
INSERT_MIN    = {**HEADERS, "Prefer": "return=minimal"}

INPUT      = Path(__file__).parent / "stoneTileProducts.json"
SUPPLIER   = "stone_tile"
SOURCE_BASE = "https://stone-tile.com/CA_EN/{url_key}.html"
BATCH      = 50


def now_iso():
    return datetime.now(timezone.utc).isoformat()

def _str(v):
    """Return stripped string if v is a non-empty string, else None."""
    if isinstance(v, str):
        return v.strip() or None
    return None


# ── Build rows ────────────────────────────────────────────────────────────────

def build_product_row(parent: dict) -> dict:
    opts = parent.get("configurable_options") or []
    opts_json = {}
    for o in opts:
        values_map = {}
        for v in o.get("values", []):
            sw = v.get("swatch_data") or {}
            values_map[str(v["value_index"])] = {
                "label": v["label"],
                "swatch": sw.get("value"),
            }
        opts_json[o["attribute_code"]] = {"label": o["label"], "values": values_map}

    def opt_labels(code):
        for o in opts:
            if o.get("attribute_code") == code:
                return sorted({v["label"] for v in o.get("values", [])})
        return []

    return {
        "supplier_id":        SUPPLIER,
        "external_id":        parent["sku"],
        "sku":                parent["sku"],
        "name":               parent["name"],
        "url_key":            parent["url_key"],
        "source_url":         SOURCE_BASE.format(url_key=parent["url_key"]),
        "type":               parent.get("type") or parent.get("__typename", "ConfigurableProduct"),
        "description_html":   (_str(parent.get("description_html")) or _str((parent.get("description") or {}).get("html"))) or None,
        "short_description":  (_str(parent.get("short_description")) or _str((parent.get("short_description") or {}).get("html"))) or None,
        "meta_title":         parent.get("meta_title"),
        "meta_description":   parent.get("meta_description"),
        "price_cad_min":      parent.get("price_cad_min") or parent.get("price_range", {}).get("minimum_price", {}).get("final_price", {}).get("value"),
        "price_cad_max":      parent.get("price_cad_max") or parent.get("price_range", {}).get("maximum_price", {}).get("final_price", {}).get("value"),
        "currency":           "CAD",
        "thumbnail_url":      parent.get("thumbnail_url") or (parent.get("thumbnail") or {}).get("url"),
        "colours":            opt_labels("supplier_color"),
        "finishes":           opt_labels("supplier_finish"),
        "dimensions":         opt_labels("dimensions"),
        "category_names":     [c["name"] for c in (parent.get("categories") or [])],
        "configurable_options": opts_json,
        "variant_count":      parent.get("variant_count") or len(parent.get("variants") or []),
        "scraped_at":         now_iso(),
    }


def build_variant_row(entry: dict, product_id: int) -> dict:
    attrs_json = {}
    for a in (entry.get("attributes") or []):
        attrs_json[a["code"]] = {
            "code": a["code"],
            "label": a.get("label"),
            "value_index": a.get("value_index"),
            "value_label": a.get("label"),
            "swatch": None,
        }
    return {
        "product_id":         product_id,
        "supplier_id":        SUPPLIER,
        "sku":                entry["sku"],
        "name":               entry["name"],
        "url_key":            entry["url_key"],
        "stock_status":       entry.get("stock_status", "IN_STOCK"),
        "price_cad":          entry.get("price_cad"),
        "regular_price_cad":  entry.get("price_cad"),
        "colour":             entry.get("colour"),
        "finish":             entry.get("finish"),
        "dimension":          entry.get("dimension"),
        "length":             None,
        "attributes":         attrs_json,
        "images":             [],
    }


def build_image_rows(parent: dict, product_id: int) -> list:
    thumb = parent.get("thumbnail_url") or (parent.get("thumbnail") or {}).get("url")
    rows = []
    for img in (parent.get("media_gallery") or []):
        if img.get("disabled"):
            continue
        rows.append({
            "product_id": product_id,
            "url":        img["url"],
            "label":      img.get("label") or parent["name"],
            "position":   img.get("position", 0),
            "is_primary": img["url"] == thumb,
            "analyzed":   False,
        })
    return rows


# ── Supabase helpers ──────────────────────────────────────────────────────────

async def upsert_products(client, rows):
    """Upsert and return list of {id, url_key}."""
    results = []
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i+BATCH]
        r = await client.post(
            f"{SUPABASE_URL}/rest/v1/products",
            headers=UPSERT_RETURN,
            params={"on_conflict": "supplier_id,url_key", "select": "id,url_key"},
            json=chunk,
        )
        if r.status_code not in (200, 201):
            raise RuntimeError(f"products upsert {r.status_code}: {r.text[:300]}")
        results.extend(r.json())
        print(f"  products: {min(i+BATCH, len(rows))}/{len(rows)}")
    return results


async def delete_scoped(client, table, product_ids):
    for i in range(0, len(product_ids), 200):
        chunk = product_ids[i:i+200]
        id_filter = "(" + ",".join(str(x) for x in chunk) + ")"
        r = await client.delete(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=HEADERS,
            params={"product_id": f"in.{id_filter}"},
        )
        if r.status_code not in (200, 204):
            print(f"  WARN delete {table} {r.status_code}: {r.text[:200]}")


async def insert_batch(client, table, rows):
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i+BATCH]
        r = await client.post(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=INSERT_MIN,
            json=chunk,
        )
        if r.status_code not in (200, 201):
            raise RuntimeError(f"{table} insert {r.status_code}: {r.text[:300]}")
        if (i // BATCH) % 20 == 0 or i + BATCH >= len(rows):
            print(f"  {table}: {min(i+BATCH, len(rows))}/{len(rows)}")


async def count_table(client, table):
    r = await client.get(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers={**HEADERS, "Prefer": "count=exact"},
        params={"select": "id", "limit": 1},
    )
    return r.headers.get("content-range", "?/?").split("/")[-1]


# ── Main ──────────────────────────────────────────────────────────────────────

async def main():
    print(f"Reading {INPUT}...")
    raw = json.loads(INPUT.read_text())
    print(f"Loaded {len(raw)} entries from JSON")

    # Support both JSON formats:
    #   new: list of ConfigurableProducts directly (each entry IS the product)
    #   old: list of variant entries with entry["parent"] = product data
    if raw and "parent" in raw[0]:
        # Old variant-per-entry format
        parents_seen = {}
        for e in raw:
            p = e["parent"]
            if p["url_key"] not in parents_seen:
                parents_seen[p["url_key"]] = p
        products_data = list(parents_seen.values())
        entries = raw  # variants come from entries
        variant_format = "old"
    else:
        # New format: each entry is a ConfigurableProduct
        products_data = raw
        entries = None
        variant_format = "new"

    parent_rows = [build_product_row(p) for p in products_data]
    print(f"Products to upsert: {len(parent_rows)}\n")

    start = time.monotonic()

    async with httpx.AsyncClient(timeout=60.0) as client:

        # Step 1: Upsert products
        print("Step 1/3: Upserting products...")
        returned = await upsert_products(client, parent_rows)
        url_key_to_id = {row["url_key"]: row["id"] for row in returned}
        print(f"  → {len(url_key_to_id)} product IDs mapped\n")

        product_ids = list(url_key_to_id.values())

        # Step 2: Replace variants
        print("Step 2/3: Replacing variants...")
        await delete_scoped(client, "variants", product_ids)
        variant_rows = []
        if variant_format == "old":
            # Old format: entries are variant rows with entry["parent"]["url_key"]
            for e in entries:
                pid = url_key_to_id.get(e["parent"]["url_key"])
                if pid:
                    variant_rows.append(build_variant_row(e, pid))
        else:
            # New format: each product has a "variants" array with nested variant data
            for product in products_data:
                pid = url_key_to_id.get(product["url_key"])
                if not pid:
                    continue
                for v in (product.get("variants") or []):
                    vp = v["product"]
                    attrs = v.get("attributes") or []
                    def attr_val(code):
                        for a in attrs:
                            if a["code"] == code:
                                return a["label"]
                        return None
                    attrs_json = {a["code"]: {"code": a["code"], "label": a.get("label"), "value_index": a.get("value_index"), "value_label": a.get("label"), "swatch": None} for a in attrs}
                    variant_rows.append({
                        "product_id":        pid,
                        "supplier_id":       SUPPLIER,
                        "sku":               vp["sku"],
                        "name":              vp["name"],
                        "url_key":           vp["url_key"],
                        "stock_status":      vp.get("stock_status", "IN_STOCK"),
                        "price_cad":         vp.get("price_range", {}).get("minimum_price", {}).get("final_price", {}).get("value"),
                        "regular_price_cad": vp.get("price_range", {}).get("minimum_price", {}).get("final_price", {}).get("value"),
                        "colour":            attr_val("supplier_color"),
                        "finish":            attr_val("supplier_finish"),
                        "dimension":         attr_val("dimensions"),
                        "length":            None,
                        "attributes":        attrs_json,
                        "images":            [],
                    })
        await insert_batch(client, "variants", variant_rows)
        print(f"  → {len(variant_rows)} variants inserted\n")

        # Step 3: Replace product_images
        print("Step 3/3: Replacing product_images...")
        await delete_scoped(client, "product_images", product_ids)
        image_rows = []
        for product in products_data:
            pid = url_key_to_id.get(product["url_key"])
            if pid:
                image_rows.extend(build_image_rows(product, pid))
        await insert_batch(client, "product_images", image_rows)
        print(f"  → {len(image_rows)} images inserted\n")

        # Final counts
        pc = await count_table(client, "products")
        vc = await count_table(client, "variants")
        ic = await count_table(client, "product_images")

    elapsed = time.monotonic() - start
    print("=" * 50)
    print(f"Done in {elapsed:.1f}s")
    print(f"  products:       {pc}")
    print(f"  variants:       {vc}")
    print(f"  product_images: {ic}")


if __name__ == "__main__":
    asyncio.run(main())
