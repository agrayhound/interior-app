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

    const page = (allResults ?? []).slice(offset);

    return NextResponse.json({
      embedText,
      usedHybrid: !!clipVector,
      results: page,
      hasMore: page.length === PAGE_SIZE,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/search]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
