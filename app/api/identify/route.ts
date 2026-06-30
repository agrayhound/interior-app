import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const IDENTIFY_PROMPT = `Analyze this interior design image and identify all distinct surface materials and finishes visible. For each element return: a short label, the material type, colors with hex approximations, finish, and which category it belongs to (tile, stone, wood, concrete, plaster, fabric, metal, glass). Return JSON: { "elements": [{ "id": "<short-id>", "label": "<descriptive label>", "material": "<material>", "colors": ["<descriptive color name>", ...], "color_hexes": ["#RRGGBB", ...], "finish": "<finish>", "category": "<category>", "is_tile": <true|false> }] }. The color_hexes array must have the same length as colors — each hex is your best approximation of that specific color as seen in the image. Use specific descriptive color names (e.g. "sage green", "warm terracotta", "dusty navy") not generic ones. Focus on surfaces a designer might want to source — tiles, stone, wood flooring, countertops. Ignore people, plants, small objects. Return ONLY the JSON object, no markdown, no explanation.`;

function fetchImageAsBase64(imageUrl: string) {
  return fetch(imageUrl).then(async (res) => {
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const mediaType = (
      ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(contentType)
        ? contentType
        : "image/jpeg"
    ) as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    return { base64, mediaType };
  });
}

function parseDataUrl(dataUrl: string): { base64: string; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" } {
  const m = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!m) throw new Error("Invalid data URL");
  const mt = m[1] as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  return { base64: m[2], mediaType: mt };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { imageUrl, imageData } = body;
    if (!imageUrl && !imageData) {
      return NextResponse.json({ error: "imageUrl or imageData required" }, { status: 400 });
    }

    const { base64, mediaType } = imageData
      ? parseDataUrl(imageData)
      : await fetchImageAsBase64(imageUrl);

    console.log(`[identify] source=${imageData ? "base64/crop" : "url"} mediaType=${mediaType} base64Length=${base64.length} (~${Math.round(base64.length * 0.75 / 1024)}KB decoded)`);

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: IDENTIFY_PROMPT },
          ],
        },
      ],
    });

    let text = (message.content[0] as { text: string }).text.trim();
    if (text.startsWith("```")) {
      text = text.split("```")[1];
      if (text.startsWith("json")) text = text.slice(4);
    }
    const { elements } = JSON.parse(text);

    console.log(`[identify] Claude returned ${(elements ?? []).length} element(s):`);
    for (const el of (elements ?? [])) {
      console.log(`  [identify]   id=${el.id} label="${el.label}" material=${el.material} category=${el.category} is_tile=${el.is_tile}`);
      console.log(`  [identify]   colors=${JSON.stringify(el.colors)}`);
      console.log(`  [identify]   color_hexes=${JSON.stringify(el.color_hexes)}`);
    }

    return NextResponse.json({ elements: elements ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/identify]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
