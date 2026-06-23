#!/usr/bin/env python3
"""
Compare true CLIP image embedding vs the Haiku text-proxy approach
for the hybrid search query side.
"""
import asyncio, base64, io, sys, time
import torch
from PIL import Image
from transformers import CLIPModel, CLIPProcessor
import httpx, openai, anthropic

SUPABASE_URL = "https://dnghimclwgjmtnesxdmo.supabase.co"
SUPA_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRuZ2hpbWNsd2dqbXRuZXN4ZG1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTAyOTA5NCwiZXhwIjoyMDk2NjA1MDk0fQ.pkSlai_x2w347sDFgwne0GViYu4bXtWPpTkK-cdFi2M"
OAI_KEY   = "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"
ANT_KEY   = "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"

HEADERS = {"apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Content-Type": "application/json"}

TEST_URL = sys.argv[1] if len(sys.argv) > 1 else \
    "https://stone-tile.com/media/catalog/product/c/o/concrete-mosaic.jpg"

ELEMENT = {"label": "Concrete Mosaic Tiles", "material": "concrete",
           "colors": ["grey", "charcoal"], "finish": "matte", "category": "tile"}
CLIP_MODEL_ID = "openai/clip-vit-base-patch32"


def load_clip():
    print("Loading " + CLIP_MODEL_ID + "...")
    m = CLIPModel.from_pretrained(CLIP_MODEL_ID)
    p = CLIPProcessor.from_pretrained(CLIP_MODEL_ID)
    m.eval()
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    return m.to(dev), p, dev


def true_clip(model, proc, device, img):
    inp = proc(images=img, return_tensors="pt").to(device)
    with torch.no_grad():
        f = model.get_image_features(**inp)
        f = f / f.norm(dim=-1, keepdim=True)
    return f[0].cpu().tolist()


async def proxy_clip(img):
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    el = ELEMENT
    prompt = (
        "Describe only the " + el["label"] + " surface ("
        + el["material"] + ", " + ", ".join(el["colors"]) + ", " + el["finish"] + " finish) "
        "visible in this image. Focus on: texture, pattern, sheen, grout lines if any, "
        "scale, and exact color nuances. One dense paragraph, no intro sentence."
    )
    ac = anthropic.AsyncAnthropic(api_key=ANT_KEY)
    msg = await ac.messages.create(
        model="claude-haiku-4-5-20251001", max_tokens=256,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
            {"type": "text", "text": prompt},
        ]}],
    )
    desc = msg.content[0].text.strip()
    print("\n  Haiku description: " + desc[:120] + "...")
    oc = openai.AsyncOpenAI(api_key=OAI_KEY)
    emb = await oc.embeddings.create(model="text-embedding-3-small", input=desc, dimensions=512)
    return emb.data[0].embedding


async def text_embed(text):
    oc = openai.AsyncOpenAI(api_key=OAI_KEY)
    r = await oc.embeddings.create(model="text-embedding-3-small", input=text)
    return r.data[0].embedding


async def hybrid_search(client, text_vec, clip_vec):
    r = await client.post(
        SUPABASE_URL + "/rest/v1/rpc/search_similar_tiles_hybrid", headers=HEADERS,
        json={"query_embedding": text_vec, "query_clip_embedding": clip_vec, "match_count": 10},
    )
    r.raise_for_status()
    return r.json()


def cosine_sim(a, b):
    import math
    dot = sum(x*y for x,y in zip(a,b))
    return dot / (math.sqrt(sum(x*x for x in a)) * math.sqrt(sum(x*x for x in b)) + 1e-9)


async def main():
    print("\nTest image : " + TEST_URL)
    print("Element    : " + ELEMENT["label"] + "\n")

    model, proc, device = load_clip()

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(TEST_URL, follow_redirects=True)
        r.raise_for_status()
        img = Image.open(io.BytesIO(r.content)).convert("RGB")
        print("Image size : " + str(img.size))

        embed_text = (
            "Material: " + ELEMENT["material"] + ". "
            "Colors: " + ", ".join(ELEMENT["colors"]) + ". "
            "Finish: " + ELEMENT["finish"] + ". "
            "Category: " + ELEMENT["category"] + ". "
            "Label: " + ELEMENT["label"] + "."
        )
        print("Embed text : " + embed_text + "\n")

        t0 = time.monotonic()
        true_vec = true_clip(model, proc, device, img)
        t_true = time.monotonic() - t0
        print("True CLIP  : " + str(len(true_vec)) + "-dim  (" + str(round((t_true)*1000)) + " ms)")

        t0 = time.monotonic()
        proxy_vec = await proxy_clip(img)
        t_proxy = time.monotonic() - t0
        print("Haiku proxy: " + str(len(proxy_vec)) + "-dim  (" + str(round(t_proxy*1000)) + " ms)")

        t0 = time.monotonic()
        text_vec = await text_embed(embed_text)
        t_text = time.monotonic() - t0
        print("Text embed : " + str(len(text_vec)) + "-dim  (" + str(round(t_text*1000)) + " ms)")

        sim = cosine_sim(true_vec, proxy_vec)
        print("\nCosine similarity (true CLIP vs Haiku proxy): " + str(round(sim, 4)))

        print("\nRunning searches...")
        true_results, proxy_results = await asyncio.gather(
            hybrid_search(client, text_vec, true_vec),
            hybrid_search(client, text_vec, proxy_vec),
        )

        print("\n" + "=" * 92)
        print("TRUE CLIP (image → CLIP model)".center(45) + " | " + "HAIKU PROXY (image → describe → embed)".center(45))
        print("=" * 92)
        for i in range(max(len(true_results), len(proxy_results))):
            t = true_results[i]  if i < len(true_results)  else None
            p = proxy_results[i] if i < len(proxy_results) else None
            def fmt(r, idx):
                if not r: return " " * 45
                return str(idx+1).rjust(2) + ". " + r["name"][:24].ljust(24) + " " + \
                    str(round(float(r["similarity"])*100, 1)).rjust(5) + "%" + \
                    " (clip=" + str(round(float(r.get("clip_score") or 0)*100)) + "%)"
            print(fmt(t, i) + " | " + fmt(p, i))
        print("=" * 92)

        true_rank  = {r["id"]: i for i, r in enumerate(true_results)}
        proxy_rank = {r["id"]: i for i, r in enumerate(proxy_results)}
        all_ids = set(true_rank) | set(proxy_rank)
        moved = sorted(
            (proxy_rank.get(pid, 10) - true_rank.get(pid, 10), pid,
             next((r["name"] for r in true_results  if r["id"] == pid),
              next((r["name"] for r in proxy_results if r["id"] == pid), "?")))
            for pid in all_ids
        )
        print("\nRank shifts (proxy vs true CLIP, negative = demoted by proxy):")
        for delta, pid, name in moved:
            if delta != 0:
                print("  " + ("+" if delta > 0 else "") + str(delta) + "  " + name[:50])


if __name__ == "__main__":
    asyncio.run(main())
