import { NextResponse } from "next/server";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete("pinterest_access_token");
  response.cookies.delete("pinterest_refresh_token");
  return response;
}
