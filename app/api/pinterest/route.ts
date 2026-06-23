import { NextRequest, NextResponse } from "next/server";

const PINTEREST_TOKEN = process.env.PINTEREST_TEST_TOKEN;
const API_BASE = "https://api.pinterest.com/v5";

const HEADERS = {
  Authorization: `Bearer ${PINTEREST_TOKEN}`,
  "Content-Type": "application/json",
};

// GET /api/pinterest?action=boards
// GET /api/pinterest?action=pins&boardId=xxx&bookmark=xxx
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const action = searchParams.get("action");

  if (!PINTEREST_TOKEN) {
    return NextResponse.json({ error: "PINTEREST_TEST_TOKEN not configured" }, { status: 500 });
  }

  try {
    if (action === "boards") {
      const res = await fetch(`${API_BASE}/boards?page_size=50`, { headers: HEADERS });
      const data = await res.json();
      if (!res.ok) {
        return NextResponse.json(
          { error: data.message ?? "Pinterest API error", code: data.code },
          { status: res.status }
        );
      }
      return NextResponse.json(data);
    }

    if (action === "pins") {
      const boardId = searchParams.get("boardId");
      if (!boardId) return NextResponse.json({ error: "boardId required" }, { status: 400 });
      const bookmark = searchParams.get("bookmark");
      const url = bookmark
        ? `${API_BASE}/boards/${boardId}/pins?page_size=50&bookmark=${bookmark}`
        : `${API_BASE}/boards/${boardId}/pins?page_size=50`;
      const res = await fetch(url, { headers: HEADERS });
      const data = await res.json();
      if (!res.ok) {
        return NextResponse.json(
          { error: data.message ?? "Pinterest API error", code: data.code },
          { status: res.status }
        );
      }
      return NextResponse.json(data);
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
