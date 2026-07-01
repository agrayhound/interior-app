// color-data-v2
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { supabase } from "@/lib/supabase";
import productColorsRaw from "@/data/product_colors.json";

const productColors = productColorsRaw as Record<string, string>;
console.log("[search] color-data-check:", JSON.stringify(Object.entries(productColorsRaw).slice(0, 3)));

const MODAL_CLIP_URL = "https://agrayhound--clip-embedder-embed-endpoint.modal.run";
const MAX_RGB_DIST = 441.67; // sqrt(255² × 3) — max possible RGB distance

async function fetchClipEmbedding(imageUrl: string): Promise<number[] | null> {
  try {
    const res = await fetch(MODAL_CLIP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageUrl }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.embedding ?? null;
  } catch {
    return null;
  }
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface Element {
  id: string;
  label: string;
  material: string;
  colors: string[];
  color_hexes?: string[];
  finish: string;
  category: string;
  is_tile: boolean;
}

// Colors appear 3× to weight them above style/material in the embedding space
function buildEmbedText(element: Element): string {
  const colorStr = element.colors.join(", ");
  return [
    `Colors: ${colorStr}. Colors: ${colorStr}. Colors: ${colorStr}.`,
    `${element.material} tile.`,
    `Finish: ${element.finish}.`,
    `Category: ${element.category}.`,
    element.label ? `Label: ${element.label}.` : "",
  ].filter(Boolean).join(" ");
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function rgbColorScore(
  qr: number, qg: number, qb: number,
  productId: number
): number | null {
  const hex = productColors[String(productId)];
  if (!hex) return null;
  const c = hexToRgb(hex);
  if (!c) return null;
  const dist = Math.sqrt(
    Math.pow(qr - c.r, 2) + Math.pow(qg - c.g, 2) + Math.pow(qb - c.b, 2)
  );
  return 1 - dist / MAX_RGB_DIST;
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const PAGE_SIZE = 10;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      element: Element;
      imageUrl?: string;
      imageData?: string;
      offset?: number;
      colorWeight?: number;
    };
    const { element, imageUrl, imageData, offset = 0, colorWeight = 0.5 } = body;
    if (!element) {
      return NextResponse.json({ error: "element required" }, { status: 400 });
    }

    console.log(`[search] === NEW SEARCH REQUEST ===`);
    console.log(`[search] element: label="${element.label}" material=${element.material} category=${element.category} is_tile=${element.is_tile}`);
    console.log(`[search] colors=${JSON.stringify(element.colors)}`);
    console.log(`[search] color_hexes=${JSON.stringify(element.color_hexes)}`);
    console.log(`[search] imageUrl=${imageUrl ?? "(none)"} imageData=${imageData ? `base64 len=${imageData.length}` : "(none)"}`);
    console.log(`[search] colorWeight=${colorWeight} offset=${offset}`);

    const embedText = buildEmbedText(element);
    console.log(`[search] embedText="${embedText}"`);

    const clampedColorWeight = Math.max(0, Math.min(1, colorWeight));
    // Fetch a larger pool when color reranking is active so color-accurate tiles
    // that aren't top semantic matches can still be surfaced after reranking
    const CANDIDATE_POOL = clampedColorWeight > 0 ? Math.max(offset + 100, 100) : offset + PAGE_SIZE;
    const fetchCount = CANDIDATE_POOL;

    // Parse query dominant color from element.color_hexes (provided by /api/identify)
    const queryHex = element.color_hexes?.[0] ?? null;
    const queryRgb = queryHex ? hexToRgb(queryHex) : null;
    console.log(`[search] queryHex=${queryHex ?? "(none — no color_hexes, will use text cosine fallback)"} queryRgb=${queryRgb ? JSON.stringify(queryRgb) : "null"}`);

    // Skip CLIP for base64 data URLs — Modal endpoint requires a fetchable URL
    const clipSource = imageData ? null : imageUrl;
    console.log(`[search] CLIP source=${clipSource ?? "(skipped — imageData is base64)"} candidatePool=${clampedColorWeight > 0 ? Math.max(offset + 100, 100) : offset + PAGE_SIZE}`);
    const [embeddingRes, clipVector] = await Promise.all([
      openai.embeddings.create({ model: "text-embedding-3-small", input: embedText }),
      clipSource ? fetchClipEmbedding(clipSource) : Promise.resolve(null),
    ]);
    const textVector = embeddingRes.data[0].embedding;

    console.log(`[search] CLIP vector obtained: ${clipVector ? `yes (${clipVector.length}d)` : "no"}`);

    let allResults;
    if (clipVector) {
      const { data, error } = await supabase.rpc("search_similar_tiles_hybrid", {
        query_embedding: textVector,
        query_clip_embedding: clipVector,
        match_count: fetchCount,
      });
      if (error) {
        console.warn("[/api/search] hybrid RPC unavailable, falling back:", error.message);
        const { data: fallback, error: e2 } = await supabase.rpc("search_similar_tiles", {
          query_embedding: textVector,
          match_count: fetchCount,
        });
        if (e2) throw new Error(`Supabase RPC error: ${e2.message}`);
        allResults = fallback;
      } else {
        allResults = data;
      }
    } else {
      const { data, error } = await supabase.rpc("search_similar_tiles", {
        query_embedding: textVector,
        match_count: fetchCount,
      });
      if (error) throw new Error(`Supabase RPC error: ${error.message}`);
      allResults = data;
    }

    // Normalize RPC field names: product_id → id, colours → color_palette
    // When color reranking, we fetched up to 100 candidates — rerank all of them,
    // then slice out the requested page so the best color matches float up.
    const allNormalized = (allResults ?? []).map((r: Record<string, unknown>) => ({
      ...r,
      id: (r.id ?? r.product_id) as number,
      color_palette: (r.color_palette ?? r.colours ?? []) as string[],
    })) as Array<{
      id: number; name: string; sku: string; source_url: string;
      thumbnail_url: string; price_cad_min: number; supplier_id: string;
      style_tags: string[]; material_look: string; color_palette: string[];
      similarity: number;
    }>;

    // Color reranking — blend hybrid score with color proximity across full candidate pool,
    // then slice the requested page out of the reranked list.
    let reranked = allNormalized;
    if (clampedColorWeight > 0 && allNormalized.length > 0) {
      try {
        if (queryRgb) {
          // RGB distance path — O(n) in-memory, no extra API calls
          reranked = allNormalized.map((r) => {
            const cs = rgbColorScore(queryRgb.r, queryRgb.g, queryRgb.b, r.id);
            const colorScore = cs ?? 0.5;
            const blended = (1 - clampedColorWeight) * r.similarity + clampedColorWeight * colorScore;
            return { ...r, similarity: blended, dominant_color_hex: productColors[String(r.id)] ?? null };
          }).sort((a, b) => b.similarity - a.similarity);
        } else if (element.colors.length > 0) {
          // Text embedding fallback
          const queryColorText = `Colors: ${element.colors.join(", ")}`;
          const resultColorTexts = allNormalized.map(
            (r) => `Colors: ${(r.color_palette ?? []).join(", ") || "unknown"}`
          );
          const colorEmbedRes = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: [queryColorText, ...resultColorTexts],
          });
          const queryColorVec = colorEmbedRes.data[0].embedding;
          reranked = allNormalized.map((r, i) => {
            const colorSim = cosineSim(queryColorVec, colorEmbedRes.data[i + 1].embedding);
            const blended = (1 - clampedColorWeight) * r.similarity + clampedColorWeight * colorSim;
            return { ...r, similarity: blended };
          }).sort((a, b) => b.similarity - a.similarity);
        }
      } catch (e) {
        console.warn("[/api/search] color rerank failed, using raw RPC order:", e);
      }
    }

    const page = reranked.slice(offset, offset + PAGE_SIZE);
    const hasMore = reranked.length > offset + PAGE_SIZE;

    console.log(`[search] top 10 results after reranking (usedRgbColor=${!!queryRgb}):`);
    for (const r of page.slice(0, 10)) {
      console.log(`  [search]   sim=${r.similarity.toFixed(3)}  hex=${(r as Record<string, unknown>).dominant_color_hex ?? "?"}  [${r.name}]  palette=${JSON.stringify(r.color_palette?.slice(0,3))}`);
    }

    return NextResponse.json({
      embedText,
      usedHybrid: !!clipVector,
      usedRgbColor: !!queryRgb,
      results: page,
      hasMore,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/search]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
