"""
Builds the robot variants (costumes on the KayKit Mannequin) and their animation pack.

Run with Blender 5.x, headless:

    blender --background --factory-startup --python scripts/robots/build_robot_variants.py -- <out_dir> [--preview <png_dir>]

Writes, into <out_dir>:
  robot-<variant>.glb   one per variant: the Rig_Medium skeleton plus ONE skinned mesh with
                        ONE material (body and costume merged), so a robot is one draw call.
  Rig_Medium_Fest.glb   the variants' own clips (march, sway, band, wedding), skeleton only,
                        retargeted at runtime onto any Rig_Medium character by joint name.

Why it is built this way:
  * The skeleton round-trips through Blender unchanged (measured: joint rest transforms
    differ by < 1e-5 after import/export), so the stock KayKit clips (Walking_A, Idle_A,
    Waving...) still play on every variant.
  * The Mannequin's texture is a colour atlas. Costumes recolour the robot's blue/orange
    panels by body region (shirt, vest, trousers, socks, shoes) into extra colour cells
    painted into the atlas's spare quadrant, keeping the original vertical shading; added
    pieces (hats, skirts, instruments) sample the same cells. One texture, one material.
  * Added pieces are rigid parts weighted 100 % to one bone (a hat to `head`, a skirt to
    `hips`), the way the KayKit characters carry their own props.
  * The clips are authored with IK targets for hands and feet, then baked to bone keys.
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from robot_poses import (  # noqa: E402
    CLIPS, GUITAR_CENTER, GUITAR_NECK_HAND, KEYBOARD_TOP, KEYBOARD_Y, bake_clip, bind_to_pose,
    clear_pose, pose_clip,
)

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                   "Anim", "Mannequin Character", "characters", "Mannequin_Medium.glb")

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT_DIR = os.path.abspath(ARGS[0]) if ARGS else os.path.abspath("robot-build")
PREVIEW_DIR = os.path.abspath(ARGS[ARGS.index("--preview") + 1]) if "--preview" in ARGS else None
ONLY = ARGS[ARGS.index("--only") + 1].split(",") if "--only" in ARGS else None
FPS = 30

# ---------------------------------------------------------------------------------------
# Colour cells painted into the atlas's bottom-right quadrant (u 0.5-1, v 0-0.5):
# 8 columns x 2 rows. Each cell is a vertical gradient, light at the top, like the stock
# columns, so recoloured panels keep their shading.

CELLS = {
    "leather": "#7a4a28", "shoe": "#3b2516", "loden": "#3f6e3c", "shirt": "#f4eedf",
    "red": "#c8323c", "navy": "#26375f", "apron": "#e3edf7", "gold": "#e6b43c",
    "tux": "#22242c", "ivory": "#fff6e6", "pink": "#f58db4", "wood": "#b06d38",
    "band_red": "#d9443a", "purple": "#7c4cc8", "teal": "#1aa49a", "steel": "#a3acb6",
}
CELL_ORDER = list(CELLS)


def cell_rect(name):
    """(u0, u1, v0, v1) of a colour cell in UV space."""
    index = CELL_ORDER.index(name)
    col, row = index % 8, index // 8
    u0 = 0.5 + col * 0.0625
    v1 = 0.5 - row * 0.25
    return u0, u0 + 0.0625, v1 - 0.25, v1


def cell_uv(name, shade=0.6):
    """A UV inside a cell; shade 1 = top (light), 0 = bottom (dark)."""
    u0, u1, v0, v1 = cell_rect(name)
    margin = 0.02
    return ((u0 + u1) / 2, v0 + margin + (v1 - v0 - 2 * margin) * shade)


def hex_rgb(value):
    value = value.lstrip("#")
    return [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]


def build_atlas(source):
    """The stock atlas with the colour cells painted over its spare quadrant."""
    width, height = source.size
    pixels = list(source.pixels[:])
    for name, colour in CELLS.items():
        base = hex_rgb(colour)
        u0, u1, v0, v1 = cell_rect(name)
        x0, x1 = int(u0 * width), int(u1 * width)
        y0, y1 = int(v0 * height), int(v1 * height)
        for y in range(y0, y1):
            t = (y - y0) / max(1, (y1 - y0 - 1))  # 0 bottom .. 1 top
            factor = 0.62 + 0.5 * t                  # darker bottom, lighter top
            rgb = [min(1.0, c * factor + (0.08 * t if c > 0.85 else 0)) for c in base]
            for x in range(x0, x1):
                i = (y * width + x) * 4
                pixels[i:i + 4] = [rgb[0], rgb[1], rgb[2], 1.0]
    atlas = bpy.data.images.new("robot_fest_atlas", width, height, alpha=False)
    atlas.pixels.foreach_set(pixels)
    atlas.pack()
    return atlas


# ---------------------------------------------------------------------------------------
# Scene setup

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS


def import_mannequin():
    bpy.ops.import_scene.gltf(filepath=os.path.abspath(SRC))
    for obj in list(bpy.data.objects):
        if obj.type == "MESH" and not obj.name.startswith("Mannequin_"):
            bpy.data.objects.remove(obj)  # the importer's bone-shape icosphere
    arm = bpy.data.objects["Rig_Medium"]
    parts = [o for o in bpy.data.objects if o.type == "MESH"]
    with bpy.context.temp_override(active_object=parts[0], selected_editable_objects=parts,
                                   selected_objects=parts):
        bpy.ops.object.join()
    body = parts[0]
    body.name = "Robot"
    body.data.name = "Robot"
    return arm, body


# ---------------------------------------------------------------------------------------
# Recolouring the body panels

ARM_BONES = {"upperarm.l", "upperarm.r", "lowerarm.l", "lowerarm.r", "wrist.l", "wrist.r",
             "hand.l", "hand.r"}
REGION_OF = {
    **{b: "sleeves" for b in ARM_BONES},
    "chest": "torso", "spine": "torso",
    "hips": "trousers", "root": "trousers", "upperleg.l": "trousers", "upperleg.r": "trousers",
    "lowerleg.l": "socks", "lowerleg.r": "socks",
    "foot.l": "shoes", "foot.r": "shoes", "toes.l": "shoes", "toes.r": "shoes",
    "head": "head",
}


def recolour(body, scheme):
    """Moves the blue/orange panels' UVs into the scheme's cells, region by region."""
    mesh = body.data
    groups = {g.index: g.name for g in body.vertex_groups}
    region = []
    for vertex in mesh.vertices:
        best = max(vertex.groups, key=lambda g: g.weight, default=None)
        region.append(REGION_OF.get(groups.get(best.group, ""), "torso") if best else "torso")
    uv = mesh.uv_layers.active.data
    for poly in mesh.polygons:
        for loop_index in poly.loop_indices:
            u, v = uv[loop_index].uv
            vertex_region = region[mesh.loops[loop_index].vertex_index]
            target = scheme.get(vertex_region)
            if not target:
                continue
            panel = v > 0.5 and (0.5 <= u < 0.625 or 0.875 <= u <= 1.0)
            tag = u > 0.5 and v < 0.5  # the "HELLO" name tag: its quadrant is now palette
            if panel:
                shade = (v - 0.5) / 0.5
                uv[loop_index].uv = cell_uv(target, 0.15 + 0.8 * shade)
            elif tag:
                uv[loop_index].uv = cell_uv(scheme.get("tag", target), 0.7)


# ---------------------------------------------------------------------------------------
# Rigid costume parts

def new_part(primitive, **kwargs):
    getattr(bpy.ops.mesh, f"primitive_{primitive}_add")(**kwargs)
    obj = bpy.context.active_object
    return obj


def finish_part(obj, colour, bone, shade=None, smooth=True):
    """Applies transforms, paints the part into a cell and binds it to one bone."""
    with bpy.context.temp_override(active_object=obj, selected_editable_objects=[obj],
                                   selected_objects=[obj]):
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    mesh = obj.data
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    zs = [v.co.z for v in mesh.vertices]
    zmin, zmax = min(zs), max(zs)
    uv = mesh.uv_layers.active.data
    for poly in mesh.polygons:
        for loop_index in poly.loop_indices:
            z = mesh.vertices[mesh.loops[loop_index].vertex_index].co.z
            t = shade if shade is not None else 0.35 + 0.55 * ((z - zmin) / max(1e-6, zmax - zmin))
            uv[loop_index].uv = cell_uv(colour, t)
    for poly in mesh.polygons:
        poly.use_smooth = smooth
    group = obj.vertex_groups.new(name=bone)
    group.add(range(len(mesh.vertices)), 1.0, "REPLACE")
    return obj


def bone_by_height(obj, splits):
    """Re-weights a tall part (suspenders, a bodice) to the bone each vertex sits on.

    `splits` is [(z_from, bone)], ascending: a vertex goes to the last bone whose z_from it
    is above.
    """
    for group in list(obj.vertex_groups):
        obj.vertex_groups.remove(group)
    groups = {bone: obj.vertex_groups.new(name=bone) for _, bone in splits}
    for vertex in obj.data.vertices:
        bone = splits[0][1]
        for z_from, name in splits:
            if vertex.co.z >= z_from:
                bone = name
        groups[bone].add([vertex.index], 1.0, "REPLACE")


def box(size, location, colour, bone, rotation=(0, 0, 0), bevel=0.0):
    obj = new_part("cube", size=1, location=location, rotation=rotation)
    obj.scale = size
    if bevel:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        with bpy.context.temp_override(active_object=obj, object=obj):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    return finish_part(obj, colour, bone, smooth=bool(bevel))


def cylinder(radius, depth, location, colour, bone, rotation=(0, 0, 0), vertices=20, radius_top=None):
    if radius_top is None:
        obj = new_part("cylinder", radius=radius, depth=depth, location=location,
                       rotation=rotation, vertices=vertices)
    else:
        obj = new_part("cone", radius1=radius, radius2=radius_top, depth=depth,
                       location=location, rotation=rotation, vertices=vertices)
    return finish_part(obj, colour, bone)


def sphere(radius, location, colour, bone, scale=(1, 1, 1), segments=16):
    obj = new_part("uv_sphere", radius=radius, location=location, segments=segments,
                   ring_count=max(6, segments // 2))
    obj.scale = scale
    return finish_part(obj, colour, bone)


def torus(major, minor, location, colour, bone, rotation=(0, 0, 0)):
    obj = new_part("torus", major_radius=major, minor_radius=minor, location=location,
                   rotation=rotation, major_segments=24, minor_segments=8)
    return finish_part(obj, colour, bone)


def attach(body, parts):
    """Joins the parts into the body: one mesh, one material, the body's armature."""
    material = body.data.materials[0]
    for part in parts:
        part.data.materials.clear()
        part.data.materials.append(material)
    objects = [body, *parts]
    with bpy.context.temp_override(active_object=body, selected_editable_objects=objects,
                                   selected_objects=objects):
        bpy.ops.object.join()


# Head geometry (rest pose): a rounded box, x +-0.43, y -0.54..0.47, z 1.10..2.20.
HEAD_TOP = 2.17


def tyrolean_hat(colour="loden", band="leather", feather="shirt", flower=None, tilt=-0.12):
    parts = [
        cylinder(0.44, 0.035, (0, -0.03, HEAD_TOP + 0.005), colour, "head", rotation=(tilt, 0, 0), vertices=28),
        cylinder(0.27, 0.26, (0, -0.0, HEAD_TOP + 0.14), colour, "head", rotation=(tilt, 0, 0),
                 vertices=24, radius_top=0.2),
        cylinder(0.262, 0.06, (0, -0.005, HEAD_TOP + 0.06), band, "head", rotation=(tilt, 0, 0), vertices=24),
    ]
    if feather:
        quill = new_part("cone", radius1=0.045, radius2=0.004, depth=0.36, vertices=8,
                         location=(0.2, 0.12, HEAD_TOP + 0.24), rotation=(-0.5, 0.55, 0))
        quill.scale = (1, 0.35, 1)
        parts.append(finish_part(quill, feather, "head"))
    if flower:
        parts.append(sphere(0.07, (-0.22, -0.16, HEAD_TOP + 0.1), flower, "head"))
        parts.append(sphere(0.05, (-0.27, -0.06, HEAD_TOP + 0.08), "gold", "head"))
    return parts


def suspenders(colour="leather"):
    straps = []
    for x in (-0.12, 0.12):
        strap = box((0.075, 0.05, 0.62), (x, -0.255, 0.92), colour, "chest", bevel=0.01)
        bone_by_height(strap, [(0.0, "spine"), (0.973, "chest")])
        straps.append(strap)
    bar = box((0.3, 0.05, 0.06), (0, -0.27, 1.05), colour, "chest", bevel=0.01)
    bone_by_height(bar, [(0.0, "spine"), (0.973, "chest")])
    straps.append(bar)
    return straps


def skirt(colour, top_radius, bottom_radius, z_top, z_bottom, apron=None):
    depth = z_top - z_bottom
    parts = [cylinder(bottom_radius, depth, (0, 0, z_bottom + depth / 2), colour, "hips",
                      vertices=28, radius_top=top_radius)]
    if apron:
        front = box((0.36, 0.05, depth * 0.85), (0, -bottom_radius * 0.82, z_bottom + depth * 0.5),
                    apron, "hips", rotation=(-math.atan2(bottom_radius - top_radius, depth), 0, 0), bevel=0.012)
        parts.append(front)
    return parts


# ---------------------------------------------------------------------------------------
# Variants

def lederhosen():
    """Short leather trousers: a seat on the hips and a leg on each thigh."""
    parts = [cylinder(0.33, 0.2, (0, 0, 0.5), "leather", "hips", vertices=24, radius_top=0.34)]
    for side, bone in ((1, "upperleg.l"), (-1, "upperleg.r")):
        parts.append(cylinder(0.125, 0.17, (side * 0.171, -0.005, 0.4), "leather", bone,
                              vertices=16, radius_top=0.135))
    return parts


def german_man():
    scheme = {"sleeves": "shirt", "torso": "shirt", "trousers": "leather", "socks": "shirt",
              "shoes": "shoe", "head": "loden", "tag": "shirt"}
    return scheme, lambda: [*tyrolean_hat(feather="gold"), *suspenders(), *lederhosen()]


def german_woman():
    scheme = {"sleeves": "shirt", "torso": "loden", "trousers": "red", "socks": "shirt",
              "shoes": "shoe", "head": "red", "tag": "loden"}

    def parts():
        braids = []
        for side in (-1, 1):
            braid = cylinder(0.075, 0.46, (side * 0.2, 0.56, 1.36), "gold", "head", vertices=10,
                             rotation=(0.3, 0, 0))
            braids.append(braid)
            braids.append(sphere(0.07, (side * 0.2, 0.63, 1.12), "red", "head"))
        return [*tyrolean_hat(colour="loden", band="red", feather=None, flower="pink"),
                *skirt("red", 0.34, 0.52, 0.86, 0.3, apron="apron"), *braids]

    return scheme, parts


def groom():
    scheme = {"sleeves": "tux", "torso": "tux", "trousers": "tux", "socks": "tux",
              "shoes": "tux", "head": "tux", "tag": "tux"}

    def parts():
        shirt = box((0.26, 0.05, 0.3), (0, -0.265, 0.9), "ivory", "spine", bevel=0.014)
        return [
            shirt,
            box((0.14, 0.07, 0.1), (-0.075, -0.3, 1.0), "red", "spine", rotation=(0, 0.3, 0), bevel=0.022),
            box((0.14, 0.07, 0.1), (0.075, -0.3, 1.0), "red", "spine", rotation=(0, -0.3, 0), bevel=0.022),
            sphere(0.045, (0, -0.325, 1.0), "red", "spine"),
            sphere(0.055, (0.2, -0.26, 0.98), "pink", "spine"),
            cylinder(0.4, 0.03, (0, -0.02, HEAD_TOP + 0.01), "tux", "head", vertices=28),
            cylinder(0.25, 0.42, (0, 0.0, HEAD_TOP + 0.22), "tux", "head", vertices=24),
            cylinder(0.255, 0.07, (0, 0.0, HEAD_TOP + 0.07), "red", "head", vertices=24),
        ]

    return scheme, parts


def bride(arm):
    scheme = {"sleeves": "ivory", "torso": "ivory", "trousers": "ivory", "socks": "ivory",
              "shoes": "ivory", "head": "pink", "tag": "ivory"}

    def parts():
        veil = new_part("cone", radius1=0.5, radius2=0.18, depth=0.95, vertices=24,
                        location=(0, 0.2, 1.72), rotation=(0.32, 0, 0))
        veil.scale = (1, 0.62, 1)
        # The bouquet, placed between the hands in the bouquet pose, carried by the right one.
        pose_clip(arm, "Wedding_Bouquet")
        hands = (arm.pose.bones["hand.r"].head + arm.pose.bones["hand.l"].head) / 2 + Vector((0, -0.05, 0.08))
        bouquet = [sphere(0.07, hands + Vector(offset), colour, "hand.r")
                   for offset, colour in (((0, 0, 0.04), "pink"), ((-0.07, 0, 0.0), "red"), ((0.07, 0, 0.0), "pink"),
                                          ((0, -0.05, -0.02), "red"), ((0, 0.04, 0.02), "gold"))]
        bouquet.append(cylinder(0.035, 0.16, hands + Vector((0, 0, -0.1)), "loden", "hand.r", vertices=10))
        for obj in bouquet:
            bind_to_pose(arm, obj, "hand.r")
        clear_pose(arm)
        bpy.context.view_layer.update()
        return [
            *bouquet,
            *skirt("ivory", 0.34, 0.66, 0.9, 0.04),
            finish_part(veil, "ivory", "head"),
            torus(0.2, 0.03, (0, -0.06, HEAD_TOP - 0.01), "gold", "head", rotation=(0.2, 0, 0)),
            sphere(0.05, (0, -0.25, HEAD_TOP + 0.02), "pink", "head"),
            box((0.5, 0.05, 0.06), (0, -0.24, 0.9), "pink", "spine", bevel=0.015),
        ]

    return scheme, parts


def band_cap(colour):
    return box((0.5, 0.06, 0.12), (0, -0.04, HEAD_TOP + 0.03), colour, "head", bevel=0.02)


def guitarist():
    scheme = {"sleeves": "band_red", "torso": "band_red", "trousers": "tux", "socks": "tux",
              "shoes": "shoe", "head": "band_red", "tag": "band_red"}

    def parts():
        # The guitar hangs on the chest; the clip's hands are placed on it (robot_poses).
        neck_dir = (GUITAR_NECK_HAND - GUITAR_CENTER).normalized()
        tilt = math.atan2(neck_dir.z, neck_dir.x)
        down = (math.pi / 2, 0, 0)
        result = [
            cylinder(0.19, 0.08, GUITAR_CENTER + Vector((-0.05, 0, -0.03)), "wood", "chest", rotation=down, vertices=24),
            cylinder(0.15, 0.08, GUITAR_CENTER + Vector((0.1, 0, 0.04)), "wood", "chest", rotation=down, vertices=24),
            cylinder(0.055, 0.02, GUITAR_CENTER + Vector((0.03, -0.045, 0.01)), "tux", "chest", rotation=down, vertices=16),
            box((0.6, 0.04, 0.055), GUITAR_CENTER + neck_dir * 0.42 + Vector((0, -0.01, 0)), "shoe", "chest", rotation=(0, -tilt, 0)),
            box((0.12, 0.05, 0.08), GUITAR_CENTER + neck_dir * 0.76, "wood", "chest", rotation=(0, -tilt, 0)),
            box((0.62, 0.025, 0.05), (0.02, -0.2, 1.0), "tux", "chest", rotation=(0, 0.75, 0)),
            band_cap("tux"),
        ]
        return result

    return scheme, parts


def singer(arm):
    scheme = {"sleeves": "purple", "torso": "purple", "trousers": "tux", "socks": "tux",
              "shoes": "shoe", "head": "gold", "tag": "gold"}

    def parts():
        # Placed in the singing pose, in the right fist, then carried back to rest.
        pose_clip(arm, "Band_Sing")
        hand = arm.pose.bones["hand.r"]
        grip = hand.head + (hand.tail - hand.head) * 0.5
        up = Vector((-0.02, -0.18, 0.3)).normalized()
        turn = Vector((0, 0, 1)).rotation_difference(up).to_euler()
        handle = cylinder(0.028, 0.24, grip + up * 0.06, "tux", "hand.r", vertices=12, rotation=turn)
        ball = sphere(0.06, grip + up * 0.2, "steel", "hand.r")
        for obj in (handle, ball):
            bind_to_pose(arm, obj, "hand.r")
        clear_pose(arm)
        bpy.context.view_layer.update()
        chain = torus(0.16, 0.018, (0, -0.2, 1.03), "gold", "chest", rotation=(1.2, 0, 0))
        return [handle, ball, chain]

    return scheme, parts


def keyboardist():
    scheme = {"sleeves": "teal", "torso": "teal", "trousers": "tux", "socks": "tux",
              "shoes": "shoe", "head": "teal", "tag": "teal"}

    def parts():
        # The keyboard stands on the floor in front: bound to `root`, so it never moves.
        y, top = KEYBOARD_Y, KEYBOARD_TOP
        result = [
            box((0.95, 0.26, 0.07), (0, y, top - 0.035), "tux", "root", bevel=0.01),
            box((0.84, 0.14, 0.02), (0, y + 0.03, top + 0.005), "shirt", "root"),
        ]
        for i in range(-6, 7):
            if i % 7 in (2, 6):
                continue
            result.append(box((0.03, 0.08, 0.02), (i * 0.063 + 0.03, y, top + 0.02), "tux", "root"))
        for side in (-1, 1):
            # Two legs and a foot bar, standing exactly on the floor (z 0) under the keys.
            leg = top - 0.07
            result.append(box((0.04, 0.04, leg), (side * 0.38, y, leg / 2), "steel", "root"))
            result.append(box((0.06, 0.3, 0.03), (side * 0.38, y, 0.015), "steel", "root"))
        result.append(band_cap("teal"))
        return result

    return scheme, parts


VARIANTS = {
    "german-man": german_man,
    "german-woman": german_woman,
    "groom": groom,
    "bride": bride,
    "guitar": guitarist,
    "singer": singer,
    "keyboard": keyboardist,
}

# Which clip each variant shows in its preview.
PREVIEW_CLIP = {
    "german-man": "Fest_Sway", "german-woman": "Fest_March", "groom": "Wedding_Groom",
    "bride": "Wedding_Bouquet", "guitar": "Band_Guitar", "singer": "Band_Sing",
    "keyboard": "Band_Keyboard",
}


# ---------------------------------------------------------------------------------------
# Preview

def preview(path, frame=None, angle=-25):
    scene = bpy.context.scene
    if frame is not None:
        scene.frame_set(frame)
    engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    scene.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in engines else "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.render.film_transparent = True
    scene.render.filepath = path
    if not scene.world:
        world = bpy.data.worlds.new("W")
        scene.world = world
        world.use_nodes = True
        background = world.node_tree.nodes["Background"]
        background.inputs[0].default_value = (0.8, 0.85, 0.9, 1)
        background.inputs[1].default_value = 1.0
    cam = bpy.data.objects.get("PreviewCam")
    if not cam:
        data = bpy.data.cameras.new("PreviewCam")
        data.type = "ORTHO"
        data.ortho_scale = 2.9
        cam = bpy.data.objects.new("PreviewCam", data)
        scene.collection.objects.link(cam)
        sun = bpy.data.lights.new("Sun", "SUN")
        sun.energy = 3
        sun_obj = bpy.data.objects.new("Sun", sun)
        scene.collection.objects.link(sun_obj)
        sun_obj.rotation_euler = (math.radians(50), 0, math.radians(-30))
    scene.camera = cam
    a, e, dist, target = math.radians(angle), math.radians(8), 6.0, 1.2
    cam.location = (dist * math.sin(a) * math.cos(e), -dist * math.cos(a) * math.cos(e), target + dist * math.sin(e))
    cam.rotation_euler = (Vector((0, 0, target)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    bpy.ops.render.render(write_still=True)


# ---------------------------------------------------------------------------------------

def build_variant(name):
    reset_scene()
    arm, body = import_mannequin()
    material = body.data.materials[0]
    source = next(img for img in bpy.data.images if img.size[0] > 0)
    atlas = build_atlas(source)
    for node in material.node_tree.nodes:
        if node.type == "TEX_IMAGE":
            node.image = atlas
    factory = VARIANTS[name]
    scheme, make_parts = factory(arm) if factory.__code__.co_argcount else factory()
    recolour(body, scheme)
    attach(body, make_parts())
    body.name = f"Robot_{name}"
    return arm, body


def select_only(objects):
    """The exporter reads the real selection, not a context override."""
    for obj in bpy.data.objects:
        obj.select_set(obj in objects)
    bpy.context.view_layer.objects.active = objects[0]


def export_variant(name, arm, body):
    path = os.path.join(OUT_DIR, f"robot-{name}.glb")
    select_only([arm, body])
    with bpy.context.temp_override(active_object=arm):
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True,
                                  export_animations=False, export_apply=False)
    print("EXPORTED", path)


def export_clips():
    """The animation pack: the skeleton alone, one action per clip."""
    reset_scene()
    arm, body = import_mannequin()
    for name in CLIPS:
        bake_clip(arm, name)
    path = os.path.join(OUT_DIR, "Rig_Medium_Fest.glb")
    select_only([arm])
    with bpy.context.temp_override(active_object=arm):
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True,
                                  export_animations=True, export_animation_mode="ACTIONS",
                                  export_force_sampling=True)
    print("EXPORTED", path)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    if PREVIEW_DIR:
        os.makedirs(PREVIEW_DIR, exist_ok=True)
    for name in VARIANTS:
        if ONLY and name not in ONLY:
            continue
        arm, body = build_variant(name)
        export_variant(name, arm, body)
        if PREVIEW_DIR:
            clip = PREVIEW_CLIP[name]
            frames, _ = CLIPS[clip]()
            for index, frame in enumerate((0, frames // 4)):
                pose_clip(arm, clip, frame)
                preview(os.path.join(PREVIEW_DIR, f"{name}-{index}.png"))
    if not ONLY or "clips" in ONLY:
        export_clips()


main()
