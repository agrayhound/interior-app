import { NextResponse } from "next/server";
import crypto from "crypto";

export const dynamic = "force-dynamic";

export async function GET() {
  const clientId = process.env.PINTEREST_CLIENT_ID;
  const redirectUri = process.env.PINTEREST_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return NextResponse.json({ error: "Pinterest OAuth not configured" }, { status: 500 });
  }

  const state = crypto.randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "boards:read,pins:read",
    state,
  });

  const response = NextResponse.redirect(
    `https://www.pinterest.com/oauth/?${params.toString()}`
  );

  // Store state in a short-lived cookie for CSRF validation
  response.cookies.set("pinterest_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600, // 10 minutes
    path: "/",
  });

  return response;
}
