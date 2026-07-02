import { NextRequest, NextResponse } from "next/server";

// Pinterest serves an empty SPA shell to normal browser UAs. Social crawlers
// like Facebook's get server-rendered HTML with og:image meta tags.
const CRAWLER_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

function isPinterestPinUrl(u: string): boolean {
  try {
    const p = new URL(u);
    if (p.host === "pin.it") return p.pathname.length > 1;
    if (/^([a-z]{2,3}\.)?pinterest\.com$/i.test(p.host)) return p.pathname.startsWith("/pin/");
    return false;
  } catch {
    return false;
  }
}

function extractOgImage(html: string): string | null {
  // Attribute order varies on Pinterest — match property="og:image" AND find its content attribute independently.
  const metaTags = html.match(/<meta[^>]*og:image(?:")[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    if (/og:image:(width|height|type|alt|secure_url)/i.test(tag)) continue;
    const contentMatch = tag.match(/content=["']([^"']+)["']/i);
    if (contentMatch) return contentMatch[1];
  }
  return null;
}

export async function POST(req: NextRequest) {
  const { url } = (await req.json().catch(() => ({}))) as { url?: string };
  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }
  if (!isPinterestPinUrl(url)) {
    return NextResponse.json({ error: "Not a Pinterest pin URL" }, { status: 400 });
  }

  try {
    const res = await fetch(url, {
      headers: { "user-agent": CRAWLER_UA, accept: "text/html" },
      redirect: "follow",
    });
    if (!res.ok) {
      return NextResponse.json({ error: `Pinterest returned ${res.status}` }, { status: 502 });
    }
    const html = await res.text();
    const imageUrl = extractOgImage(html);
    if (!imageUrl) {
      return NextResponse.json({ error: "Could not extract image from Pinterest page" }, { status: 502 });
    }
    return NextResponse.json({ imageUrl, resolvedFrom: res.url });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to fetch Pinterest URL" },
      { status: 502 },
    );
  }
}
