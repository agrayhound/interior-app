import { cookies } from "next/headers";
import PinterestClient from "@/components/PinterestClient";

export const dynamic = "force-dynamic";

export default async function PinterestPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const cookieStore = cookies();
  const connected = !!cookieStore.get("pinterest_access_token")?.value;
  const error = searchParams.error;

  return <PinterestClient connected={connected} oauthError={error} />;
}
