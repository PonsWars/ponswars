# Generated art

The faction plates and most of the card illustrations in this product are
generated locally rather than drawn by hand or taken from the delivered visual
pack. This is how that works, and what has to be true before an image ships.

## Why it is generated at all

The delivered pack has a faction dossier for each of the ten. Eight of them
carry the real corporate mark of the company behind the ticker — Apple,
Microsoft, Tesla, Meta, Amazon, Google, AMD, and GameStop's wordmark. §7.10 of
the visual guide is explicit that these are shorthand in concept art and **not
cleared production assets**, so none of them is built or shipped.

Two of ten carrying original emblems is not a faction art system. So the art is
made instead.

## The pipeline

| Step | What runs                      | Where it writes                      |
| ---- | ------------------------------ | ------------------------------------ |
| 1    | `comfy launch --background`    | a ComfyUI server on `127.0.0.1:8188` |
| 2    | `node tools/art/generate.mjs`  | PNG masters in `tools/art/out/`      |
| 3    | **review** (below)             | nothing — this is a person looking   |
| 4    | `node tools/build-art.mjs`     | WebP in `apps/web/public/art/`       |
| 5    | `apps/web/src/art/manifest.ts` | maps a domain value to a file        |

`tools/art/out/` is ignored by git. Masters stay out of the repository for the
same reason the delivered ones do: they are large, they change rarely, and no
build reads them.

Steps 2 and 4 are not part of `verify.sh`. They need a GPU and inputs CI does
not have, and a gate that cannot run is worse than one that does not exist. The
built assets are committed, so CI checks the thing that ships.

## The rule the generator keeps

**No prompt names a company.**

Every faction prompt is composed inside `promptFor` from the roster in
`@ponswars/shared-types` — the legion's name, the identity line and the momentum
signature §39 locks. The ticker is used as a filename and never as a word in a
prompt. There is no path through that function by which a model is asked for a
brand, which is the only version of this rule worth having: a habit is
forgettable, a function signature is not.

Every prompt also carries a negative asking for no text, no letters, no
watermark, no logo, no wordmark, no trademark. A diffusion model asked for a war
camp with banners will invent a wordmark to put on the banners if nothing stops
it.

## Review before committing

The negative prompt reduces the problem; it does not remove it. Look at every
image before running `build-art.mjs`, and check:

1. **No readable text anywhere.** Signage, banners, hull markings, crates.
   Invented glyphs are fine; anything that reads as a word is not.
2. **No mark resembling a real company's.** The obvious failure is a fruit, four
   coloured squares, a rounded "a" with an arrow. The subtle one is a silhouette
   that is _nearly_ one of those.
3. **No recognisable person.** The negative prompt refuses faces and portraits;
   check it worked.
4. **It looks like this product.** §36 fixes the art direction — dark, matte,
   restrained accents. An image that is bright, glossy or busy is a wrong image
   even if it is a good one.

An image that fails any of these gets regenerated:

```bash
node tools/art/generate.mjs --only nvda --force
```

Reruns use a fresh random seed, so a second attempt is a different image rather
than the same one again.

## Reproducing a set

The model, the workflow and the prompts are all in the repository —
`tools/art/sdxl-plate.json` and `tools/art/generate.mjs` — but the seeds are
not: each run picks new ones. That is deliberate. These are art assets reviewed
by a person and then committed, not a computation whose output has to match; the
committed WebP is the artifact, and the master behind it is a step on the way.

If a specific image ever needs to be reproduced exactly, the seed is in the
ComfyUI history for that job and can be pinned in the workflow.

## Model

SDXL base 1.0, run locally. Nothing is sent to a third-party service, and no
image in this product was generated from a prompt containing a company name, a
brand, or an artist's name.
