import modal

app = modal.App("clip-embedder")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("transformers", "torch", "Pillow", "requests", "fastapi")
)

@app.cls(
    image=image,
    gpu=None,
    memory=2048,
    min_containers=1,
)
class CLIPEmbedder:
    @modal.enter()
    def load(self):
        from transformers import CLIPProcessor, CLIPVisionModelWithProjection
        self.model = CLIPVisionModelWithProjection.from_pretrained("openai/clip-vit-base-patch32")
        self.model.eval()
        self.processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")

    @modal.method()
    def embed(self, image_url: str) -> list[float]:
        import torch
        import requests
        from PIL import Image
        from io import BytesIO

        resp = requests.get(image_url, timeout=15)
        resp.raise_for_status()
        image = Image.open(BytesIO(resp.content)).convert("RGB")

        inputs = self.processor(images=image, return_tensors="pt")
        with torch.no_grad():
            outputs = self.model(**inputs)

        embeds = outputs.image_embeds[0]
        embeds = embeds / embeds.norm()
        return embeds.tolist()


@app.function(image=image)
@modal.fastapi_endpoint(method="POST")
def embed_endpoint(body: dict) -> dict:
    image_url = body.get("imageUrl")
    if not image_url:
        return {"error": "imageUrl required"}
    try:
        vector = CLIPEmbedder().embed.remote(image_url)
        return {"embedding": vector}
    except Exception as e:
        return {"error": str(e)}
