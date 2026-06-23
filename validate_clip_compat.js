/**
 * validate_clip_compat.js
 * Checks JS CLIP vectors (CLIPVisionModelWithProjection) against
 * the Python-generated vectors stored in product_embeddings.
 * Target: cosine_sim > 0.95 for each image.
 */

import { CLIPVisionModelWithProjection, AutoProcessor, RawImage, env } from "@xenova/transformers";

const SUPABASE_URL = "https://dnghimclwgjmtnesxdmo.supabase.co";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRuZ2hpbWNsd2dqbXRuZXN4ZG1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTAyOTA5NCwiZXhwIjoyMDk2NjA1MDk0fQ.pkSlai_x2w347sDFgwne0GViYu4bXtWPpTkK-cdFi2M";
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}` };

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function supabaseGet(path, params = {}) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

// ── Load model ───────────────────────────────────────────────────────────────

console.log("Loading Xenova/clip-vit-base-patch32…");
env.cacheDir = "./.cache/transformers";
const [processor, model] = await Promise.all([
  AutoProcessor.from_pretrained("Xenova/clip-vit-base-patch32"),
  CLIPVisionModelWithProjection.from_pretrained("Xenova/clip-vit-base-patch32", { quantized: false }),
]);
console.log("Model ready.\n");

// ── Fetch 5 products that have clip_embedding stored ────────────────────────

const embedRows = await supabaseGet("product_embeddings", {
  select: "product_id,clip_embedding",
  clip_embedding: "not.is.null",
  limit: 5,
});

console.log(`Fetched ${embedRows.length} rows with stored CLIP embeddings.\n`);

// ── For each product, get its primary image URL ───────────────────────────

const ids = embedRows.map(r => r.product_id).join(",");
const imageRows = await supabaseGet("product_images", {
  select: "product_id,url",
  product_id: `in.(${ids})`,
  is_primary: "eq.true",
});
const imageMap = Object.fromEntries(imageRows.map(r => [r.product_id, r.url]));

// ── Embed each image with JS CLIP and compare ────────────────────────────

console.log("─".repeat(72));
console.log("product_id  image                          JS-dim  cosine_sim  pass?");
console.log("─".repeat(72));

let allPass = true;
for (const row of embedRows) {
  const imgUrl = imageMap[row.product_id];
  if (!imgUrl) { console.log(`${row.product_id}  (no image)`); continue; }

  // JS CLIP inference
  const image = await RawImage.fromURL(imgUrl);
  const inputs = await processor(image);
  const { image_embeds } = await model(inputs);
  const jsRaw = Array.from(image_embeds.data);
  const norm = Math.sqrt(jsRaw.reduce((s, v) => s + v*v, 0));
  const jsVec = jsRaw.map(v => v / norm);

  // Stored Python vector (comes back as a JSON array string or parsed array)
  const storedRaw = typeof row.clip_embedding === "string"
    ? JSON.parse(row.clip_embedding)
    : row.clip_embedding;

  const sim = cosineSim(jsVec, storedRaw);
  const pass = sim > 0.95;
  if (!pass) allPass = false;

  const name = imgUrl.split("/").pop().slice(0, 28).padEnd(30);
  console.log(
    `${String(row.product_id).padEnd(10)}  ${name}  ${jsVec.length}-dim  ${sim.toFixed(4)}      ${pass ? "✓" : "✗ FAIL"}`
  );
}

console.log("─".repeat(72));
console.log(allPass ? "\n✓ All vectors compatible (cosine_sim > 0.95)" : "\n✗ Compatibility check FAILED — review pooling strategy");
