"""
C&S Tile scraper — cstile.ceramstone.com (WordPress/Avada theme)
- All product URLs from /products/ listing page (single page, no pagination)
- Product pages: SKU in first fusion-text div, specs from same div
- Images: assets/ URLs filtered by product slug keywords
- No pricing (trade-only site)
Output: cs_tile_products.json
"""

import os
import re
import json
import time
import requests
from typing import Optional
from bs4 import BeautifulSoup
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv()

BASE_URL = "https://cstile.ceramstone.com"
LISTING_URL = f"{BASE_URL}/products/"
RATE_LIMIT = 1.2

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Encoding": "gzip, deflate",
})


def get(url: str, retries: int = 3) -> Optional[str]:
    for attempt in range(retries):
        try:
            r = session.get(url, timeout=30)
            r.raise_for_status()
            return r.text
        except Exception as e:
            if attempt == retries - 1:
                print(f"    FAIL {url}: {e}")
                return None
            wait = (attempt + 1) * 5
            print(f"    Retry {attempt+1}/{retries} after {wait}s")
            time.sleep(wait)


def get_product_urls() -> list:
    html = get(LISTING_URL)
    if not html:
        return []
    soup = BeautifulSoup(html, 'html.parser')
    urls = []
    for a in soup.find_all('a', href=True):
        href = a['href']
        if re.match(r'https://cstile\.ceramstone\.com/products/[a-z0-9\-]+/?$', href):
            urls.append(href.rstrip('/'))
    return list(dict.fromkeys(urls))


def slug_keywords(url: str) -> list:
    """Extract meaningful keywords from URL slug for image matching."""
    slug = url.rstrip('/').split('/')[-1]
    parts = slug.split('-')
    # Return multi-char parts likely to be unique
    return [p for p in parts if len(p) >= 4]


def parse_product(html: str, source_url: str) -> Optional[dict]:
    soup = BeautifulSoup(html, 'html.parser')

    # Name from H1
    h1 = soup.find('h1')
    if not h1:
        return None
    name = h1.get_text(strip=True)

    url_key = source_url.rstrip('/').split('/')[-1]

    # SKU from the fusion-title h2 (format: "SKU123ProductName" — no spaces)
    sku = ''
    for h2 in soup.find_all('h2', class_=re.compile(r'fusion-title-heading', re.I)):
        raw = h2.get_text(strip=True)
        # SKU is the leading all-caps+digits+hyphen token before the product name
        m = re.match(r'^([A-Z]{2}[A-Z0-9\-]{3,}?)([A-Z][a-z])', raw)
        if m:
            sku = m.group(1).rstrip('-')
            break
    # Fallback: look for standalone product code in any element
    if not sku:
        for el in soup.find_all(['p', 'span', 'div']):
            txt = el.get_text(strip=True)
            m = re.match(r'^([A-Z]{2,}[A-Z0-9]{2,}[-][A-Z0-9\-]{2,})\s*$', txt)
            if m:
                sku = m.group(1)
                break

    dimensions = []
    finishes = []
    category_names = []
    description = ''

    content_divs = soup.find_all(class_=re.compile(r'fusion-text', re.I))
    for div in content_divs:
        txt = div.get_text(' ', strip=True)
        if not txt or len(txt) < 10:
            continue

        # Dimensions — match patterns like 24″x48″, 3x8, 12x24
        for dm in re.findall(r'(\d+(?:\.\d+)?)\s*[″"\'x×]\s*[xX×]?\s*(\d+(?:\.\d+)?)\s*[″"\'x×]?', txt):
            w, h = dm
            try:
                wf, hf = float(w), float(h)
                if 1 <= wf <= 120 and 1 <= hf <= 120:
                    ws = str(int(wf)) if wf == int(wf) else str(wf)
                    hs = str(int(hf)) if hf == int(hf) else str(hf)
                    dimensions.append(f"{ws}x{hs}")
            except ValueError:
                pass

        # Finish keywords
        for finish in ['Matte', 'Gloss', 'Polished', 'Honed', 'Natural', 'Rectified', 'Ribbed', 'Brushed', 'Lappato']:
            if finish.lower() in txt.lower() and finish.title() not in finishes:
                finishes.append(finish)

        # Use longer div as description
        if len(txt) > len(description) and len(txt) > 30:
            description = txt[:400]

    # Clean up dimensions — dedup and normalize
    dimensions = list(dict.fromkeys(dimensions))

    # Category from application tags
    for a in soup.find_all('a', href=True):
        href = a['href']
        if '/applications/' in href or '/product-application' in href:
            label = a.get_text(strip=True)
            if label and label not in ('Applications',) and len(label) < 40:
                category_names.append(label)
    category_names = list(dict.fromkeys(category_names))

    # Colours from name/slug (common colour words)
    colour_words = ['white', 'black', 'grey', 'gray', 'beige', 'brown', 'blue', 'green',
                    'bianco', 'nero', 'grigio', 'avorio', 'cenere', 'tortora', 'natural',
                    'graphite', 'ivory', 'cream', 'sand', 'taupe', 'gold', 'silver', 'bronze',
                    'carbon', 'smoke', 'charcoal', 'linen', 'clay', 'terracotta', 'rust', 'red']
    name_lower = name.lower()
    colours = [c.title() for c in colour_words if c in name_lower]

    # Images — find product-specific images by matching slug keywords to filename
    keywords = slug_keywords(source_url)
    all_images = []
    seen = set()
    for img in soup.find_all('img'):
        src = img.get('src', '') or img.get('data-src', '') or ''
        if not src or 'assets' not in src or 'logo' in src.lower():
            continue
        # Strip WordPress thumbnail suffixes like -320x202
        clean_src = re.sub(r'-\d+x\d+(\.\w+)$', r'\1', src)
        if clean_src in seen:
            continue
        seen.add(clean_src)
        fname = clean_src.split('/')[-1].lower()
        # Check if any keyword matches the filename
        if any(kw.lower() in fname for kw in keywords):
            label = img.get('alt', '') or name
            all_images.append({'url': clean_src, 'label': label})

    # If no keyword match, fall back to first non-logo asset image
    if not all_images:
        for img in soup.find_all('img'):
            src = img.get('src', '') or ''
            if 'assets' in src and 'logo' not in src.lower() and '320x' not in src:
                clean_src = re.sub(r'-\d+x\d+(\.\w+)$', r'\1', src)
                all_images.append({'url': clean_src, 'label': img.get('alt', '') or name})
                break

    thumbnail_url = all_images[0]['url'] if all_images else ''

    return {
        'supplier': 'cs_tile',
        'source_url': source_url,
        'sku': sku or url_key.upper(),
        'name': name,
        'url_key': url_key,
        'description_html': f'<p>{description}</p>' if description else '',
        'short_description': description[:200] if description else '',
        'price_cad_min': None,
        'price_cad_max': None,
        'currency': 'CAD',
        'thumbnail_url': thumbnail_url,
        'images': all_images,
        'colours': colours,
        'finishes': finishes,
        'dimensions': dimensions[:5],
        'category_names': category_names[:3],
        'configurable_options': {},
        'variants': [{
            'sku': sku or url_key.upper(),
            'name': name,
            'price_cad': None,
            'colour': colours[0] if colours else None,
            'finish': finishes[0] if finishes else None,
            'dimension': dimensions[0] if dimensions else None,
            'stock_status': 'IN_STOCK',
            'images': [],
        }],
        'variant_count': 1,
        'scraped_at': datetime.now(timezone.utc).isoformat(),
    }


def main():
    print('=== C&S Tile scraper ===\n')

    urls = get_product_urls()
    print(f'Found {len(urls)} product URLs\n')

    products = []
    errors = 0

    for i, url in enumerate(urls):
        html = get(url)
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

    out_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'cs_tile_products.json')
    with open(out_path, 'w') as f:
        json.dump(products, f, indent=2)

    print(f'\n=== Done! {len(products)} products saved to cs_tile_products.json ===')
    with_images = sum(1 for p in products if p['images'])
    with_dims = sum(1 for p in products if p['dimensions'])
    print(f'  With images     : {with_images}/{len(products)}')
    print(f'  With dimensions : {with_dims}/{len(products)}')
    print(f'  Errors          : {errors}')


if __name__ == '__main__':
    main()
