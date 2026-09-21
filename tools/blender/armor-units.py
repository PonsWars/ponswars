"""
Puts the pack's troopers and mechs in armour (§36.1, §36.7, §36.16).

    "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
        --background --python tools/blender/armor-units.py -- [--preview out.png]

The only free rigged soldiers and mechs there are (Quaternius' Ultimate Space
Kit, CC0) are a cartoon cast: a flamingo, a bee and a frog in spacesuits, and
mechs driven by a flamingo, a red panda, a frog and a bee. Close up, an army of
them is the one thing §36.16 rejects on sight — a cute, colourful cartoon army —
and the bodies around them are good: suits, armour plates, walking chassis, a
full set of animations.

So the heads go and the bodies stay:

- **A trooper** loses the animal head and gets a closed combat helmet with a
  visor slit, bound to the same `Head` bone, so it turns and nods with every
  clip exactly as the head did.
- **A mech** loses its pilot and gets an armoured hood over the cockpit, bound
  to the chassis: a machine, not a vehicle with a passenger waving from it.
- **The heavy** is a mech too. The pack's big walker is a green alien with eyes
  and nothing under it worth keeping, so the heavy unit is the widest mech
  chassis, hooded, with a pair of cannons and a missile pod on it — the one
  silhouette on the deck that says it is the army's weight (§36.8).

Every new part takes its colour from a texel of the pack's own atlas — the suit's
grey, the armour's dark — because the client keeps that atlas as the base map
(`Army.tsx`); a part with its own material would be a second draw call per unit.

Reads the packs from `PONSWARS_MODEL_SOURCES` (as `tools/build-models.mjs`
does) and writes `ponswars-armored/` next to them, which the model build then
reads instead of the originals. Sources stay out of the repository; the result
is committed as the built models.
"""

import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

SOURCES = os.environ.get("PONSWARS_MODEL_SOURCES", "C:/Users/W/PonsWars_assets/vendor")
PACK = os.path.join(SOURCES, "quaternius-ultimate-space-kit")
OUT = os.path.join(SOURCES, "ponswars-armored")

# The groups each kind's cartoon occupies, by the bone that carries most of a
# vertex's weight. A bee's antennae hang off `Neck`; a pilot's body is `Chest`.
TROOPER_CUT = {"Head", "Neck"}
MECH_CUT = {"Head", "Neck", "Chest"}

TROOPERS = ["trooper-a", "trooper-b", "trooper-c"]
MECHS = ["mech-a", "mech-b", "mech-c", "mech-d"]


def reset() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def character(name: str):
    bpy.ops.import_scene.gltf(filepath=os.path.join(PACK, f"{name}.glb"))
    body = next(o for o in bpy.data.objects if o.type == "MESH" and o.vertex_groups)
    return body


def dominant(body, vertex) -> str | None:
    if not vertex.groups:
        return None
    group = max(vertex.groups, key=lambda g: g.weight)
    return body.vertex_groups[group.group].name


def atlas_pixels(body):
    image = next(
        node.image
        for node in body.active_material.node_tree.nodes
        if node.type == "TEX_IMAGE" and node.image is not None
    )
    width, height = image.size
    return width, height, list(image.pixels)


def texel(body, groups: set[str] | None, target: float) -> tuple[float, float]:
    """The UV of an existing vertex whose atlas colour is nearest `target` in luminance."""
    width, height, pixels = atlas_pixels(body)
    uvs = body.data.uv_layers.active.data
    best, best_uv = None, (0.0, 0.0)
    for loop in body.data.loops:
        vertex = body.data.vertices[loop.vertex_index]
        if groups is not None and dominant(body, vertex) not in groups:
            continue
        u, v = uvs[loop.index].uv
        x = min(width - 1, max(0, int(u * width)))
        y = min(height - 1, max(0, int(v * height)))
        r, g, b = pixels[(y * width + x) * 4 : (y * width + x) * 4 + 3]
        luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
        # Grey rather than any colour of that brightness: a pink panel the
        # client desaturates still reads as a different material.
        chroma = max(r, g, b) - min(r, g, b)
        score = abs(luminance - target) + chroma
        if best is None or score < best:
            best, best_uv = score, (u, v)
    return best_uv


def cut(body, groups: set[str]) -> tuple[Vector, Vector]:
    """Removes the cartoon, returning the world bounds of what was removed."""
    world = body.matrix_world
    removed = [v for v in body.data.vertices if dominant(body, v) in groups]
    points = [world @ v.co for v in removed]
    low = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    high = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))

    mesh = bmesh.new()
    mesh.from_mesh(body.data)
    mesh.verts.ensure_lookup_table()
    doomed = [mesh.verts[v.index] for v in removed]
    bmesh.ops.delete(mesh, geom=doomed, context="VERTS")
    mesh.to_mesh(body.data)
    mesh.free()
    return low, high


class Parts:
    """New geometry in world space, each piece one flat atlas colour."""

    def __init__(self) -> None:
        self.mesh = bmesh.new()
        self.uv = self.mesh.loops.layers.uv.new("UVMap")

    def _paint(self, faces, uv) -> None:
        for face in faces:
            face.smooth = False
            for loop in face.loops:
                loop[self.uv].uv = uv

    def box(self, centre, size, uv, tilt: float = 0.0) -> None:
        made = bmesh.ops.create_cube(self.mesh, size=1.0)
        verts = made["verts"]
        transform = (
            Matrix.Translation(Vector(centre))
            @ Matrix.Rotation(tilt, 4, "X")
            @ Matrix.Diagonal((*size, 1.0))
        )
        bmesh.ops.transform(self.mesh, matrix=transform, verts=verts)
        self._paint({f for v in verts for f in v.link_faces}, uv)

    def shell(self, centre, radii, uv, segments: int = 8, rings: int = 6) -> None:
        """A faceted dome: the low-poly look the rest of the rig is modelled in."""
        made = bmesh.ops.create_uvsphere(
            self.mesh, u_segments=segments, v_segments=rings, radius=1.0
        )
        verts = made["verts"]
        transform = Matrix.Translation(Vector(centre)) @ Matrix.Diagonal((*radii, 1.0))
        bmesh.ops.transform(self.mesh, matrix=transform, verts=verts)
        self._paint({f for v in verts for f in v.link_faces}, uv)

    def ring(self, centre, radius, depth, uv, segments: int = 8) -> None:
        made = bmesh.ops.create_cone(
            self.mesh,
            cap_ends=True,
            segments=segments,
            radius1=radius,
            radius2=radius * 0.92,
            depth=depth,
        )
        verts = made["verts"]
        bmesh.ops.translate(self.mesh, vec=Vector(centre), verts=verts)
        self._paint({f for v in verts for f in v.link_faces}, uv)

    def attach(self, body, bone: str) -> None:
        """Joins the parts into the character, fully weighted to one bone."""
        data = bpy.data.meshes.new("armour")
        self.mesh.to_mesh(data)
        self.mesh.free()
        part = bpy.data.objects.new("armour", data)
        bpy.context.collection.objects.link(part)
        part.data.materials.append(body.active_material)
        group = part.vertex_groups.new(name=bone)
        group.add(list(range(len(data.vertices))), 1.0, "REPLACE")

        # Parts are made in world space; the character is scaled by 100.
        part.matrix_world = Matrix.Identity(4)
        bpy.ops.object.select_all(action="DESELECT")
        part.select_set(True)
        body.select_set(True)
        bpy.context.view_layer.objects.active = body
        bpy.ops.object.join()


def helmet(body, variant: int) -> None:
    """A closed combat helmet where the animal head was."""
    head = body.find_armature().data.bones["Head"]
    pivot = body.find_armature().matrix_world @ head.head_local
    suit = texel(body, {"Body", "Torso", "UpperArm.L", "UpperLeg.L"}, 0.55)
    dark = texel(body, None, 0.04)
    cut(body, TROOPER_CUT)

    parts = Parts()
    centre = Vector((0.0, pivot.y - 0.02, pivot.z + 0.12))
    # Gorget: where the suit's collar ring was, so the neck is sealed.
    parts.ring((0.0, pivot.y, pivot.z - 0.2), 0.4, 0.16, dark)
    # The shell: wider than deep, and lower than the animal heads it replaces,
    # so the figure reads as a soldier and not a mascot.
    parts.shell(centre, (0.42, 0.44, 0.38), suit)
    # Visor slit across the face (the face is -Y).
    parts.box((0.0, centre.y - 0.4, centre.z - 0.02), (0.6, 0.1, 0.13), dark)
    # Brow plate over the visor, so it reads as armour from above.
    parts.box((0.0, centre.y - 0.34, centre.z + 0.14), (0.66, 0.16, 0.08), suit, tilt=0.35)
    # One distinct mark per variant, so three troopers are not one: a comms
    # antenna, a centre crest, cheek plates.
    if variant == 0:
        parts.box((0.36, centre.y + 0.08, centre.z + 0.3), (0.05, 0.05, 0.5), dark)
    elif variant == 1:
        parts.box((0.0, centre.y + 0.04, centre.z + 0.36), (0.1, 0.62, 0.1), dark)
    else:
        for side in (-1, 1):
            parts.box((side * 0.38, centre.y - 0.18, centre.z - 0.14), (0.1, 0.34, 0.26), dark)
    parts.attach(body, "Head")


def hood(body) -> None:
    """An armoured cockpit hood where the pilot sat."""
    armour = texel(body, {"LowerLeg.L", "UpperLeg.L", "Foot.L"}, 0.35)
    dark = texel(body, None, 0.04)
    torso = [
        body.matrix_world @ v.co for v in body.data.vertices if dominant(body, v) == "Torso"
    ]
    deck = max(p.z for p in torso)
    low, high = cut(body, MECH_CUT)

    parts = Parts()
    width = max(0.5, min(0.9, (high.x - low.x) * 0.9))
    depth = max(0.6, min(1.0, high.y - low.y))
    front = low.y
    base = min(low.z, deck - 0.1)
    centre_y = front + depth / 2
    # The hood: a low armoured block with a sloped glacis, sat on the chassis.
    parts.box((0.0, centre_y, base + 0.28), (width, depth, 0.56), armour)
    parts.box((0.0, front + 0.1, base + 0.5), (width * 0.94, 0.3, 0.28), armour, tilt=-0.6)
    # Sensor slit across its face.
    parts.box((0.0, front - 0.02, base + 0.42), (width * 0.7, 0.08, 0.1), dark)
    # A sensor mast behind it: the part of the silhouette that says "machine".
    parts.box((width * 0.3, centre_y + depth * 0.3, base + 0.8), (0.06, 0.06, 0.5), dark)
    parts.attach(body, "Torso")


def heavy(body) -> None:
    """The widest chassis, hooded, carrying the guns a heavy unit is for."""
    hood(body)
    armour = texel(body, {"LowerLeg.L", "UpperLeg.L", "Foot.L"}, 0.35)
    dark = texel(body, None, 0.04)
    torso = [
        body.matrix_world @ v.co for v in body.data.vertices if dominant(body, v) == "Torso"
    ]
    side = max(p.x for p in torso)
    front = min(p.y for p in torso)
    top = max(p.z for p in torso)

    parts = Parts()
    for x in (-1, 1):
        # A cannon on each shoulder, barrels forward (-Y).
        parts.box((x * (side - 0.2), front + 0.55, top + 0.12), (0.42, 0.9, 0.36), armour)
        parts.box((x * (side - 0.2), front - 0.45, top + 0.12), (0.14, 1.1, 0.14), dark)
    # A missile pod behind the hood: a block of dark tubes' ends.
    parts.box((0.0, front + 1.35, top + 0.3), (0.9, 0.5, 0.5), armour)
    parts.box((0.0, front + 1.08, top + 0.3), (0.72, 0.06, 0.36), dark)
    parts.attach(body, "Torso")


def export(name: str, body, role: str) -> None:
    # The pack names each mesh after its cartoon; nothing of it is left.
    body.name = role
    body.data.name = role
    for extra in [o for o in bpy.data.objects if o.name.startswith("Icosphere")]:
        bpy.data.objects.remove(extra)
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT, f"{name}.glb"),
        export_format="GLB",
        export_animation_mode="ACTIONS",
        # The pack's own keyframes, not a key per bone per frame: resampled,
        # a trooper came out a third larger with not one pose changed.
        export_force_sampling=False,
        export_optimize_animation_size=True,
        export_yup=True,
    )


def preview(path: str) -> None:
    """Every armoured unit in a row, on a turntable-free Workbench render."""
    reset()
    x = 0.0
    for name in TROOPERS + MECHS + ["walker-heavy"]:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(OUT, f"{name}.glb"))
        for obj in set(bpy.data.objects) - before:
            if obj.parent is None:
                obj.location.x += x
        x += 3.6
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.render.resolution_x = 1800
    scene.render.resolution_y = 560
    world = bpy.data.worlds.new("preview")
    world.color = (0.05, 0.07, 0.09)
    scene.world = world
    camera_data = bpy.data.cameras.new("preview")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = x + 1.0
    camera = bpy.data.objects.new("preview", camera_data)
    bpy.context.collection.objects.link(camera)
    middle = (x - 3.6) / 2
    camera.location = Vector((middle, -14.0, 3.4))
    camera.rotation_euler = (Vector((middle, 0.0, 1.8)) - camera.location).to_track_quat(
        "-Z", "Y"
    ).to_euler()
    scene.camera = camera
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def main() -> None:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    for variant, name in enumerate(TROOPERS):
        reset()
        body = character(name)
        helmet(body, variant)
        export(name, body, "Trooper")
        print(f"armoured {name}")
    for name in MECHS:
        reset()
        body = character(name)
        hood(body)
        export(name, body, "Mech")
        print(f"armoured {name}")
    reset()
    body = character("mech-c")
    heavy(body)
    export("walker-heavy", body, "Heavy")
    print("armoured walker-heavy")
    if "--preview" in args:
        preview(args[args.index("--preview") + 1])


main()
