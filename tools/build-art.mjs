#!/usr/bin/env node
/**
 * Turns the delivered art masters into web assets.
 *
 * The masters are 2–3 MB PNGs at print-ish resolution — 68 MB for the pack.
 * Shipping those to a browser would put more bytes in one faction portrait than
 * in the whole application bundle, so what goes in the repository is the web
 * build: WebP, sized for where each image is actually shown.
 *
 * The masters live outside the repository. That is deliberate rather than an
 * oversight: they are the source a designer edits, they change rarely, and
 * committing 68 MB of them would make every clone pay for files no build reads.
 * Point `--from` at wherever they are and this regenerates everything.
 *
 * Not part of `verify.sh`. It needs inputs CI does not have, and a gate that
 * cannot run is worse than one that does not exist — the generated assets are
 * committed, so CI checks the thing that ships.
 *
 * **The faction dossiers are not built here, and that is the point.** Eight of
 * the ten carry the real corporate mark of the company behind the ticker —
 * Apple, Microsoft, Tesla, Meta, Amazon, Google, AMD, and GameStop's wordmark.
 * §7.10 of the visual guide is explicit that these are shorthand in concept art
 * and *"not cleared production assets"*, and a build step that quietly published
 * them would be the exact mistake that section exists to prevent. Only NVDA and
 * SPY carry original emblems, and art for two factions out of ten is not a
 * faction art system.
 *
 * The cards are original throughout: PonsWars emblem, PonsWars units, no
 * third-party mark anywhere. They are built.
 */
import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'apps', 'web', 'public', 'art');

const fromFlag = process.argv.indexOf('--from');
const source =
  fromFlag >= 0
    ? process.argv[fromFlag + 1]
    : join(root, '..', 'PonsWars_private_bundle', '03_Visual_Pack');

if (source === undefined || !existsSync(source)) {
  console.error(`No art masters at ${String(source)}.`);
  console.error('Pass --from <path to 03_Visual_Pack>.');
  process.exit(1);
}

/**
 * What each group is for, and therefore how large it needs to be.
 *
 * Sized by use rather than uniformly. A faction dossier is read at panel size
 * and a card is held at card size; giving both the same width would make one
 * blurry and the other wasteful.
 */
const GROUPS = [{ dir: '02_Cards', prefix: 'card', width: 720, quality: 82 }];

mkdirSync(out, { recursive: true });

let written = 0;
let bytes = 0;

for (const group of GROUPS) {
  const dir = join(source, group.dir);
  if (!existsSync(dir)) {
    console.error(`Missing ${group.dir} under ${source}`);
    process.exit(1);
  }

  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith('.png'))
    .sort()) {
    const name = `${group.prefix}-${basename(file, '.png').replace(/^\d+[a-z]?_/, '')}.webp`;
    const target = join(out, name);

    const info = await sharp(join(dir, file))
      .resize({ width: group.width, withoutEnlargement: true })
      .webp({ quality: group.quality })
      .toFile(target);

    written += 1;
    bytes += info.size;
    console.log(`  ${name.padEnd(46)} ${(info.size / 1024).toFixed(0).padStart(5)} KB`);
  }
}

console.log(`\n${String(written)} assets, ${(bytes / 1024 / 1024).toFixed(1)} MB total`);
