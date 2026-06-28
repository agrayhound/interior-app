"""
Tierra Sol tile scraper — uses Wayback Machine snapshots (20250801)
because the live site is behind Cloudflare Managed Challenge.

Product URLs come from the live sitemap.xml.
Each product page is fetched via: http://web.archive.org/web/20250801/{url}

Image CDN: shnierflooring.ca/catalog/items/600x600/{SKU}.jpg
Output: tierra_sol_products.json
"""

import os
import requests
import json
import time
import re
from typing import Optional
from bs4 import BeautifulSoup
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv()

BASE_URL = "https://www.tierrasol.ca"
WAYBACK_PREFIX = ""  # not used — fetching live site with CF cookie
SITEMAP_URL = f"{BASE_URL}/sitemap.xml"
RATE_LIMIT = 1.5

CF_CLEARANCE = "JoaFV4ZNAuali_9RYKLFzyNW7bQZyQu39T1BBRLtHHQ-1782518466-1.2.1.1-og1.MCXo195URG6DS2WkM_WbO8v4TNRhzUB4ezNBMaY3bQj7uvlNqPcOj_Ewo6SEF3B5aIURVuQ4OqXElekNf56PthcLvAANPFTL2T.AL0oXviTZBVrHybkPSVn0j_5kYbUCSwypfznuV4XpTAyrtJMpnI38i6oFwiayCUVQEg.ACL1R9uEbU9G0qpupJKct.wRzdo.uTdRCK_x7_8H7FM931jG.NmtwA5GQe_U7xtKmB0l6QvHu01xua0.WyqWLJmaNfbgWnm4vFB6d8Fiadw3D6raD5xz5HMOLp0G7CEjsgGATA3vV8EDVtJ4ivj._IoY3m0rV1iQsWAfyM7Q8eg"
WAYBACK_STRIP = re.compile(r'https?://web\.archive\.org/web/\d+i?m?_?/')

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-CA,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
})
session.cookies.set("cf_clearance", CF_CLEARANCE, domain="www.tierrasol.ca")


URLS_CACHE = os.path.join(os.path.dirname(__file__), 'tierra_sol_urls.json')

def get_product_urls() -> list:
    if os.path.exists(URLS_CACHE):
        with open(URLS_CACHE) as f:
            urls = json.load(f)
        print(f'Loaded {len(urls)} URLs from cache')
        return urls
    r = session.get(SITEMAP_URL, timeout=30)
    r.raise_for_status()
    urls = re.findall(r'<loc>(https://www\.tierrasol\.ca/en/product/[^<]+)</loc>', r.text)
    with open(URLS_CACHE, 'w') as f:
        json.dump(urls, f)
    return urls


def fetch_page(url: str, retries: int = 3) -> Optional[str]:
    for attempt in range(retries):
        try:
            r = session.get(url, timeout=30)
            if r.status_code == 404:
                return None
            if r.status_code == 403 or 'Just a moment' in r.text[:500]:
                raise Exception("Cloudflare challenge — cookie may have expired")
            r.raise_for_status()
            r.encoding = r.apparent_encoding or 'utf-8'
            return r.text
        except Exception as e:
            if attempt == retries - 1:
                print(f"    FAIL {url}: {e}")
                return None
            wait = (attempt + 1) * 5
            print(f"    Retry {attempt+1}/{retries} after {wait}s")
            time.sleep(wait)


def clean_wayback(src: str) -> str:
    return WAYBACK_STRIP.sub('', src)


def parse_product(html: str, source_url: str) -> Optional[dict]:
    soup = BeautifulSoup(html, 'html.parser')

    title = soup.find('title')
    if not title:
        return None
    title_text = title.text.strip()
    # "Product - Icon Black 12x24 Non-rectified, Icon (TSCFGABIBL1224N) - Tierra Sol Ceramic Tile"
    # Extract name and line code
    m = re.match(r'Product - (.+?),\s*(.+?)\s*\((\w+)\)', title_text)
    if not m:
        return None
    product_name = m.group(1).strip()
    collection = m.group(2).strip()
    line_code = m.group(3).strip()

    # url_key from source URL
    url_key = source_url.rstrip('/').split('/')[-1]

    # ── Spec tables ──────────────────────────────────────────────────────────
    specs = {}
    quick_ref = {}

    for table_or_div in soup.find_all(['table', 'dl', 'div']):
        txt = table_or_div.get_text(' | ', strip=True)

        # Quick-ref block: Color, Material, LBS/CT, MSRP PRICE
        if 'MSRP PRICE' in txt and 'Color' in txt:
            pairs = [p.strip() for p in txt.split('|') if p.strip()]
            for i in range(0, len(pairs) - 1, 2):
                quick_ref[pairs[i].strip()] = pairs[i+1].strip()

        # Product details block: Product Sku, Collection, Size(s) etc.
        if 'Product Sku' in txt and 'Line Code' in txt:
            pairs = [p.strip() for p in txt.split('|') if p.strip()]
            for i in range(0, len(pairs) - 1, 2):
                specs[pairs[i].strip()] = pairs[i+1].strip()

    if not quick_ref and not specs:
        return None

    sku_raw = specs.get('Product Sku', line_code).strip()
    sku = f"TS{sku_raw}" if not sku_raw.startswith('TS') else sku_raw

    # Price
    price_str = quick_ref.get('MSRP PRICE', '')
    price_num = None
    price_m = re.search(r'\$([\d,.]+)', price_str)
    if price_m:
        try:
            price_num = float(price_m.group(1).replace(',', ''))
        except ValueError:
            pass

    # Colour
    colour = quick_ref.get('Color', '')
    colours = [colour] if colour else []

    # Material / Construction
    material = specs.get('Construction', '') or quick_ref.get('Material', '')

    # Dimensions — parse from title and Size(s) field
    raw_dims = []
    size_str = specs.get('Size(s)', '')
    for dm in re.findall(r'(\d+(?:\.\d+)?\s*[xX×]\s*\d+(?:\.\d+)?)', size_str + ' ' + product_name):
        dm_clean = re.sub(r'\s*[xX×]\s*', 'x', dm).replace(' ', '')
        raw_dims.append(dm_clean)
    # Also grab from title (e.g. "12x24")
    for dm in re.findall(r'\b(\d+(?:\.\d+)?)[xX×](\d+(?:\.\d+)?)\b', product_name):
        raw_dims.append(f"{dm[0]}x{dm[1]}")
    dimensions = list(dict.fromkeys(raw_dims))  # dedup preserving order

    # Application / categories
    application = specs.get('Application', '')
    category_names = []
    tile_type = specs.get('Type', '')
    if tile_type:
        category_names.append(tile_type.title())
    gloss = quick_ref.get('Gloss Level', '') or specs.get('Gloss Level', '')
    finishes = [f.strip().title() for f in gloss.split(',') if f.strip()] if gloss else []

    # Visual / pattern
    visual = specs.get('Visual', '')

    # Description
    desc_el = soup.find(class_=re.compile(r'description|product-desc', re.I))
    description = desc_el.get_text(strip=True) if desc_el else ''

    # ── Images ───────────────────────────────────────────────────────────────
    images = []
    seen_urls = set()

    for img in soup.find_all('img'):
        src = clean_wayback(img.get('src', '') or img.get('data-lazy', '') or '')
        if 'shnierflooring.ca/catalog/items/600x600' in src:
            src = src.split('?')[0]  # strip cache-buster
            if src not in seen_urls:
                seen_urls.add(src)
                label = img.get('alt', '').replace('ICON - ', '').replace('ICON ', '').strip()
                images.append({'url': src, 'label': label})

    thumbnail_url = images[0]['url'] if images else ''

    return {
        'supplier': 'tierra_sol',
        'source_url': source_url,
        'sku': sku,
        'name': product_name,
        'url_key': url_key,
        'description_html': f'<p>{description}</p>' if description else '',
        'short_description': description,
        'price_cad_min': price_num,
        'price_cad_max': price_num,
        'currency': 'CAD',
        'thumbnail_url': thumbnail_url,
        'images': images,
        'colours': colours,
        'finishes': finishes,
        'dimensions': dimensions,
        'category_names': category_names,
        'configurable_options': {},
        'variants': [{
            'sku': sku,
            'name': product_name,
            'price_cad': price_num,
            'colour': colour or None,
            'finish': finishes[0] if finishes else None,
            'dimension': dimensions[0] if dimensions else None,
            'stock_status': 'IN_STOCK',
            'images': [],
        }] if sku else [],
        'variant_count': 1,
        'scraped_at': datetime.now(timezone.utc).isoformat(),
    }


def main():
    print('=== Tierra Sol scraper (via Wayback Machine) ===\n')

    urls = get_product_urls()
    print(f'Found {len(urls)} product URLs in sitemap\n')

    products = []
    errors = 0

    for i, url in enumerate(urls):
        html = fetch_page(url)
        if not html:
            errors += 1
            continue

        product = parse_product(html, url)
        if product:
            products.append(product)
        else:
            errors += 1
            print(f'  [PARSE FAIL] {url}')

        if (i + 1) % 50 == 0:
            print(f'  [{i+1}/{len(urls)}] {len(products)} ok, {errors} errors')

        time.sleep(RATE_LIMIT)

    out_path = 'tierra_sol_products.json'
    with open(out_path, 'w') as f:
        json.dump(products, f, indent=2)

    print(f'\n=== Done! {len(products)} products saved to {out_path} ===')
    with_images = sum(1 for p in products if p['images'])
    with_price = sum(1 for p in products if p['price_cad_min'])
    print(f'  With images : {with_images}/{len(products)}')
    print(f'  With price  : {with_price}/{len(products)}')
    print(f'  Errors      : {errors}')


if __name__ == '__main__':
    main()
