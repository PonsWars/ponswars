"""Builds the district structures, in Blender, from a script.

Run headless — no add-on, no GUI, no live session:

    "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
        --background --python tools/blender/build-district-kit.py

## Why this exists

The districts are boxes. Three forms of box, procedurally placed, lit at the
crown — and from the global view that reads as a skyline, which is why it
survived this long. Up close it reads as what it is.

Every delivered sector frame shows a *terraced citadel*: a mass that steps
inward as it rises, with buttresses down its faces and a recessed lit band
under the roof. That shape cannot be a box, and it is not something a pack
sells either — the free kits are modern city blocks or interior corridors.
It has to be modelled.

Modelled *procedurally*, though, which is what makes this a script rather than
a person in an afternoon: a citadel is a stack of extrusions with setbacks and
bevels, and that is a loop. It is also reproducible, reviewable in a diff, and
re-runnable when a proportion turns out wrong.

## What it produces

Three archetypes, each normalised into a **unit cube**. The client scales them
by the same `[width, height, depth]` its boxes used, so `island.ts` — which is
tested, and knows nothing about any of this — does not change at all. A bevel
distorts slightly under a non-uniform scale; at the distance §37.6 puts the
camera, that is invisible, and keeping the layout logic untouched is worth far
more.

Deterministic: same seed, same mesh, every run.
"""

from __future__ import annotations

import math
import os
import random
import sys

import bmesh
import bpy

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "apps", "web", "public", "models", "district")

# One seed for the whole kit. Changing it changes every piece, which is the
# point: these are meant to be a family.
SEED = 20260911


def reset() -> None:
    """An empty file. `--background` starts with a cube, a camera and a light."""
    bpy.ops.wm.read_factory_settings(use_empty=True)


def new_mesh(name: str) -> tuple[bpy.types.Object, bmesh.types.BMesh]:
    mesh = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj, bmesh.new()


def box(bm: bmesh.types.BMesh, x0: float, x1: float, y0: float, y1: float, z0: float, z1: float):
    """A closed box between two corners, as bmesh geometry."""
    verts = [
        bm.verts.new((x0, y0, z0)),
        bm.verts.new((x1, y0, z0)),
        bm.verts.new((x1, y1, z0)),
        bm.verts.new((x0, y1, z0)),
        bm.verts.new((x0, y0, z1)),
        bm.verts.new((x1, y0, z1)),
        bm.verts.new((x1, y1, z1)),
        bm.verts.new((x0, y1, z1)),
    ]
    faces = [
        (0, 1, 2, 3),
        (7, 6, 5, 4),
        (0, 4, 5, 1),
        (1, 5, 6, 2),
        (2, 6, 7, 3),
        (3, 7, 4, 0),
    ]
    for face in faces:
        bm.faces.new([verts[i] for i in face])
    return verts


def tower(name: str, tiers: int, setback: float, twist: float, rng: random.Random):
    """A mass that steps inward as it rises.

    `setback` is how much of the footprint each tier gives up. It is the whole
    silhouette: a small value is a slab, a large one is a ziggurat, and the
    delivered frames sit between the two.
    """
    obj, bm = new_mesh(name)

    half = 0.5
    base = 0.0
    for tier in range(tiers):
        # Tiers get shorter as they rise, so the mass reads as heavy at the
        # bottom. Even heights make a wedding cake.
        height = (1.0 - tier * 0.12) / tiers * (1.0 + rng.uniform(-0.08, 0.08))
        top = min(base + height, 1.0)
        inset = half * (1.0 - setback * tier)
        box(bm, -inset, inset, -inset, inset, base, top)

        # A ledge on top of each setback: the step is what catches light, and
        # without it the tiers read as one smooth taper.
        if tier < tiers - 1:
            lip = inset * 1.06
            box(bm, -lip, lip, -lip, lip, top - 0.012, top)

        base = top

    # Buttresses down two faces. Not four: the districts are seen from the
    # contested side, and geometry on the back is geometry nobody sees.
    fins = 3
    for index in range(fins):
        offset = (index - (fins - 1) / 2) * (1.0 / fins) * 0.72
        width = 0.035
        depth = 0.5 + rng.uniform(0.0, 0.03)
        reach = 0.62 + rng.uniform(-0.1, 0.16)
        box(bm, offset - width, offset + width, -depth - 0.03, -depth + 0.02, 0.0, reach)
        box(bm, offset - width, offset + width, depth - 0.02, depth + 0.03, 0.0, reach * 0.8)

    finish(obj, bm, twist)
    return obj


def slab(name: str, rng: random.Random):
    """A wide, low mass — the thing a tower stands next to."""
    obj, bm = new_mesh(name)

    box(bm, -0.5, 0.5, -0.5, 0.5, 0.0, 0.74)
    # A raised block off-centre, so the roof line is not one flat edge.
    off = rng.uniform(-0.16, 0.16)
    box(bm, off - 0.26, off + 0.26, -0.34, 0.34, 0.74, 1.0)
    # Vents along the roof.
    for index in range(4):
        x = -0.36 + index * 0.24
        box(bm, x - 0.05, x + 0.05, -0.42, -0.28, 0.74, 0.79)

    finish(obj, bm, 0.0)
    return obj


def spire(name: str, rng: random.Random):
    """Tall and tapering, with a mast. The thing that breaks a skyline."""
    obj, bm = new_mesh(name)

    tiers = 5
    base = 0.0
    for tier in range(tiers):
        height = (1.0 - tier * 0.05) / tiers * 0.86
        top = base + height
        inset = 0.5 * (1.0 - 0.17 * tier)
        box(bm, -inset, inset, -inset, inset, base, top)
        base = top

    # The mast, and a collar under it.
    box(bm, -0.11, 0.11, -0.11, 0.11, base, base + 0.03)
    box(bm, -0.035, 0.035, -0.035, 0.035, base, 1.0)
    _ = rng.random()

    finish(obj, bm, 0.0)
    return obj


def finish(obj: bpy.types.Object, bm: bmesh.types.BMesh, twist: float) -> None:
    """Weld, bevel, normalise into a unit cube, and write the mesh.

    The bevel is the single most valuable operation here. A box lit by one key
    light has no edge at all — it is two flat tones meeting — and a bevel of a
    few millimetres gives every edge a highlight. It is most of the difference
    between "modelled" and "primitive" at any distance.
    """
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    bmesh.ops.bevel(
        bm,
        geom=list(bm.verts) + list(bm.edges) + list(bm.faces),
        offset=0.008,
        offset_type="OFFSET",
        segments=1,
        profile=0.5,
        affect="EDGES",
        clamp_overlap=True,
    )
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    if twist != 0.0:
        bmesh.ops.rotate(
            bm,
            verts=bm.verts,
            cent=(0.0, 0.0, 0.0),
            matrix=bpy.types.Object.rotation_euler.__doc__ and _rotation_z(twist),
        )

    # Into a unit cube: x and y in [-0.5, 0.5], z in [0, 1]. The client scales
    # by the block's own dimensions, so anything else would apply that scale to
    # the wrong base size and every piece would be a different height.
    xs = [v.co.x for v in bm.verts]
    ys = [v.co.y for v in bm.verts]
    zs = [v.co.z for v in bm.verts]
    span_x = max(max(xs) - min(xs), 1e-6)
    span_y = max(max(ys) - min(ys), 1e-6)
    span_z = max(max(zs) - min(zs), 1e-6)
    mid_x = (max(xs) + min(xs)) / 2
    mid_y = (max(ys) + min(ys)) / 2
    low_z = min(zs)
    for vert in bm.verts:
        vert.co.x = (vert.co.x - mid_x) / span_x
        vert.co.y = (vert.co.y - mid_y) / span_y
        vert.co.z = (vert.co.z - low_z) / span_z

    bm.to_mesh(obj.data)
    bm.free()
    obj.data.shade_flat()


def _rotation_z(angle: float):
    from mathutils import Matrix

    return Matrix.Rotation(angle, 4, "Z")


def export(obj: bpy.types.Object, filename: str) -> int:
    for other in bpy.context.scene.objects:
        other.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    path = os.path.join(OUT, filename)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_materials="NONE",
        export_normals=True,
        export_texcoords=False,
        export_yup=True,
    )
    return os.path.getsize(path)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    reset()
    rng = random.Random(SEED)

    pieces = [
        (tower("tower-a", tiers=4, setback=0.13, twist=0.0, rng=rng), "tower-a.glb"),
        (tower("tower-b", tiers=6, setback=0.09, twist=0.0, rng=rng), "tower-b.glb"),
        (slab("slab-a", rng=rng), "slab-a.glb"),
        (spire("spire-a", rng=rng), "spire-a.glb"),
    ]

    total = 0
    for obj, filename in pieces:
        size = export(obj, filename)
        total += size
        polygons = len(obj.data.polygons)
        sys.stdout.write(
            "  {:<14} {:>5} polys  {:>5} kB\n".format(filename, polygons, round(size / 1024))
        )

    sys.stdout.write(
        "\n{} pieces, {} kB total, in {}\n".format(len(pieces), round(total / 1024), OUT)
    )


main()
