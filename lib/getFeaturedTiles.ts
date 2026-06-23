import { supabase } from "./supabase";

export interface Tile {
  id: number;
  name: string;
  sku: string;
  source_url: string;
  thumbnail_url: string;
  price_cad_min: number;
  supplier_id: string;
  style_tags: string[] | null;
  material_look: string | null;
  color_palette: string[] | null;
}

export async function getFeaturedTiles(): Promise<Tile[]> {
  const { data, error } = await supabase
    .from("products")
    .select("id, name, sku, source_url, thumbnail_url, price_cad_min, supplier_id, style_tags, material_look, color_palette")
    .not("thumbnail_url", "is", null)
    .not("style_tags", "is", null)
    .limit(4);

  if (error) {
    console.error("getFeaturedTiles:", error.message);
    return [];
  }
  return (data ?? []) as Tile[];
}
