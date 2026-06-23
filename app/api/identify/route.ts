import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const IDENTIFY_PROMPT = `Analyze this interior design image and identify all distinct surface materials and finishes visible. For each element return: a short label, the material type, colors, finish, and which category it belongs to (tile, stone, wood, concrete, plaster, fabric, metal, glass). Return JSON: { "elements": [{ "id": "<short-id>", "label": "<descriptive label>", "material": "<material>", "colors": ["<color1>", "<color2>"], "finish": "<finish>", "category": "<category>", "is_tile": <true|false> }] }. Focus on surfaces a designer might want to source — tiles, stone, wood flooring, countertops. Ignore people, plants, small objects. Return ONLY the JSON object, no markdown, no explanation.`;

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

export async function POST(req: NextRequest) {
  try {
    const { imageUrl } = await req.json();
    if (!imageUrl) {
      return NextResponse.json({ error: "imageUrl required" }, { status: 400 });
    }

    const { base64, mediaType } = await fetchImageAsBase64(imageUrl);

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

    return NextResponse.json({ elements: elements ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/identify]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
