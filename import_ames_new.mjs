/**
 * Import only the new (not-yet-imported) Ames products.
 * Detects new products by checking which url_keys already exist in Supabase.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import ws from "ws";

config({ path: "/Users/grahamdobson/Documents/GitHub/interior-app/.env" });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } }
);

const SUPPLIER_ID = "ames";
const BATCH = 100;

function dedup(rows, keyFn) {
  const seen = new Set();
  return rows.filter(r => { const k = keyFn(r); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function upsert(table, rows, onConflict) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + BATCH), { onConflict, ignoreDuplicates: false });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

const raw = JSON.parse(readFileSync("/Users/grahamdobson/Documents/GitHub/interior-app/ames_products.json", "utf8"));

// Paginated fetch — Supabase returns max 1000 rows per request
async function fetchAll(table, filters = {}) {
  const PAGE = 1000;
  let offset = 0, all = [];
  while (true) {
    let q = supabase.from(table).select("*").range(offset, offset + PAGE - 1);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { data, error } = await q;
    if (error) throw new Error(`fetchAll ${table}: ${error.message}`);
    all = all.concat(data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

// Fetch existing url_keys (paginated)
const existing = await fetchAll("products", { supplier_id: SUPPLIER_ID });
const existingKeys = new Set(existing.map(r => r.url_key));
const newProds = raw.filter(p => !existingKeys.has(p.url_key));
console.log(`Total in JSON: ${raw.length}  Already in DB: ${existingKeys.size}  New: ${newProds.length}`);

// Products
const productRows = dedup(newProds.map(p => ({
  supplier_id: SUPPLIER_ID, source_url: p.source_url, sku: p.sku, name: p.name,
  url_key: p.url_key, description_html: p.description_html || null,
  short_description: p.short_description || null,
  price_cad_min: p.price_cad_min, price_cad_max: p.price_cad_max, currency: "CAD",
  thumbnail_url: p.thumbnail_url || null,
  colours: p.colours || [], finishes: p.finishes || [], dimensions: p.dimensions || [],
  category_names: p.category_names || [], configurable_options: p.configurable_options || {},
})), r => `${r.supplier_id}|${r.url_key}`);

console.log(`Upserting ${productRows.length} products...`);
await upsert("products", productRows, "supplier_id,url_key");
console.log("✓ Products");

// Fetch back IDs for ALL ames products (paginated)
const dbProds = await fetchAll("products", { supplier_id: SUPPLIER_ID });
console.log(`Fetched ${dbProds.length} total Ames product IDs from DB`);
const urlKeyToId = Object.fromEntries(dbProds.map(p => [p.url_key, p.id]));

// Images
const imgRows = [];
for (const p of newProds) {
  const pid = urlKeyToId[p.url_key];
  if (!pid) continue;
  (p.images || []).forEach((img, i) => imgRows.push({ product_id: pid, url: img.url, label: img.label || null, position: i, is_primary: i === 0 }));
}
const imgs = dedup(imgRows, r => `${r.product_id}|${r.url}`);
console.log(`Upserting ${imgs.length} images...`);
await upsert("product_images", imgs, "product_id,url");
console.log("✓ Images");

// Variants
const varRows = [];
for (const p of newProds) {
  const pid = urlKeyToId[p.url_key];
  if (!pid) continue;
  for (const v of (p.variants || [])) {
    varRows.push({ product_id: pid, supplier_id: SUPPLIER_ID, sku: v.sku, name: v.name,
      price_cad: v.price_cad, colour: v.colour || null, finish: v.finish || null,
      dimension: v.dimension || null, stock_status: v.stock_status || "IN_STOCK" });
  }
}
const vars = dedup(varRows, r => `${r.supplier_id}|${r.sku}`);
console.log(`Upserting ${vars.length} variants...`);
await upsert("variants", vars, "supplier_id,sku");
console.log("✓ Variants");

console.log(`\nDone. Products: ${productRows.length}  Images: ${imgs.length}  Variants: ${vars.length}`);
