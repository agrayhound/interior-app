// Singletons — loaded once, reused across requests.
let _model: Awaited<ReturnType<typeof import("@xenova/transformers")["CLIPVisionModelWithProjection"]["from_pretrained"]>> | null = null;
let _processor: Awaited<ReturnType<typeof import("@xenova/transformers")["AutoProcessor"]["from_pretrained"]>> | null = null;

async function getModel() {
  if (!_model || !_processor) {
    const { CLIPVisionModelWithProjection, AutoProcessor, env } = await import("@xenova/transformers");
    env.cacheDir = "/tmp/transformers";
    [_processor, _model] = await Promise.all([
      AutoProcessor.from_pretrained("Xenova/clip-vit-base-patch32"),
      // quantized: false → loads model.onnx (fp32) instead of model_quantized.onnx (int8)
      // Required for cosine compatibility with the Python-generated product embeddings.
      CLIPVisionModelWithProjection.from_pretrained("Xenova/clip-vit-base-patch32", { quantized: false }),
    ]);
  }
  return { model: _model!, processor: _processor! };
}

/**
 * Embed an image URL using CLIP's vision encoder + projection head.
 *
 * Uses CLIPVisionModelWithProjection directly — identical to the Python path:
 *   model.get_image_features() → pooler_output → visual_projection → L2 norm
 * Returns a 512-dim L2-normalised vector compatible with stored product embeddings.
 */
export async function embedImageUrl(imageUrl: string): Promise<number[]> {
  const { model, processor } = await getModel();
  const { RawImage } = await import("@xenova/transformers");

  const image = await RawImage.fromURL(imageUrl);
  const inputs = await processor(image);
  const { image_embeds } = await model(inputs);

  // image_embeds is already the projected 512-dim output (equivalent to
  // get_image_features() in PyTorch). L2-normalise to unit sphere.
  const data = Array.from(image_embeds.data as Float32Array);
  const norm = Math.sqrt(data.reduce((s, v) => s + v * v, 0));
  return data.map(v => v / norm);
}
