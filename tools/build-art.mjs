#!/usr/bin/env node
/**
 * Turns art masters into the web assets the app loads.
 *
 * Masters are 1–3 MB PNGs. Shipping those to a browser would put more bytes in
 * one faction plate than in the whole application bundle, so what goes in the
 * repository is the web build: WebP, sized for where each image is actually
 * shown.
 *
 * There are two kinds of master and they come from different places.
 *
 * **Delivered** — the card art in the visual pack. It lives outside the
 * repository: it is the source a designer edits, it changes rarely, and
 * committing the pack would make every clone pay for files no build reads.
 * Point `--from` at it. Each of these is a finished card *render*, so what is
 * taken from it is the illustration in the middle; the application draws its
 * own frame.
 *
 * **Generated** — everything `tools/art/generate.mjs` makes, under
 * `tools/art/out`. Faction plates and card illustrations, drawn from the roster
 * and the card catalog and from no third-party mark. That is where the faction
 * art comes from now: eight of the ten delivered faction dossiers carry the
 * real corporate mark of the company behind the ticker, and §7.10 of the visual
 * guide is explicit that those are shorthand in concept art and *"not cleared
 * production assets"*. They are not built, and this file is not the place that
 * decision is enforced — `generate.mjs` never names a company in a prompt.
 *
 * A group whose source is missing is skipped with a line saying so, rather than
 * failing the run: someone with the generator and no visual pack should still
 * be able to build, and so should the reverse.
 *
 * Not part of `verify.sh`. It needs inputs CI does not have, and a gate that
 * cannot run is worse than one that does not exist — the generated assets are
 * committed, so CI checks the thing that ships.
 */
import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'apps', 'web', 'public', 'art');

const fromFlag = process.argv.indexOf('--from');
const delivered =
  fromFlag >= 0
    ? (process.argv[fromFlag + 1] ?? '')
    : join(root, '..', 'PonsWars_private_bundle', '03_Visual_Pack');

/** Where `generate.mjs` writes. Always in the tree, never in the repository. */
const generated = join(root, 'tools', 'art', 'out');

/**
 * The window an illustration is cut out of a delivered card master.
 *
 * Each master is a finished card render — frame, rarity banner, name plate,
 * charge count — photographed on a floor. The application draws its own frame
 * for all fourteen cards in the pool, so putting a whole rendered card inside
 * it produced a card inside a card, with the name and the charge count printed
 * twice at two sizes. What is wanted from the master is the illustration.
 *
 * Fractions rather than pixels: the three masters share one template at one
 * size, and a fraction survives a redelivery at a different one.
 */
const CARD_ART_WINDOW = { left: 0.182, right: 0.845, top: 0.145, bottom: 0.628 };

/**
 * What each group is for, and therefore how large it needs to be.
 *
 * Sized by use rather than uniformly. A faction plate is read across a dossier
 * header and a card illustration sits in a window a quarter that wide; giving
 * both the same width would make one soft and the other wasteful.
 */
const GROUPS = [
  {
    label: 'delivered cards',
    dir: join(delivered, '02_Cards'),
    match: /\.png$/,
    name: (file) => `card-art-${basename(file, '.png').replace(/^\d+[a-z]?_/, '')}.webp`,
    width: 560,
    quality: 84,
    crop: CARD_ART_WINDOW,
  },
  {
    label: 'generated faction plates',
    dir: generated,
    match: /^faction-.*\.png$/,
    name: (file) => `${basename(file, '.png')}.webp`,
    width: 960,
    quality: 82,
    crop: null,
  },
  {
    label: 'generated card illustrations',
    dir: generated,
    match: /^card-.*\.png$/,
    name: (file) => `card-art-${basename(file, '.png').replace(/^card-/, '')}.webp`,
    width: 560,
    quality: 84,
    crop: null,
  },
];

mkdirSync(out, { recursive: true });

let written = 0;
let bytes = 0;

for (const group of GROUPS) {
  if (!existsSync(group.dir)) {
    console.log(`  ${group.label}: nothing at ${group.dir}, skipped`);
    continue;
  }

  const files = readdirSync(group.dir)
    .filter((name) => group.match.test(name))
    .sort();
  if (files.length === 0) {
    console.log(`  ${group.label}: no masters, skipped`);
    continue;
  }

  for (const file of files) {
    const target = join(out, group.name(file));

    let image = sharp(join(group.dir, file));
    if (group.crop !== null) {
      const { width, height } = await image.metadata();
      if (width === undefined || height === undefined) {
        console.error(`Could not read the size of ${file}`);
        process.exit(1);
      }
      image = image.extract({
        left: Math.round(group.crop.left * width),
        top: Math.round(group.crop.top * height),
        width: Math.round((group.crop.right - group.crop.left) * width),
        height: Math.round((group.crop.bottom - group.crop.top) * height),
      });
    }

    const info = await image
      .resize({ width: group.width, withoutEnlargement: true })
      .webp({ quality: group.quality })
      .toFile(target);

    written += 1;
    bytes += info.size;
    console.log(`  ${group.name(file).padEnd(46)} ${(info.size / 1024).toFixed(0).padStart(5)} KB`);
  }
}

console.log(`
${String(written)} assets, ${(bytes / 1024 / 1024).toFixed(1)} MB total`);
