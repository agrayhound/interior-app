-- Step 1: Add CLIP embedding column to product_embeddings (512-dim)
ALTER TABLE product_embeddings ADD COLUMN IF NOT EXISTS clip_embedding vector(512);

-- Step 2: Index for CLIP similarity search
CREATE INDEX IF NOT EXISTS product_embeddings_clip_idx
  ON product_embeddings USING ivfflat (clip_embedding vector_cosine_ops)
  WITH (lists = 100);

-- Step 3: Hybrid search RPC
CREATE OR REPLACE FUNCTION search_similar_tiles_hybrid(
  query_embedding      vector(1536),
  query_clip_embedding vector(512),
  match_count          int DEFAULT 10
)
RETURNS TABLE (
  id              bigint,
  name            text,
  sku             text,
  source_url      text,
  thumbnail_url   text,
  price_cad_min   numeric,
  supplier_id     text,
  style_tags      text[],
  material_look   text,
  color_palette   text[],
  similarity      float,
  semantic_score  float,
  clip_score      float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    p.id,
    p.name,
    p.sku,
    p.source_url,
    p.thumbnail_url,
    p.price_cad_min,
    p.supplier_id,
    p.style_tags,
    p.material_look,
    p.color_palette,
    CASE
      WHEN pe.clip_embedding IS NOT NULL
        THEN 0.6 * (1 - (pe.embedding <=> query_embedding))
           + 0.4 * (1 - (pe.clip_embedding <=> query_clip_embedding))
      ELSE (1 - (pe.embedding <=> query_embedding))
    END AS similarity,
    (1 - (pe.embedding <=> query_embedding))  AS semantic_score,
    CASE
      WHEN pe.clip_embedding IS NOT NULL
        THEN (1 - (pe.clip_embedding <=> query_clip_embedding))
      ELSE NULL
    END AS clip_score
  FROM product_embeddings pe
  JOIN products p ON p.id = pe.product_id
  WHERE p.thumbnail_url IS NOT NULL
  ORDER BY similarity DESC
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION search_similar_tiles_hybrid TO service_role, anon, authenticated;
