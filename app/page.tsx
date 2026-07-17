import { Suspense } from "react";
import { getFeaturedTiles } from "@/lib/getFeaturedTiles";
import SearchClient from "@/components/SearchClient";

export const dynamic = "force-dynamic";

export default async function Home() {
  const featured = await getFeaturedTiles();
  return (
    <Suspense>
      <SearchClient featured={featured} />
    </Suspense>
  );
}
