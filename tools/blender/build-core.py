"""Builds the Market Core, in Blender, from a script.

Run headless — no add-on, no GUI, no live session:

    "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
        --background --python tools/blender/build-core.py -- [--preview out.png]

## Why

§38.2 makes the Market Core the landmark every player orients by: the one
structure visible from anywhere in the ring, and the one that survives every
round. It was seven boxes. From the global view that read as a skyline; from
anywhere closer it read as seven boxes, at the centre of a world whose sectors
had just been given terraced citadels.

Every delivered world frame puts a spired fortress there — a tall central
spire stepping inward as it rises, buttressed, ringed with light at each
setback, with lesser towers gathered round it. That is the shape modelled here.

## What it produces

One GLB with two meshes, told apart by name:

- `core_body` — the masses, bevelled so every edge catches the key light;
- `core_bands` — thin rings at each setback, which the client lights as the
  core's own colour. Kept separate so the lit parts are a material choice in
  the client rather than baked colour, and so §38.10's phase lighting can
  still drive them.

Built in world units rather than normalised, because the core is one object in
one place: the spire layout matches the one the client drew with boxes, so the
camera framing and the pose clearance tests hold without a change.

`--preview` renders a still with the Workbench engine, which runs headless on
any machine. That still is how the model gets looked at before it ships.

Deterministic: same script, same mesh.
"""

from __future__ import annotations

import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "apps", "web", "public", "models", "core", "market-core.glb")

# The layout the client drew as boxes: (x, y, base half-width, height). Kept so
# the landmark stands where players already know it, at the height the camera
# poses were tested against. y here is Blender's depth axis; the glTF exporter
# turns z-up into y-up, so it becomes the world's z.
SPIRES = [
    (0.0, 0.0, 17.0, 200.0),
    (-46.0, 18.0, 11.0, 138.0),
    (44.0, -12.0, 13.0, 154.0),
    (-18.0, -48.0, 10.0, 108.0),
    (22.0, 50.0, 9.0, 122.0),
    (-68.0, -44.0, 8.0, 76.0),
    (66.0, 44.0, 7.5, 84.0),
]

# How much of its radius each tier gives up. The whole silhouette is this
# number: small is a column, large is a ziggurat, and the delivered frames sit
# between the two.
SETBACK = 0.13


def reset() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def frustum(bm, x, y, r0, r1, z0, z1, segments=8):
    """An octagonal frustum standing on z0. Eight sides: a shoulder in the outline."""
    height = z1 - z0
    bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        cap_tris=False,
        segments=segments,
        radius1=r0,
        radius2=r1,
        depth=height,
        matrix=Matrix.Translation((x, y, z0 + height / 2)) @ Matrix.Rotation(math.pi / segments, 4, "Z"),
    )


def fin(bm, x, y, angle, inner, outer, width, top):
    """A buttress: a wedge leaning against the foot of a spire.

    Full height against the wall and sloping down to a toe on the ground. A
    square slab of the same size read as a signboard stuck to the tower; the
    slope is what makes it read as structure carrying load.
    """
    geom = bmesh.ops.create_cube(bm, size=1.0)
    verts = geom["verts"]
    length = outer - inner
    bmesh.ops.scale(bm, verts=verts, vec=(length, width, top))
    bmesh.ops.translate(bm, verts=verts, vec=(inner + length / 2, 0.0, top / 2))
    # The outer top edge drops to a low toe.
    for vert in verts:
        if vert.co.x > inner + length / 2 and vert.co.z > top / 2:
            vert.co.z = top * 0.14
    bmesh.ops.rotate(bm, verts=verts, cent=(0.0, 0.0, 0.0), matrix=Matrix.Rotation(angle, 4, "Z"))
    bmesh.ops.translate(bm, verts=verts, vec=(x, y, 0.0))


def spire(body, bands, x, y, radius, height, central):
    tiers = 6 if central else 4
    # A podium the buttresses land on, so the tower meets the ground on
    # something rather than being pushed into it.
    frustum(body, x, y, radius * 1.62, radius * 1.5, 0.0, radius * 0.34)
    base = 0.0
    r = radius
    for tier in range(tiers):
        # Tiers shorten as they rise, so the mass is heavy at the foot. Even
        # heights make a wedding cake.
        share = (1.0 - tier * 0.1) / sum(1.0 - i * 0.1 for i in range(tiers))
        top = base + height * (0.88 if central else 0.94) * share
        r_top = r * 0.95
        frustum(body, x, y, r, r_top, base, top)
        # The ledge on each setback: the step is what catches light, and
        # without it the tiers read as one smooth taper.
        frustum(body, x, y, r_top * 1.09, r_top * 1.09, top - 0.9, top)
        # And the lit band just under it.
        frustum(bands, x, y, r_top * 1.015, r_top * 1.005, top - 4.2, top - 2.4)
        base = top
        r = r_top * (1.0 - SETBACK)

    if central:
        # The crown and the mast the beacon sits on.
        frustum(body, x, y, r * 1.2, r * 0.7, base, base + 6.0)
        frustum(body, x, y, 1.6, 0.9, base + 6.0, height + 8.0, segments=6)
        frustum(bands, x, y, r * 1.25, r * 1.25, base + 1.0, base + 2.2)

    # Buttresses round the foot: eight on the central spire, four elsewhere.
    count = 8 if central else 4
    for index in range(count):
        angle = index * (2 * math.pi / count) + (math.pi / count if not central else 0.0)
        fin(body, x, y, angle, radius * 0.7, radius * 1.45, radius * 0.16, height * 0.3)


def finish(name, bm, bevel):
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.001)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if bevel > 0:
        bmesh.ops.bevel(
            bm,
            geom=list(bm.edges),
            offset=bevel,
            offset_type="OFFSET",
            segments=1,
            profile=0.5,
            affect="EDGES",
            clamp_overlap=True,
        )
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.shade_flat()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def export(objects):
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    for other in bpy.context.scene.objects:
        other.select_set(False)
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_materials="NONE",
        export_normals=True,
        export_texcoords=False,
        export_yup=True,
    )


def preview(path, body, bands):
    """A still to look at before shipping. Workbench, so it renders headless anywhere."""
    dark = bpy.data.materials.new("preview-body")
    dark.diffuse_color = (0.16, 0.24, 0.3, 1.0)
    lit = bpy.data.materials.new("preview-bands")
    lit.diffuse_color = (0.3, 0.95, 0.8, 1.0)
    body.data.materials.append(dark)
    bands.data.materials.append(lit)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_cavity = True
    scene.display.shading.show_shadows = True
    scene.render.resolution_x = 1100
    scene.render.resolution_y = 820
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("preview")
    world.color = (0.02, 0.04, 0.06)
    scene.world = world

    camera_data = bpy.data.cameras.new("preview")
    camera_data.lens = 40
    camera = bpy.data.objects.new("preview", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = Vector((330.0, -300.0, 170.0))
    direction = Vector((0.0, 0.0, 95.0)) - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = camera
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def main() -> None:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    reset()
    body = bmesh.new()
    bands = bmesh.new()
    for index, (x, y, radius, height) in enumerate(SPIRES):
        spire(body, bands, x, y, radius, height, central=index == 0)
    body_obj = finish("core_body", body, bevel=0.35)
    bands_obj = finish("core_bands", bands, bevel=0.0)
    export([body_obj, bands_obj])
    sys.stdout.write(
        "  market-core.glb  body {} polys, bands {} polys, {} kB\n".format(
            len(body_obj.data.polygons),
            len(bands_obj.data.polygons),
            round(os.path.getsize(OUT) / 1024),
        )
    )
    if "--preview" in args:
        preview(args[args.index("--preview") + 1], body_obj, bands_obj)
        sys.stdout.write("  preview written\n")


main()
