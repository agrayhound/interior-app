import { NextRequest, NextResponse } from "next/server";

const API_BASE = "https://api.pinterest.com/v5";

async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  const clientId = process.env.PINTEREST_CLIENT_ID;
  const clientSecret = process.env.PINTEREST_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch("https://api.pinterest.com/v5/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

async function pinterestFetch(
  url: string,
  token: string
): Promise<Response> {
  return fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
}

// GET /api/pinterest?action=boards
// GET /api/pinterest?action=pins&boardId=xxx&bookmark=xxx
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const action = searchParams.get("action");

  // Prefer user OAuth token from cookie; fall back to test token
  let token =
    req.cookies.get("pinterest_access_token")?.value ??
    process.env.PINTEREST_TEST_TOKEN;
  const refreshToken = req.cookies.get("pinterest_refresh_token")?.value;

  if (!token) {
    return NextResponse.json({ error: "Not connected to Pinterest", unauthenticated: true }, { status: 401 });
  }

  async function callApi(url: string) {
    let res = await pinterestFetch(url, token!);

    // On 401, attempt token refresh
    if (res.status === 401 && refreshToken) {
      const newToken = await refreshAccessToken(refreshToken);
      if (newToken) {
        token = newToken;
        res = await pinterestFetch(url, newToken);
      }
    }

    return res;
  }

  try {
    if (action === "boards") {
      const res = await callApi(`${API_BASE}/boards?page_size=50`);
      const data = await res.json();
      if (!res.ok) {
        return NextResponse.json(
          { error: data.message ?? "Pinterest API error", code: data.code },
          { status: res.status }
        );
      }

      // If we refreshed the token, set the new one on the response cookie
      const nextRes = NextResponse.json(data);
      if (token !== req.cookies.get("pinterest_access_token")?.value) {
        nextRes.cookies.set("pinterest_access_token", token, {
          httpOnly: true, secure: true, sameSite: "lax",
          maxAge: 60 * 60 * 24 * 30, path: "/",
        });
      }
      return nextRes;
    }

    if (action === "pins") {
      const boardId = searchParams.get("boardId");
      if (!boardId) return NextResponse.json({ error: "boardId required" }, { status: 400 });
      const bookmark = searchParams.get("bookmark");
      const url = bookmark
        ? `${API_BASE}/boards/${boardId}/pins?page_size=50&bookmark=${bookmark}`
        : `${API_BASE}/boards/${boardId}/pins?page_size=50`;
      const res = await callApi(url);
      const data = await res.json();
      if (!res.ok) {
        return NextResponse.json(
          { error: data.message ?? "Pinterest API error", code: data.code },
          { status: res.status }
        );
      }

      const nextRes = NextResponse.json(data);
      if (token !== req.cookies.get("pinterest_access_token")?.value) {
        nextRes.cookies.set("pinterest_access_token", token, {
          httpOnly: true, secure: true, sameSite: "lax",
          maxAge: 60 * 60 * 24 * 30, path: "/",
        });
      }
      return nextRes;
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
