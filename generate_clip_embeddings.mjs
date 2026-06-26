/**
 * generate_clip_embeddings.mjs
 * Regenerate CLIP embeddings for all products using the JS Xenova model
 * (CLIPVisionModelWithProjection, fp32) — same vector space as clipEmbed.ts.
 */

import { CLIPVisionModelWithProjection, AutoProcessor, RawImage, env } from "@xenova/transformers";

const SUPABASE_URL = "https://dnghimclwgjmtnesxdmo.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_KEY;
const H     = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const HMIN  = { ...H, Prefer: "return=minimal" };

const CONCURRENCY = 5;

// ── Load model (once) ────────────────────────────────────────────────────────

console.log("Loading Xenova/clip-vit-base-patch32 (fp32)…");
env.cacheDir = "./.cache/transformers";
const [processor, model] = await Promise.all([
  AutoProcessor.from_pretrained("Xenova/clip-vit-base-patch32"),
  CLIPVisionModelWithProjection.from_pretrained("Xenova/clip-vit-base-patch32", { quantized: false }),
]);
console.log("Model ready.\n");

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function supabaseGetAll(path, params = {}) {
  const PAGE = 1000;
  let offset = 0, all = [];
  while (true) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("limit", PAGE);
    url.searchParams.set("offset", offset);
    const r = await fetch(url, { headers: H });
    if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
    const page = await r.json();
    all = all.concat(page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

// Keep alias for non-paginated use
async function supabaseGet(path, params = {}) {
  return supabaseGetAll(path, params);
}

async function upsertClipEmbedding(productId, vector) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/product_embeddings`, {
    method: "PATCH",
    headers: { ...HMIN, Prefer: "return=minimal" },
    body: JSON.stringify({ clip_embedding: vector }),
  });
  // PATCH with query param
  const r2 = await fetch(
    `${SUPABASE_URL}/rest/v1/product_embeddings?product_id=eq.${productId}`,
    { method: "PATCH", headers: HMIN, body: JSON.stringify({ clip_embedding: vector }) }
  );
  if (![200, 204].includes(r2.status)) {
    throw new Error(`PATCH product_id=${productId}: ${r2.status} ${await r2.text()}`);
  }
}

// ── Embed one image URL ───────────────────────────────────────────────────────

async function embedUrl(imageUrl) {
  const image = await RawImage.fromURL(imageUrl);
  const inputs = await processor(image);
  const { image_embeds } = await model(inputs);
  const data = Array.from(image_embeds.data);
  const norm = Math.sqrt(data.reduce((s, v) => s + v * v, 0));
  return data.map(v => v / norm);
}

// ── Build work list ───────────────────────────────────────────────────────────

// 1. All product_embeddings rows (gives us the product_ids to update)
const embedRows = await supabaseGet("product_embeddings", { select: "id,product_id" });
console.log(`product_embeddings rows: ${embedRows.length}`);

// 2. Primary images for all these products (is_primary=true, fallback position=0)
const allProductIds = embedRows.map(r => r.product_id);
const CHUNK = 200;
const imageMap = {};   // product_id → url

for (let i = 0; i < allProductIds.length; i += CHUNK) {
  const chunk = allProductIds.slice(i, i + CHUNK);
  const idFilter = `in.(${chunk.join(",")})`;

  // primary images
  const primaries = await supabaseGet("product_images", {
    select: "product_id,url",
    product_id: idFilter,
    is_primary: "eq.true",
  });
  for (const row of primaries) imageMap[row.product_id] = row.url;

  // fallback: first by position for any still missing
  const missing = chunk.filter(id => !imageMap[id]);
  if (missing.length) {
    const fallbacks = await supabaseGet("product_images", {
      select: "product_id,url",
      product_id: `in.(${missing.join(",")})`,
      order: "position.asc",
      limit: missing.length,
    });
    // keep only first per product
    const seen = new Set();
    for (const row of fallbacks) {
      if (!seen.has(row.product_id)) { imageMap[row.product_id] = row.url; seen.add(row.product_id); }
    }
  }
}

// Build ordered work list, skipping products with no image
const work = embedRows
  .map(r => ({ productId: r.product_id, embedId: r.id, url: imageMap[r.product_id] }))
  .filter(w => w.url);

const skipped = embedRows.length - work.length;
console.log(`Products with images: ${work.length}  (${skipped} skipped — no image)`);
console.log("Starting embedding generation…\n");

// ── Process concurrently ──────────────────────────────────────────────────────

let done = 0, errors = 0;
const start = Date.now();

async function processOne(item) {
  try {
    const vec = await embedUrl(item.url);
    await upsertClipEmbedding(item.productId, vec);
    done++;
    if (done % 50 === 0 || done === work.length) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      const rate = (done / ((Date.now() - start) / 1000)).toFixed(1);
      console.log(`  [${done}/${work.length}] ${elapsed}s elapsed  ${rate}/s  errors=${errors}`);
    }
  } catch (e) {
    errors++;
    console.error(`  ✗ product_id=${item.productId}: ${e.message}`);
  }
}

// Semaphore via chunked batches
for (let i = 0; i < work.length; i += CONCURRENCY) {
  await Promise.all(work.slice(i, i + CONCURRENCY).map(processOne));
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s — ${done} embedded, ${errors} errors, ${skipped} skipped`);
