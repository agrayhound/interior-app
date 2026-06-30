import { NextRequest, NextResponse } from "next/server";
import { writeFileSync } from "fs";
import { join } from "path";

// Debug-only endpoint: saves the received base64 crop to disk so we can
// inspect exactly what was transmitted in the network request.
export async function POST(req: NextRequest) {
  try {
    const { imageData } = await req.json();
    if (!imageData) return NextResponse.json({ error: "imageData required" }, { status: 400 });

    const m = imageData.match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (!m) return NextResponse.json({ error: "invalid data URL" }, { status: 400 });

    const ext = m[1].split("/")[1];
    const buf = Buffer.from(m[2], "base64");
    const outPath = join(process.cwd(), `debug_crop_sent.${ext}`);
    writeFileSync(outPath, buf);

    console.log(`[debug-save] wrote ${buf.length} bytes to ${outPath}`);
    return NextResponse.json({ saved: outPath, bytes: buf.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[debug-save]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
