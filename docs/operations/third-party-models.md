# Third-party models

Every 3D model in this product that was not written as arithmetic, where it came
from, and under what licence.

## Why any of this is here

The world was built entirely from primitives — boxes, cylinders, instanced
fields, a shader for the void — because there were no models in this repository
at all. That was a real ceiling rather than a shortcut: a shape that reads as a
mech is a modelled, rigged, textured asset, and no quantity of primitives
produces one. The delivered concept art is full of armies; the world had none,
and could not have any, until somebody put an asset in it.

## The rule

**CC0 only.**

Not a preference — a constraint that follows from what this repository is. It is
AGPL-3.0 and public, so an asset that carries a condition carries it into the
licence of the thing that ships. CC0 is public domain: commercial use, no
attribution required, no condition to propagate. Anything under CC-BY would
oblige an attribution notice; anything non-commercial could not be used at all.

The attributions below are therefore **courtesy, not obligation** — these people
gave the work away and are named anyway.

## What is used

| Model                                  | Pack                  | Author     | Licence | Source                                                                |
| -------------------------------------- | --------------------- | ---------- | ------- | --------------------------------------------------------------------- |
| `mech-a`, `mech-b`, `mech-c`, `mech-d` | Ultimate Space Kit    | Quaternius | CC0     | [poly.pizza](https://poly.pizza/bundle/Ultimate-Space-Kit-YWh743lqGX) |
| `trooper-a`, `trooper-b`, `trooper-c`  | Ultimate Space Kit    | Quaternius | CC0     | same                                                                  |
| `walker-large`, `drone-flying`         | Ultimate Space Kit    | Quaternius | CC0     | same                                                                  |
| `dropship-a`, `dropship-c`             | Ultimate Space Kit    | Quaternius | CC0     | same                                                                  |
| `container-a`, `container-b`           | City Kit (Industrial) | Kenney     | CC0     | [kenney.nl](https://kenney.nl/assets/city-kit-industrial)             |
| `tank`, `tank-large`                   | City Kit (Industrial) | Kenney     | CC0     | same                                                                  |
| `chimney`, `water-tower`               | City Kit (Industrial) | Kenney     | CC0     | same                                                                  |

Quaternius publishes at [quaternius.com](https://quaternius.com/) under CC0 —
"free to use in personal, educational and commercial projects". Kenney's kits
carry a `License.txt` saying the same thing, in the download itself.

Kenney's [Modular Space Kit](https://kenney.nl/assets/modular-space-kit),
[City Kit (Commercial)](https://kenney.nl/assets/city-kit-commercial) and
[Factory Kit](https://kenney.nl/assets/factory-kit) are downloaded and also CC0,
and nothing from them is used yet.

Nothing from any pack became a _building_. The city kits are modern low-rise
offices and warehouses, which is further from the delivered concept art than the
procedural towers already were — so the districts are modelled instead, by
`tools/blender/build-district-kit.py`, and the kits contribute the scenery
standing between them.

## What is modelled here instead

The district structures are not from a pack. `tools/blender/build-district-kit.py`
builds them procedurally in headless Blender — four terraced pieces, 110 kB,
156–442 polys — because the free kits are modern low-rise offices and interior
corridors, and the delivered art shows a terraced citadel. It runs with no
add-on and no live session, and is committed like any other build tool.

Neither is the Market Core. `tools/blender/build-core.py` builds
`models/core/market-core.glb` — 468 kB, 4,270 polys of structure and 310 of lit
banding — because §38.2 makes it the landmark every player orients by and it was
seven boxes. No pack contains a buttressed spired citadel, and the one structure
in the world that everything else is positioned relative to is the last thing to
borrow. Two meshes, `core_body` and `core_bands`, so the client decides what is
lit; the spire layout is the one the boxes had, so the camera poses tested
against it still hold. Same headless invocation, plus `--preview out.png`, which
renders a still with the Workbench engine — that is how it gets looked at before
it ships.

## The two directories

Sources are **not** in the repository, exactly like the art masters:

| Where                                                                         | What                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------- |
| `C:/Users/W/PonsWars_assets/vendor/` (override with `PONSWARS_MODEL_SOURCES`) | The packs as downloaded. Large, unchanging. |
| `apps/web/public/models/`                                                     | What the client serves. Committed.          |

`node tools/build-models.mjs` turns the first into the second: it drops the
animation clips nobody plays, quantizes vertex data, and prunes what the
exporter left behind — about 40% smaller, and most of that is keyframes for
`Dance` and `Hello`.

Not part of `verify.sh`, for the same reason `build-art.mjs` is not: it reads
sources CI does not have. The built models are committed, so CI checks the thing
that ships.

## They do not arrive looking like this product

A pack is lit and coloured for the game it was made for — these are bright,
stylised and clean, and §36 fixes the direction here as dark, matte and
restrained. A model dropped in unchanged reads as something borrowed from
another product, which is exactly what it is.

`Army.tsx` replaces every material. The pack's texture atlas stays, because it
carries the panel lines that make a silhouette legible; the tone it is
multiplied by, the response to light and a faint faction-coloured emissive are
this world's (§36.5, §36.7). Nothing is repainted in a faction's colour — §36.5
keeps that an accent, and an army in team colours would read as a toy.

## Before adding one

1. **Check the licence, on the page that hosts it.** "Free" on an aggregator is
   not a licence. CC0 or nothing.
2. **Record it in the table above** in the same commit that adds the file.
3. **Look at it in the world**, not on the vendor's turntable. The question is
   whether it reads at the distance §37.6 puts the camera at, in this palette,
   beside a district — not whether it is a good model.
4. **Check what it costs.** A skinned mesh is a draw call and a skeleton per
   unit; `STRENGTH` in `Army.tsx` is where that budget is spent, and it is tied
   to detail level for a reason.
