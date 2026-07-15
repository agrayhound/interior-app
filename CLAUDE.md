# Interior App — Project Context for Claude Code
## What This Is
A tile (and eventually broader interior materials) discovery platform for Vancouver interior designers. Core workflow: designer pastes a Pinterest/Houzz inspiration image → AI identifies distinct surface materials → designer selects one → hybrid search returns matching products from local Vancouver suppliers with prices and direct links.
## Project Location
~/Documents/GitHub/interior-app
## Environment
.env at ~/Documents/GitHub/interior-app/.env
- SUPABASE_URL
- SUPABASE_SERVICE_KEY (service_role — always use this for scripts, never anon)
- ANTHROPIC_API_KEY
- OPENAI_API_KEY
## Tech Stack
- Next.js 14 (app router)
- Tailwind CSS
- Supabase (Postgres + pgvector) hosted on Vercel Marketplace, region us-west-2
- Python 3 for scraping and bulk pipeline scripts
- Node.js for import scripts and the Next.js API routes
## Database Schema (Supabase)
### Tables
- `suppliers` — id (text PK), name, website, city, active
- `products` — one row per parent product page
- `variants` — one row per individual SKU (child of product)
- `product_images` — image URLs per product (is_primary, position)
- `product_embeddings` — one row per product, stores both text and CLIP vectors
- `search_sessions` — logs designer searches
### Key columns on products
Vision analysis fields (populated by analyze_products.py):
- style_tags text[]
- material_look text
- mood_tags text[]
- pattern_type text
- finish_look text
- color_palette text[]
- room_suitability text[]
- analyzed_at timestamptz (null = not yet analyzed)
### Key columns on product_embeddings
- embedding vector(1536) — OpenAI text-embedding-3-small of Claude vision attribute text
- clip_embedding vector(512) — CLIP visual embedding (CLIPVisionModelWithProjection, fp32, NOT quantized, NOT mean-pooled)
- embed_text text — the text that was embedded (for debugging)
### Supabase RPC functions
- search_similar_tiles() — semantic-only search
- search_similar_tiles_hybrid() — takes both text vector and CLIP vector, returns 0.6×semantic + 0.4×CLIP score
## Suppliers
### Current status
| Supplier | Method | Status | Products in DB | Analyzed | CLIP |
|---|---|---|---|---|---|
| Stone Tile | GraphQL (Magento 2 PWA) | ✅ Complete | 498 | 492 | 492 |
| Ames | Cheerio HTML (Magento) | ✅ Complete | 1404 | 1404 | 1404 |
| Centura | Drupal settings JSON + sitemap, variant explosion (SKU-per-row) | ✅ Complete | 5617 | 5590 | 5590 |
| Tierra Sol | Playwright + CF cookie | ✅ Complete | 760 | 760 | 760 |
| C&S Tile | Cheerio HTML (WordPress) | ✅ Complete | 832 | 832 | 832 |
| Julian Tile | Squarespace ?format=json API | ✅ Complete | 645 | 645 | 645 |
| Centanni | Wix SSR warmup JSON (centannitile.com) | ✅ Complete | 213 | 213 | 213 |
| Artistic Tile | Shopify /products.json API | ✅ Complete | 1831 | 1811 | 1811 |
| INAX Tile | WordPress HTML scraper (inaxtile.com) | ✅ Complete | 304 | 303 | 303 |
| Ann Sacks | Next.js SSR __NEXT_DATA__ + /en/pdp-sitemap.xml (annsacks.kohler.com) | ✅ Complete | 887 | 869 | 885 |

Notes on unanalyzed counts:
- Stone Tile: 6 unanalyzed — no product_images rows (scraper stored Magento placeholder URLs in thumbnail_url but wrote no image rows)
- Artistic Tile: 20 unanalyzed — 15 null thumbnail_url, 4 dead CDN URLs (404), 1 PDF URL; not fixable without re-scrape
- INAX: 1 unanalyzed (OMBRE BORDER, now fixed 2026-07-09 — was missing product_images row)

### Supplier IDs (used in supplier_id column)
stone_tile, ames, centura, tierra_sol, cs_tile, julian, centanni, artistic_tile, inax, ann_sacks
## Pipeline — How New Suppliers Get Added
### Step 1: Scrape
- Write a supplier-specific scraper (Python with requests+BeautifulSoup or Node.js with cheerio)
- Output: JSON file with array of products in standard schema (see below)
- Save to ~/Documents/GitHub/interior-app/{supplier}_products.json
- Rate limit: minimum 1 request/second to be polite
- Use caffeinate -i on Mac to prevent sleep during long runs
### Standard product schema (output of every scraper)
```json
{
  "supplier": "supplier_id",
  "source_url": "https://...",
  "sku": "ABC123",
  "name": "Product Name",
  "url_key": "product-url-slug",
  "description_html": "<p>...</p>",
  "short_description": "...",
  "price_cad_min": 12.50,
  "price_cad_max": 25.00,
  "currency": "CAD",
  "thumbnail_url": "https://...",
  "images": [{"url": "https://...", "label": "..."}],
  "colours": ["white", "grey"],
  "finishes": ["matte", "gloss"],
  "dimensions": ["12x24", "24x24"],
  "category_names": ["Floor Tile", "Wall Tile"],
  "configurable_options": {},
  "variants": [
    {
      "sku": "ABC123-WHT",
      "name": "Product Name - White",
      "price_cad": 12.50,
      "colour": "white",
      "finish": "matte",
      "dimension": "12x24",
      "stock_status": "IN_STOCK",
      "images": []
    }
  ],
  "variant_count": 4,
  "scraped_at": "2026-06-22T00:00:00Z"
}
```
### Step 2: Import to Supabase
- Script: import_{supplier}.js (Node.js)
- Upsert on (supplier_id, url_key) conflict for products
- Upsert on (supplier_id, sku) conflict for variants
- Upsert on (product_id, url) conflict for product_images
- Deduplicate within batches before upserting (critical — prevents ON CONFLICT errors)
- Batch size: 100 rows per upsert call
- Set is_primary = true on first image (position 0)
### Step 3: Vision Analysis
- Script: analyze_products.py
- Fetches products WHERE analyzed_at IS NULL in pages of 200
- Finds primary image (is_primary = true, fallback to position 0)
- Downloads image → base64 → Claude vision API (claude-sonnet-4-6)
- Extracts: style_tags, material_look, mood_tags, pattern_type, finish_look, color_palette, room_suitability
- Builds embed_text: "Product: {name}. Style: {style_tags}. Material: {material_look}. Colors: {color_palette}..."
- Generates text embedding via OpenAI text-embedding-3-small (1536-dim)
- Updates products table with all 7 vision fields + analyzed_at
- Upserts to product_embeddings (product_id, embed_text, embedding)
- Rate limit: 20 Claude vision calls/min (token bucket)
- 5 concurrent workers
- Re-running is safe — skips already-analyzed products
### Step 4: CLIP Embeddings
- Script: generate_clip_embeddings.mjs (Node.js — NOT Python)
- Uses @xenova/transformers CLIPVisionModelWithProjection
- CRITICAL: { quantized: false } — must use fp32 model, NOT quantized
- CRITICAL: do NOT use mean pooling — use image_embeds directly (CLS token via projection head)
- This matches exactly how the Next.js /api/search query-side generates CLIP vectors
- L2-normalize the output vector before storing
- Upserts to product_embeddings.clip_embedding (vector 512-dim)
- Overwrites existing values — JS model is source of truth for CLIP
- Cosine similarity between JS-generated query vectors and JS-generated index vectors = 1.0000
## CLIP — Critical Notes
The biggest source of bugs in this project has been CLIP vector incompatibility. Rules:
1. **Always use CLIPVisionModelWithProjection, NOT pipeline("feature-extraction")**
2. **Always use { quantized: false } (fp32)**
3. **Never apply mean pooling to CLIP outputs**
4. **Query side and index side must use identical preprocessing**
5. **Python PIL bicubic resize ≠ JS canvas resize** — do not mix Python and JS for CLIP. JS is the source of truth. If you need to regenerate embeddings, use generate_clip_embeddings.mjs, never the Python version.
6. **Validate compatibility**: cosine_sim between query vector and stored vector for same image should be > 0.99. If it's below 0.95, something is wrong with the preprocessing.
## Search Architecture
### Query flow (/api/search)
1. Receive { imageUrl, element } where element is from /api/identify
2. Build embed_text from element attributes
3. In parallel:
   a. OpenAI text-embedding-3-small → 1536-dim text vector
   b. CLIPVisionModelWithProjection (fp32) → 512-dim visual vector
4. Call search_similar_tiles_hybrid(query_embedding, clip_embedding, match_count=10)
5. Returns products ranked by 0.6×semantic + 0.4×CLIP
### Identify flow (/api/identify)
1. Receive { imageUrl }
2. Send to Claude vision API with prompt to identify all distinct surface materials
3. Returns { elements: [{ id, label, material, colors, finish, category, is_tile }] }
4. Designer selects one element
5. Selected element passed to /api/search
### Hybrid scoring formula
final_score = 0.6 × semantic_score + 0.4 × clip_score
- semantic captures: style, mood, material type, room context
- CLIP captures: visual format, tile size, pattern, texture, exact color tone
## Ames Tile Specific Notes
- Platform: Magento (Codazon theme, server-rendered HTML)
- Product detail URL format: `https://www.amestile.com/{url_key}` (e.g. `/ateam2448`)
- All products are `page-product-grouped` type in Magento — each URL is one SKU, not a configurable parent
- **CRITICAL: `/products` listing is NOT the full catalog** — it only exposes ~697 of 1,404 products
- To scrape the full catalog, collect URLs from all category pages and union them:
  - `/browse-by-type/wall-tile` (581)
  - `/browse-by-type/floor-tile` (609)
  - `/browse-by-type/mosaics` (107)
  - `/browse-by-type/glass` (22)
  - `/browse-by-type/decor` (128)
  - `/browse-by-type/outdoor` (236)
- Scraper: `scrapers/ames_scraper.py` scrapes `/products` (use category pages for full catalog)
- Price: `meta[property="product:price:amount"]`
- Images: fotorama gallery JSON embedded in `<script>` — `"data": [{full, thumb, caption}]`
- Specs: `<th>/<td>` pairs — Series Name, Colour, Tile Finish, Product Type, Recommended Application
- SKU: url_key uppercased (e.g. `ateam2448` → `ATEAM2448`)

## Stone Tile Specific Notes
- Platform: Magento 2 PWA Studio (Venia theme)
- GraphQL endpoint: https://stone-tile.com/graphql
- Store header: CA_EN
- Category listings return SimpleProducts (variants), NOT ConfigurableProducts
- Parent products discovered by querying each SimpleProduct url_key via getProductDetailForProductPage
- Real catalog: 446 ConfigurableProduct parents, ~6,092 SimpleProduct variants
- Do not confuse variant count with product count
## Costs
- Claude vision API: ~$0.003/image at 600×600px (claude-sonnet-4-6)
- **Large images (e.g. C&S Tile 2500×2000px) cost ~4–5× more** — analyze_products.py resizes to max 800px before sending (requires Pillow: `pip3 install Pillow`)
- OpenAI embeddings: ~$0.000015/product (text-embedding-3-small)
- CLIP embeddings: free (runs locally via @xenova/transformers)
- Estimated cost for full 7-supplier catalog (~5,000 products): ~$15 vision + <$1 embeddings

## What's Next
1. Pinterest OAuth integration — COMPLETE. Full OAuth flow live at /auth/pinterest and /auth/pinterest/callback. Access token stored in httpOnly cookie; refresh token auto-refreshes on 401. /pinterest page shows connect screen when unauthenticated, board browser when connected. Disconnect button clears cookies.
4. Fal.ai room scene generation (show tile installed in a room)
5. Expand beyond tiles: flooring, countertops, hardware

## Running the Full Pipeline for a New Supplier
```bash
# 1. Scrape
python3 scrapers/{supplier}_scraper.py

# 2. Import
node import_{supplier}.mjs

# 3. Analyze (vision + text embeddings)
# IMPORTANT: kill any stale analyze_products.py before starting — two running at once
# doubles API credit burn and causes duplicate writes. The script has a self-abort
# guard but it checks live Python processes, not shell wrappers.
ps aux | grep analyze_products | grep python  # must return nothing
python3 analyze_products.py
# Re-running is safe: skips products WHERE analyzed_at IS NOT NULL

# 4. CLIP embeddings
# Now only processes products WHERE clip_embedding IS NULL (skips already-done)
node --env-file=.env generate_clip_embeddings.mjs

# 5. Verify
# Check products WHERE analyzed_at IS NULL = 0
# Check product_embeddings WHERE clip_embedding IS NULL = only those with no images
```

## Known Gotchas
- **analyze_products.py stale process**: if it dies mid-run (credit exhaustion), the process may linger. Always `ps aux | grep analyze_products | grep python` before restarting.
- **Anthropic credits**: large-image suppliers (like C&S Tile) exhaust credits faster. Top up before running — at ~$0.015/image for 2500px images, 800 products ≈ $12.
- **generate_clip_embeddings.mjs previously re-ran all products** on every run (wasteful). Fixed to only process `clip_embedding IS NULL` rows. If you need to force a full re-run, temporarily remove that filter.
- **dotenv**: both analyze_products.py and generate_clip_embeddings.mjs require .env to be loaded. Run from project root or use `--env-file=.env` flag for node.
- **Python 3.9**: no `str | None` union syntax — use `Optional[str]` from typing.
