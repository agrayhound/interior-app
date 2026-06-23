#!/usr/bin/env node
/**
 * Stone Tile GraphQL scraper
 *
 * Phase 1 — getCategoryProducts:
 *   Walk all 9 category IDs with pageSize:100, collect url_keys into a Set.
 *   Items are a mix of SimpleProduct and ConfigurableProduct url_keys.
 *   Original run got ~6,092 unique keys.
 *
 * Phase 2 — getProductDetailForProductPage:
 *   For each unique url_key, query the full product. When a SimpleProduct
 *   url_key is queried, Magento returns the parent ConfigurableProduct first.
 *   Take the ConfigurableProduct item and deduplicate by its url_key.
 *
 * Output: ../stoneTileProducts.json — one entry per unique ConfigurableProduct.
 */

const { writeFileSync } = require("fs");
const { join } = require("path");

const OUTPUT = join(__dirname, "..", "stoneTileProducts.json");
const GQL_URL = "https://stone-tile.com/graphql";
const HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};

const CATEGORY_IDS = [16, 57, 196, 165, 18, 42, 29, 21, 151];
const CAT_PAGE_SIZE = 100;
// Batch multiple url_key lookups in one request to speed up Phase 2
const DETAIL_BATCH = 10;

// ── helpers ───────────────────────────────────────────────────────────────────

async function gql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 400));
  return json.data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Phase 1: getCategoryProducts ──────────────────────────────────────────────

const CAT_QUERY = `
query getCategoryProducts($id: String!, $pageSize: Int!, $currentPage: Int!) {
  categoryList(filters: { ids: { eq: $id } }) {
    name
    products(pageSize: $pageSize, currentPage: $currentPage) {
      total_count
      page_info { total_pages }
      items {
        url_key
        __typename
      }
    }
  }
}`;

async function collectUrlKeys() {
  const urlKeys = new Set();

  for (const catId of CATEGORY_IDS) {
    let page = 1, totalPages = 1, catName = "";
    while (page <= totalPages) {
      const data = await gql(CAT_QUERY, {
        id: String(catId),
        pageSize: CAT_PAGE_SIZE,
        currentPage: page,
      });
      const cat = data.categoryList[0];
      if (page === 1) {
        catName = cat.name;
        totalPages = cat.products.page_info.total_pages;
        console.log(`  cat ${catId} (${catName}): ${cat.products.total_count} items, ${totalPages} pages`);
      }
      for (const item of cat.products.items) {
        urlKeys.add(item.url_key);
      }
      page++;
      if (page <= totalPages) await sleep(150);
    }
    console.log(`  cat ${catId}: done — ${urlKeys.size} unique url_keys so far`);
  }

  return urlKeys;
}

// ── Phase 2: getProductDetailForProductPage ───────────────────────────────────

const DETAIL_QUERY = `
query getProductDetailForProductPage($urlKeys: [String]!) {
  products(filter: { url_key: { in: $urlKeys } }) {
    items {
      __typename
      sku
      name
      url_key
      description { html }
      short_description { html }
      meta_title
      meta_description
      price_range {
        minimum_price { final_price { value currency } }
        maximum_price { final_price { value currency } }
      }
      thumbnail { url label }
      media_gallery { url label position disabled }
      categories { id name url_key }
      ... on ConfigurableProduct {
        configurable_options {
          id
          attribute_id
          label
          attribute_code
          values {
            value_index
            label
            swatch_data { value }
          }
        }
        variants {
          product {
            sku
            name
            url_key
            stock_status
            size_name_label
            variant_name
            price_range {
              minimum_price { final_price { value currency } }
            }
          }
          attributes { code value_index label }
        }
      }
    }
  }
}`;

async function fetchProductDetails(urlKeys) {
  // Deduplicated ConfigurableProducts keyed by their own url_key
  const products = new Map();
  const keyList = [...urlKeys];
  const total = keyList.length;

  for (let i = 0; i < total; i += DETAIL_BATCH) {
    const batch = keyList.slice(i, i + DETAIL_BATCH);
    let attempts = 0;
    while (true) {
      try {
        const data = await gql(DETAIL_QUERY, { urlKeys: batch });
        for (const item of data.products.items) {
          // Only store ConfigurableProducts, deduplicated by their url_key
          if (item.__typename === "ConfigurableProduct" && !products.has(item.url_key)) {
            products.set(item.url_key, item);
          }
        }
        break;
      } catch (err) {
        if (++attempts >= 3) throw err;
        console.warn(`  retry batch ${i}: ${err.message.slice(0, 100)}`);
        await sleep(2000 * attempts);
      }
    }
    const done = Math.min(i + DETAIL_BATCH, total);
    if (done % 500 === 0 || done === total) {
      console.log(`  queried ${done}/${total} url_keys → ${products.size} unique ConfigurableProducts`);
    }
    await sleep(150);
  }

  return [...products.values()];
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Phase 1: getCategoryProducts — collecting url_keys ===");
  const urlKeys = await collectUrlKeys();
  console.log(`\n✓ Phase 1 complete: ${urlKeys.size} unique url_keys collected`);

  if (urlKeys.size < 5000) {
    console.error(`\nERROR: Only ${urlKeys.size} url_keys found — expected ~6,092. Aborting.`);
    process.exit(1);
  }

  console.log("\n=== Phase 2: getProductDetailForProductPage ===");
  const products = await fetchProductDetails(urlKeys);

  // Stats
  const totalVariants = products.reduce((s, p) => s + (p.variants?.length ?? 0), 0);
  const totalImages = products.reduce((s, p) => s + (p.media_gallery?.filter(i => !i.disabled).length ?? 0), 0);

  console.log(`\n✓ Phase 2 complete:`);
  console.log(`  ConfigurableProducts: ${products.length}`);
  console.log(`  Total variants:       ${totalVariants}`);
  console.log(`  Total images:         ${totalImages}`);

  writeFileSync(OUTPUT, JSON.stringify(products, null, 2));
  console.log(`\nSaved → ${OUTPUT}  (${products.length} products)`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
