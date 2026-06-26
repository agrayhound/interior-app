import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { supabase } from "@/lib/supabase";
import { embedImageUrl } from "@/lib/clipEmbed";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface Element {
  id: string;
  label: string;
  material: string;
  colors: string[];
  finish: string;
  category: string;
  is_tile: boolean;
}

function buildEmbedText(element: Element): string {
  return [
    `Material: ${element.material}`,
    `Colors: ${element.colors.join(", ")}`,
    `Finish: ${element.finish}`,
    `Category: ${element.category}`,
    element.label ? `Label: ${element.label}` : "",
  ].filter(Boolean).join(". ");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { element: Element; imageUrl?: string };
    const { element, imageUrl } = body;
    if (!element) {
      return NextResponse.json({ error: "element required" }, { status: 400 });
    }

    const embedText = buildEmbedText(element);

    // CLIP disabled on Vercel — fp32 model (~350MB) exceeds serverless memory.
    // Semantic-only search is used in production; hybrid search runs locally.
    const [embeddingRes] = await Promise.all([
      openai.embeddings.create({ model: "text-embedding-3-small", input: embedText }),
    ]);
    const clipVector = null;
    const textVector = embeddingRes.data[0].embedding;

    let results;
    if (clipVector) {
      // Hybrid: 0.6 × semantic + 0.4 × CLIP
      const { data, error } = await supabase.rpc("search_similar_tiles_hybrid", {
        query_embedding: textVector,
        query_clip_embedding: clipVector,
        match_count: 10,
      });
      if (error) {
        // Hybrid RPC not yet deployed — fall back to semantic only
        console.warn("[/api/search] hybrid RPC unavailable, falling back:", error.message);
        const { data: fallback, error: e2 } = await supabase.rpc("search_similar_tiles", {
          query_embedding: textVector,
          match_count: 10,
        });
        if (e2) throw new Error(`Supabase RPC error: ${e2.message}`);
        results = fallback;
      } else {
        results = data;
      }
    } else {
      const { data, error } = await supabase.rpc("search_similar_tiles", {
        query_embedding: textVector,
        match_count: 10,
      });
      if (error) throw new Error(`Supabase RPC error: ${error.message}`);
      results = data;
    }

    return NextResponse.json({
      embedText,
      usedHybrid: !!clipVector,
      results: results ?? [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/search]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
