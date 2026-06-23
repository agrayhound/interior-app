import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import ws from "ws";

config({ path: "/Users/grahamdobson/Documents/GitHub/interior-app/.env" });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });
const SUPPLIER_ID = "ames";
const BATCH = 100;

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

function dedup(rows, keyFn) {
  const seen = new Set();
  return rows.filter(r => { const k = keyFn(r); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function upsert(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + BATCH), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

const raw = JSON.parse(readFileSync("/Users/grahamdobson/Documents/GitHub/interior-app/ames_products.json", "utf8"));
console.log(`JSON has ${raw.length} products`);

const dbProds = await fetchAll("products", { supplier_id: SUPPLIER_ID });
console.log(`DB has ${dbProds.length} Ames products`);
const urlKeyToId = Object.fromEntries(dbProds.map(p => [p.url_key, p.id]));

// Re-upsert ALL images and variants (upsert is idempotent)
const imgRows = [];
const varRows = [];
for (const p of raw) {
  const pid = urlKeyToId[p.url_key];
  if (!pid) { console.log(`  WARN: no DB id for ${p.url_key}`); continue; }
  (p.images || []).forEach((img, i) => imgRows.push({ product_id: pid, url: img.url, label: img.label || null, position: i, is_primary: i === 0 }));
  for (const v of (p.variants || [])) {
    varRows.push({ product_id: pid, supplier_id: SUPPLIER_ID, sku: v.sku, name: v.name, price_cad: v.price_cad,
      colour: v.colour || null, finish: v.finish || null, dimension: v.dimension || null, stock_status: v.stock_status || "IN_STOCK" });
  }
}

const imgs = dedup(imgRows, r => `${r.product_id}|${r.url}`);
const vars = dedup(varRows, r => `${r.supplier_id}|${r.sku}`);
console.log(`Upserting ${imgs.length} images, ${vars.length} variants...`);

await upsert("product_images", imgs, "product_id,url");
console.log("✓ Images done");
await upsert("variants", vars, "supplier_id,sku");
console.log("✓ Variants done");
