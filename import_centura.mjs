import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import ws from "ws";

config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } }
);

const SUPPLIER_ID = "centura";
const BATCH = 100;

function dedup(rows, keyFn) {
  const seen = new Set();
  return rows.filter(r => {
    const k = keyFn(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function upsert(table, rows, onConflict) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from(table)
      .upsert(batch, { onConflict, ignoreDuplicates: false });
    if (error) throw new Error(`${table} upsert: ${error.message}`);
  }
}

async function ensureSupplier() {
  const { error } = await supabase.from("suppliers").upsert(
    {
      id:      SUPPLIER_ID,
      name:    "Centura Tile",
      website: "https://www.centura.ca",
      city:    "Vancouver",
      active:  true,
    },
    { onConflict: "id" }
  );
  if (error) throw new Error(`supplier upsert: ${error.message}`);
}

async function main() {
  const raw = JSON.parse(readFileSync("centura_products.json", "utf8"));
  console.log(`Loaded ${raw.length} products from centura_products.json\n`);

  await ensureSupplier();
  console.log("✓ Supplier row upserted");

  // 1. Products
  const productRows = dedup(
    raw.map(p => ({
      supplier_id:          SUPPLIER_ID,
      source_url:           p.source_url,
      sku:                  p.sku,
      name:                 p.name,
      url_key:              p.url_key,
      description_html:     p.description_html || null,
      short_description:    p.short_description || null,
      price_cad_min:        p.price_cad_min,
      price_cad_max:        p.price_cad_max,
      currency:             p.currency || "CAD",
      thumbnail_url:        p.thumbnail_url || null,
      colours:              p.colours || [],
      finishes:             p.finishes || [],
      dimensions:           p.dimensions || [],
      category_names:       p.category_names || [],
      configurable_options: p.configurable_options || {},
    })),
    r => `${r.supplier_id}|${r.url_key}`
  );

  console.log(`Upserting ${productRows.length} products…`);
  await upsert("products", productRows, "supplier_id,url_key");
  console.log("✓ Products upserted");

  // Fetch back product IDs
  const PAGE = 1000;
  let allDbProducts = [], offset = 0;
  while (true) {
    const { data, error } = await supabase.from("products").select("id,url_key")
      .eq("supplier_id", SUPPLIER_ID).range(offset, offset + PAGE - 1);
    if (error) throw new Error(`fetch products: ${error.message}`);
    allDbProducts = allDbProducts.concat(data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  const urlKeyToId = Object.fromEntries(allDbProducts.map(p => [p.url_key, p.id]));
  console.log(`Fetched back ${allDbProducts.length} product IDs`);

  // 2. Images
  const imageRows = [];
  for (const p of raw) {
    const productId = urlKeyToId[p.url_key];
    if (!productId) continue;
    (p.images || []).forEach((img, idx) => {
      imageRows.push({
        product_id: productId,
        url:        img.url,
        label:      img.label || null,
        position:   idx,
        is_primary: idx === 0,
      });
    });
  }
  const dedupedImages = dedup(imageRows, r => `${r.product_id}|${r.url}`);
  console.log(`Upserting ${dedupedImages.length} images…`);
  await upsert("product_images", dedupedImages, "product_id,url");
  console.log("✓ Images upserted");

  // 3. Variants
  const variantRows = [];
  for (const p of raw) {
    const productId = urlKeyToId[p.url_key];
    if (!productId) continue;
    for (const v of (p.variants || [])) {
      variantRows.push({
        product_id:   productId,
        supplier_id:  SUPPLIER_ID,
        sku:          v.sku,
        name:         v.name,
        price_cad:    v.price_cad,
        colour:       null,
        finish:       null,
        dimension:    v.dimension || null,
        stock_status: v.stock_status || "IN_STOCK",
      });
    }
  }
  const dedupedVariants = dedup(variantRows, r => `${r.supplier_id}|${r.sku}`);
  console.log(`Upserting ${dedupedVariants.length} variants…`);
  await upsert("variants", dedupedVariants, "supplier_id,sku");
  console.log("✓ Variants upserted");

  console.log(`
Done.
  Products upserted : ${productRows.length}
  Images upserted   : ${dedupedImages.length}
  Variants upserted : ${dedupedVariants.length}
`);
}

main().catch(e => { console.error(e); process.exit(1); });
