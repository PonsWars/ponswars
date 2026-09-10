#!/usr/bin/env node
/**
 * Turns downloaded CC0 source models into the ones the client ships.
 *
 * The world was built entirely from primitives — boxes, cylinders, instanced
 * fields — because there were no models in this repository. Primitives cannot
 * be a mech: a shape that reads as a machine is an *asset*, modelled and
 * rigged, and no amount of arithmetic produces one. These are that asset.
 *
 * ## Where they come from
 *
 * `docs/operations/third-party-models.md` records every source and its licence.
 * Everything here is CC0 — public domain, commercial use, no attribution
 * required — which is the only category that can be used without adding a
 * condition to a repository that is already AGPL-3.0.
 *
 * ## What this does to them, and why
 *
 * A source model is built for a game engine that loads from disk. This one is
 * downloaded over a network before anything can be drawn, so three things get
 * cut:
 *
 *   1. **Animations nobody plays.** Each Quaternius rig ships seventeen clips —
 *      Dance, Hello, Yes, No, Pickup. A war world needs four. Keyframe data is
 *      most of these files, so this is the largest saving by far.
 *   2. **Vertex precision nobody sees.** `quantize` stores positions as 14-bit
 *      integers instead of 32-bit floats. At the distance a unit is seen from
 *      here, the error is far below a pixel.
 *   3. **Anything unreferenced.** `prune` and `dedup` remove what the export
 *      left behind.
 *
 * Not part of `verify.sh`, for the same reason `build-art.mjs` is not: it reads
 * sources CI does not have. The built models are committed, so CI checks the
 * thing that ships.
 *
 *   node tools/build-models.mjs
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, quantize, resample } from '@gltf-transform/functions';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the downloaded packs live. Outside the repository, like the art masters. */
const SOURCES = process.env['PONSWARS_MODEL_SOURCES'] ?? 'C:/Users/W/PonsWars_assets/vendor';

const OUT = join(root, 'apps/web/public/models');

/**
 * The clips a unit is ever asked to play.
 *
 * Idle is what a unit does while a round runs; the rest exist because the
 * battlefield has states — §13's momentum, §12's scoring, §27.8's result — and
 * a unit that only ever idles is scenery rather than an army. Everything else
 * in the rig is a platformer's vocabulary and is dropped.
 */
const KEEP_CLIPS = [
  'Idle',
  'Idle_Gun',
  'Walk',
  'Walk_Gun',
  'Run',
  'Run_Gun',
  'Shoot_Big',
  'Shoot_Small',
  'Run_Gun_Shoot',
  'Death',
];

/** What is built, and what each one is for in the world. */
const UNITS = [
  { from: 'quaternius-ultimate-space-kit/mech-a.glb', to: 'units/mech-a.glb' },
  { from: 'quaternius-ultimate-space-kit/mech-b.glb', to: 'units/mech-b.glb' },
  { from: 'quaternius-ultimate-space-kit/mech-c.glb', to: 'units/mech-c.glb' },
  { from: 'quaternius-ultimate-space-kit/mech-d.glb', to: 'units/mech-d.glb' },
  { from: 'quaternius-ultimate-space-kit/trooper-a.glb', to: 'units/trooper-a.glb' },
  { from: 'quaternius-ultimate-space-kit/trooper-b.glb', to: 'units/trooper-b.glb' },
  { from: 'quaternius-ultimate-space-kit/trooper-c.glb', to: 'units/trooper-c.glb' },
  { from: 'quaternius-ultimate-space-kit/walker-large.glb', to: 'units/walker-large.glb' },
  { from: 'quaternius-ultimate-space-kit/drone-flying.glb', to: 'units/drone-flying.glb' },
  { from: 'quaternius-ultimate-space-kit/dropship-a.glb', to: 'units/dropship-a.glb' },
  { from: 'quaternius-ultimate-space-kit/dropship-c.glb', to: 'units/dropship-c.glb' },

  // Deck props. A district was a plate with an army standing on it; these are
  // what make it a place the army came *from* — supply, power, fuel. Static
  // meshes, so unlike the units they instance, and a hundred of them cost one
  // draw call each.
  {
    from: 'kenney_city-kit-industrial/Models/GLB format/shipping-container-a.glb',
    to: 'props/container-a.glb',
  },
  {
    from: 'kenney_city-kit-industrial/Models/GLB format/shipping-container-b.glb',
    to: 'props/container-b.glb',
  },
  {
    from: 'kenney_city-kit-industrial/Models/GLB format/detail-tank.glb',
    to: 'props/tank.glb',
  },
  {
    from: 'kenney_city-kit-industrial/Models/GLB format/detail-tank-large.glb',
    to: 'props/tank-large.glb',
  },
  {
    from: 'kenney_city-kit-industrial/Models/GLB format/chimney-medium.glb',
    to: 'props/chimney.glb',
  },
  {
    from: 'kenney_city-kit-industrial/Models/GLB format/water-tower.glb',
    to: 'props/water-tower.glb',
  },
];

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);

let built = 0;
let skipped = 0;
let before = 0;
let after = 0;

for (const unit of UNITS) {
  const source = join(SOURCES, unit.from);
  let sourceBytes;
  try {
    sourceBytes = statSync(source).size;
  } catch {
    process.stdout.write(`  skip ${unit.from} — not downloaded\n`);
    skipped += 1;
    continue;
  }

  const document = await io.read(source);

  // Dropped by name rather than by index: an index is a property of one
  // export, and the next version of a pack would silently keep the wrong ones.
  for (const animation of document.getRoot().listAnimations()) {
    const name = animation.getName().split('|').pop() ?? '';
    if (!KEEP_CLIPS.includes(name)) {
      animation.dispose();
    } else {
      // The clip keeps the short name. `RobotArmature|Idle` is a fact about
      // the rig it was exported from, and every caller would have to know it.
      animation.setName(name);
    }
  }

  await document.transform(
    // Before pruning: resampling can make a track constant, and a constant
    // track is one prune can then remove entirely.
    resample(),
    dedup(),
    prune({ keepAttributes: false, keepLeaves: false }),
    quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }),
  );

  const target = join(OUT, unit.to);
  mkdirSync(dirname(target), { recursive: true });
  const bytes = await io.writeBinary(document);
  writeFileSync(target, bytes);

  before += sourceBytes;
  after += bytes.byteLength;
  built += 1;
  process.stdout.write(
    `  ${basename(unit.to).padEnd(20)} ${kb(sourceBytes)} → ${kb(bytes.byteLength)}\n`,
  );
}

process.stdout.write(
  `\n${String(built)} built, ${String(skipped)} skipped — ${kb(before)} → ${kb(after)}` +
    (before > 0 ? ` (${String(Math.round((1 - after / before) * 100))}% smaller)` : '') +
    '\n',
);

if (built === 0) {
  process.stderr.write(
    `\nNothing was built. Sources are expected under ${SOURCES};\n` +
      'see docs/operations/third-party-models.md for what to download and from where.\n',
  );
  process.exitCode = 1;
}

function kb(bytes) {
  return `${String(Math.round(bytes / 1024))} kB`;
}
