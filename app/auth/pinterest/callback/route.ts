import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  const storedState = req.cookies.get("pinterest_oauth_state")?.value;

  const clientId = process.env.PINTEREST_CLIENT_ID;
  const clientSecret = process.env.PINTEREST_CLIENT_SECRET;
  const redirectUri = process.env.PINTEREST_REDIRECT_URI;

  const baseUrl = new URL(req.url).origin;

  if (error) {
    return NextResponse.redirect(`${baseUrl}/pinterest?error=${encodeURIComponent(error)}`);
  }

  if (!state || state !== storedState) {
    return NextResponse.redirect(`${baseUrl}/pinterest?error=invalid_state`);
  }

  if (!code) {
    return NextResponse.redirect(`${baseUrl}/pinterest?error=no_code`);
  }

  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.redirect(`${baseUrl}/pinterest?error=misconfigured`);
  }

  try {
    const tokenRes = await fetch("https://api.pinterest.com/v5/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      const msg = tokenData.message ?? tokenData.error ?? "Token exchange failed";
      return NextResponse.redirect(`${baseUrl}/pinterest?error=${encodeURIComponent(msg)}`);
    }

    const { access_token, refresh_token } = tokenData;

    const response = NextResponse.redirect(`${baseUrl}/pinterest`);

    // Clear the CSRF state cookie
    response.cookies.delete("pinterest_oauth_state");

    // Store access token (30-day expiry per Pinterest docs)
    response.cookies.set("pinterest_access_token", access_token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
    });

    if (refresh_token) {
      response.cookies.set("pinterest_refresh_token", refresh_token, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 365,
        path: "/",
      });
    }

    return response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.redirect(`${baseUrl}/pinterest?error=${encodeURIComponent(msg)}`);
  }
}
