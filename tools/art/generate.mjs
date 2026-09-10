#!/usr/bin/env node
/**
 * Generates the original art the product ships with.
 *
 * The delivered visual pack has faction dossiers in it, and eight of the ten
 * carry the real corporate mark of the company behind the ticker — §7.10 of
 * the visual guide is explicit that those are shorthand in concept art and
 * *"not cleared production assets"*. So the art here is made rather than
 * borrowed.
 *
 * ## The rule this file exists to keep
 *
 * **No prompt mentions a company.** Every faction prompt is composed from the
 * roster in `@ponswars/shared-types` — the legion's name, the identity line and
 * the momentum signature §39 locks — and from the shared style. The ticker is
 * used as a filename and never as a word in a prompt, so there is no path by
 * which a model is asked for a brand. That is a property of `promptFor` rather
 * than a habit, which is the only version of it worth having.
 *
 * The negative prompt refuses text and marks on every image, because a
 * diffusion model will happily invent a logo on a banner if nothing stops it.
 * Generated images are still reviewed before they are committed — see
 * `docs/operations/generated-art.md`.
 *
 * ## Running it
 *
 * Needs a ComfyUI server. `comfy launch --background` starts one; this talks to
 * it over the same REST API the browser UI uses.
 *
 *     node tools/art/generate.mjs                # everything not already made
 *     node tools/art/generate.mjs --only nvda    # one faction
 *     node tools/art/generate.mjs --force        # remake, even if it exists
 *
 * Outputs land in `tools/art/out/` as PNG. They are not the shipped asset:
 * `build-art.mjs` is what turns a master into the WebP the app loads, and
 * these masters stay out of the repository like the delivered ones do.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVE_TICKERS, CARD_CATALOG, FACTIONS } from '../../packages/shared-types/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'tools', 'art', 'out');
const workflowPath = join(root, 'tools', 'art', 'sdxl-plate.json');
const host = process.env['COMFY_HOST'] ?? 'http://127.0.0.1:8188';

/**
 * The look every plate shares.
 *
 * §36 fixes the art direction — dark, cinematic, restrained accents, matte
 * industrial materials — and repeating it on every prompt is what makes ten
 * separate generations read as one product rather than ten pictures.
 */
const STYLE =
  'dark cinematic science fiction concept art, matte industrial metal, ' +
  'volumetric haze, restrained lighting, deep shadow, cold key light, ' +
  'high detail, painterly, wide establishing shot';

/**
 * What must never appear.
 *
 * The first three entries are the important ones. A diffusion model asked for a
 * banner will invent a wordmark to put on it, and an invented wordmark on a
 * faction standard is exactly the thing §7.10 rules out.
 */
const FORBIDDEN =
  'text, letters, words, numbers, watermark, signature, logo, wordmark, ' +
  'brand, corporate mark, trademark, ui, hud, interface, frame, border, ' +
  'human face, portrait, blurry, low detail, cartoon, cute, oversaturated';

/**
 * The cards that came with an illustration.
 *
 * Not the authority on it — `apps/web/src/art/manifest.ts` is, and it points at
 * the files `build-art.mjs` cuts out of the masters. This list exists so a run
 * does not spend two minutes drawing something nothing will load.
 */
const PAINTED = new Set(['REINFORCEMENT', 'GOLDEN_ARMY', 'SECRET_STOCK_DROP']);

/** One image to make. */
function plates() {
  const made = [];

  for (const ticker of ACTIVE_TICKERS) {
    const faction = FACTIONS[ticker];
    made.push({
      name: `faction-${ticker.toLowerCase()}`,
      width: 1216,
      height: 832,
      // The legion, its own words, and the world it fights in. No ticker.
      prompt:
        `a war camp of the ${faction.name} on a floating fortress island in deep space, ` +
        `${faction.identity} ${faction.momentumSignature}. ` +
        `armoured vehicles and marching ranks on a terraced plateau, tall banners on masts, ` +
        `glowing light strips along the decks, ragged rock underside, ${STYLE}`,
    });
  }

  for (const card of Object.values(CARD_CATALOG)) {
    if (PAINTED.has(card.type)) {
      // Already has an illustration in the delivered pack. `art/manifest.ts` is
      // what decides which cards use painted art; this only avoids spending a
      // generation on one that will not be looked at.
      continue;
    }
    made.push({
      name: `card-${card.type.toLowerCase()}`,
      // Square-ish, because it goes in the card's art window.
      width: 1024,
      height: 896,
      prompt:
        `${card.visualSignature} on a futuristic battlefield, seen from above and behind, ` +
        `armoured units and industrial structures, ${STYLE}`,
    });
  }

  return made;
}

function nodeByClass(workflow, classType) {
  const found = Object.entries(workflow).find(([, node]) => node.class_type === classType);
  if (found === undefined) {
    throw new Error(`The workflow has no ${classType} node`);
  }
  return found[0];
}

async function submit(workflow) {
  const response = await fetch(`${host}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });
  if (!response.ok) {
    throw new Error(`ComfyUI refused the job: ${String(response.status)} ${await response.text()}`);
  }
  const body = await response.json();
  return body.prompt_id;
}

/**
 * Waits for one job and returns what it wrote.
 *
 * Polls rather than opening a socket: this makes at most a few dozen images in
 * a run, and a poll loop has no reconnection story to get wrong.
 */
async function collect(promptId) {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const response = await fetch(`${host}/history/${promptId}`);
    const history = await response.json();
    const entry = history[promptId];
    if (entry !== undefined) {
      if (entry.status?.status_str === 'error') {
        throw new Error(`ComfyUI failed the job: ${JSON.stringify(entry.status.messages)}`);
      }
      const images = Object.values(entry.outputs ?? {}).flatMap((node) => node.images ?? []);
      if (images.length > 0) {
        return images;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('ComfyUI did not finish within fifteen minutes');
}

async function download(image, target) {
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder ?? '',
    type: image.type ?? 'output',
  });
  const response = await fetch(`${host}/view?${query.toString()}`);
  if (!response.ok) {
    throw new Error(`Could not read ${image.filename}: ${String(response.status)}`);
  }
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
}

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]?.toLowerCase()
  : null;
const force = process.argv.includes('--force');

const template = JSON.parse(readFileSync(workflowPath, 'utf8'));
const sampler = nodeByClass(template, 'KSampler');
const latent = nodeByClass(template, 'EmptyLatentImage');
// The positive prompt is the encoder the sampler takes as `positive`; the other
// one is the negative. Reading it from the graph rather than assuming a node id
// means a re-exported workflow does not silently swap them.
const positive = template[sampler].inputs.positive[0];
const negative = template[sampler].inputs.negative[0];

mkdirSync(out, { recursive: true });

let made = 0;
for (const plate of plates()) {
  if (only !== null && !plate.name.includes(only)) {
    continue;
  }
  const target = join(out, `${plate.name}.png`);
  if (existsSync(target) && !force) {
    console.log(`  ${plate.name.padEnd(34)} exists`);
    continue;
  }

  const workflow = structuredClone(template);
  workflow[positive].inputs.text = plate.prompt;
  workflow[negative].inputs.text = FORBIDDEN;
  workflow[latent].inputs.width = plate.width;
  workflow[latent].inputs.height = plate.height;
  workflow[sampler].inputs.seed = Math.floor(Math.random() * 2 ** 48);
  workflow[sampler].inputs.steps = 30;
  workflow[sampler].inputs.cfg = 6.5;

  process.stdout.write(`  ${plate.name.padEnd(34)} `);
  const images = await collect(await submit(workflow));
  const first = images[0];
  if (first === undefined) {
    throw new Error(`${plate.name} produced no image`);
  }
  await download(first, target);
  made += 1;
  console.log('done');
}

console.log(`\n${String(made)} generated, in ${out}`);
