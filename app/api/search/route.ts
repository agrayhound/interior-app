import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { supabase } from "@/lib/supabase";

const MODAL_CLIP_URL = "https://agrayhound--clip-embedder-embed-endpoint.modal.run";

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
    };
    const { element, imageUrl, imageData, offset = 0 } = body;
    if (!element) {
      return NextResponse.json({ error: "element required" }, { status: 400 });
    }

    const embedText = buildEmbedText(element);

    // Fetch offset+PAGE_SIZE rows then slice — avoids requiring a DB migration for OFFSET support
    const fetchCount = offset + PAGE_SIZE;

    // Skip CLIP for base64 data URLs — Modal endpoint requires a fetchable URL
    const clipSource = imageData ? null : imageUrl;
    const [embeddingRes, clipVector] = await Promise.all([
      openai.embeddings.create({ model: "text-embedding-3-small", input: embedText }),
      clipSource ? fetchClipEmbedding(clipSource) : Promise.resolve(null),
    ]);
    const textVector = embeddingRes.data[0].embedding;

    let allResults;
    if (clipVector) {
      // Hybrid: 0.6 × semantic + 0.4 × CLIP
      const { data, error } = await supabase.rpc("search_similar_tiles_hybrid", {
        query_embedding: textVector,
        query_clip_embedding: clipVector,
        match_count: fetchCount,
      });
      if (error) {
        // Hybrid RPC not yet deployed — fall back to semantic only
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

    const page = (allResults ?? []).slice(offset) as Array<{
      id: number; name: string; sku: string; source_url: string;
      thumbnail_url: string; price_cad_min: number; supplier_id: string;
      style_tags: string[]; material_look: string; color_palette: string[];
      similarity: number;
    }>;

    // Color reranking — batch-embed query colors + each result's color palette
    // in a single OpenAI call, then blend: 0.5 × rpc_score + 0.5 × color_sim.
    // Uses text embedding cosine similarity so any color description works
    // without a hardcoded color→hex map.
    let reranked = page;
    if (element.colors.length > 0 && page.length > 0) {
      try {
        const queryColorText = `Colors: ${element.colors.join(", ")}`;
        const resultColorTexts = page.map(
          (r) => `Colors: ${(r.color_palette ?? []).join(", ") || "unknown"}`
        );
        const colorEmbedRes = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: [queryColorText, ...resultColorTexts],
        });
        const queryColorVec = colorEmbedRes.data[0].embedding;
        reranked = page.map((r, i) => {
          const colorSim = cosineSim(queryColorVec, colorEmbedRes.data[i + 1].embedding);
          return { ...r, similarity: 0.5 * r.similarity + 0.5 * colorSim };
        }).sort((a, b) => b.similarity - a.similarity);
      } catch (e) {
        console.warn("[/api/search] color rerank failed, using raw RPC order:", e);
      }
    }

    return NextResponse.json({
      embedText,
      usedHybrid: !!clipVector,
      colorReranked: true,
      results: reranked,
      hasMore: page.length === PAGE_SIZE,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/search]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
