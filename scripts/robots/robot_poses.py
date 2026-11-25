"""
Poses and clips for the robot variants (see build_robot_variants.py).

Every clip is a function of the frame: torso rotations, a hips offset, and where the
hands and feet go. A small two-bone IK turns hand/foot targets into arm/leg rotations, so
a clip reads like a stage direction ("left hand on the guitar neck, right hand strums")
rather than a list of bone angles. Rotations are absolute deltas in armature space about
each bone's head; a bone with nothing set follows its parent.

Rest pose (Rig_Medium): T-pose, facing -Y, up +Z. Shoulders at (+-0.212, 0, 1.107), arms
0.5 to the wrist; hips at z 0.52, legs 0.376 to the ankle; the head is big (z 1.10-2.20,
reaching y -0.54 in front), which is why hands stay low and in front of the body.
"""

import math

import bpy
from mathutils import Quaternion, Vector


def rot(axis, degrees):
    return Quaternion(Vector(axis).normalized(), math.radians(degrees))


def clear_pose(arm):
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)


class Pose:
    """One frame: torso rotations, a hips offset and IK targets."""

    def __init__(self):
        self.deltas = {}
        self.hips = Vector((0, 0, 0))
        self.targets = {}   # limb -> (wrist/ankle target, pole direction)

    def turn(self, bone, quaternion):
        self.deltas[bone] = quaternion @ self.deltas.get(bone, Quaternion())
        return self


LIMBS = {
    "arm.l": ("upperarm.l", "lowerarm.l"),
    "arm.r": ("upperarm.r", "lowerarm.r"),
    "leg.l": ("upperleg.l", "lowerleg.l"),
    "leg.r": ("upperleg.r", "lowerleg.r"),
}


def _absolute(arm, deltas):
    result = {}
    for pb in arm.pose.bones:  # parents come before children
        parent = result.get(pb.parent.name, Quaternion()) if pb.parent else Quaternion()
        result[pb.name] = deltas.get(pb.name, parent)
    return result


def _write_bases(arm, deltas, hips):
    full = _absolute(arm, deltas)
    for pb in arm.pose.bones:
        rest = pb.bone.matrix_local.to_quaternion()
        parent = full.get(pb.parent.name, Quaternion()) if pb.parent else Quaternion()
        pb.rotation_quaternion = rest.inverted() @ parent.inverted() @ full[pb.name] @ rest
        pb.location = (0, 0, 0)
    hips_pb = arm.pose.bones["hips"]
    hips_pb.location = hips_pb.bone.matrix_local.to_quaternion().inverted() @ hips


def two_bone(start, target, upper, lower, pole):
    """Elbow (or knee) and end positions reaching toward `target`, bending toward `pole`."""
    to_target = target - start
    distance = min(max(to_target.length, abs(upper - lower) + 1e-3), upper + lower - 1e-3)
    axis = to_target.normalized()
    along = (upper * upper - lower * lower + distance * distance) / (2 * distance)
    height = math.sqrt(max(0.0, upper * upper - along * along))
    pole = Vector(pole)
    side = pole - axis * pole.dot(axis)
    side = side.normalized() if side.length > 1e-6 else Vector((0, 0, 1))
    return start + axis * along + side * height, start + axis * distance


def apply_pose(arm, pose):
    """Writes `pose` into the armature's bones (not keyed)."""
    clear_pose(arm)
    deltas = dict(pose.deltas)
    _write_bases(arm, deltas, pose.hips)
    bpy.context.view_layer.update()
    for limb, (target, pole) in pose.targets.items():
        upper_name, lower_name = LIMBS[limb]
        upper_pb, lower_pb = arm.pose.bones[upper_name], arm.pose.bones[lower_name]
        upper_vec = upper_pb.bone.tail_local - upper_pb.bone.head_local
        lower_vec = lower_pb.bone.tail_local - lower_pb.bone.head_local
        start = upper_pb.head.copy()
        elbow, end = two_bone(start, Vector(target), upper_vec.length, lower_vec.length, pole)
        deltas[upper_name] = upper_vec.normalized().rotation_difference((elbow - start).normalized())
        deltas[lower_name] = lower_vec.normalized().rotation_difference((end - elbow).normalized())
        for child in lower_pb.children_recursive:
            extra = pose.deltas.get(child.name)
            deltas[child.name] = extra @ deltas[lower_name] if extra else deltas[lower_name]
        _write_bases(arm, deltas, pose.hips)
        bpy.context.view_layer.update()


def around(point, quaternion, pivot):
    return pivot + quaternion @ (Vector(point) - pivot)


SHOULDER = {"l": Vector((0.212, 0, 1.107)), "r": Vector((-0.212, 0, 1.107))}
ANKLE = {"l": Vector((0.171, 0.019, 0.145)), "r": Vector((-0.171, 0.019, 0.145))}
KNEE_POLE = (0, -1, 0.15)
SPINE_PIVOT = Vector((0, 0, 0.6))


def planted_feet(pose):
    for side in "lr":
        pose.targets[f"leg.{side}"] = (ANKLE[side], KNEE_POLE)


# ---------------------------------------------------------------------------------------
# Props the clips hold, shared with the costume builder.

GUITAR_CENTER = Vector((-0.06, -0.34, 0.84))
GUITAR_NECK_HAND = Vector((0.38, -0.38, 0.99))
MIC_HAND = Vector((-0.1, -0.44, 1.23))
KEYBOARD_TOP = 0.8
KEYBOARD_Y = -0.48


# ---------------------------------------------------------------------------------------
# Clips: (frames, pose_at(frame)). They loop: frame `frames` equals frame 0.

def clip_fest_sway():
    """Schunkeln: swaying side to side, hands on the hips, knees giving a little."""
    frames = 60

    def pose_at(f):
        p = 2 * math.pi * f / frames
        lean = rot((0, 1, 0), 6 * math.sin(p))
        pose = Pose().turn("spine", lean).turn("head", rot((0, 1, 0), -3 * math.sin(p)) @ lean)
        pose.hips = Vector((0, 0, -0.018 * (1 - math.cos(2 * p)) / 2))
        planted_feet(pose)
        for side, sign in (("l", 1), ("r", -1)):
            hand = around((sign * 0.37, -0.13, 0.8), lean, SPINE_PIVOT) + pose.hips
            pose.targets[f"arm.{side}"] = (hand, (sign, 0.3, 0))
        return pose

    return frames, pose_at


def clip_fest_march():
    """A parade step on the spot: knees high, straight arms swinging."""
    frames = 24

    def pose_at(f):
        p = 2 * math.pi * f / frames
        lift = {"l": max(0.0, math.sin(p)), "r": max(0.0, -math.sin(p))}
        pose = Pose().turn("spine", rot((1, 0, 0), -3)).turn("head", rot((1, 0, 0), -3))
        pose.hips = Vector((0, 0, 0.022 * abs(math.sin(p))))
        for side in "lr":
            ankle = ANKLE[side] + Vector((0, -0.09 * lift[side], 0.16 * lift[side]))
            pose.targets[f"leg.{side}"] = (ankle, KNEE_POLE)
        swing = 38 * math.sin(p)
        for side, sign, angle in (("l", 1, -swing), ("r", -1, swing)):
            a = math.radians(angle)
            hand = SHOULDER[side] + Vector((sign * 0.2, -0.44 * math.sin(a), -0.44 * math.cos(a))) + pose.hips
            pose.targets[f"arm.{side}"] = (hand, (sign * 0.6, 0.8, 0))
        return pose

    return frames, pose_at


def clip_fest_hop():
    """The parade's dance: a short hop, then a beat standing, arms loose at the sides.

    Half the cycle is the hop (crouch, off the floor, land), half is standing. The game
    starts every other robot half a cycle later, so one lands as the next takes off: a
    wave running down the column.
    """
    frames = 24

    def pose_at(f):
        u = (f % frames) / frames * 2  # 0..1 hopping, 1..2 standing
        lift = 0.0
        crouch = 0.0
        if u < 1:
            if u < 0.18:
                crouch = -0.05 * math.sin(math.pi * u / 0.18)
            elif u < 0.82:
                lift = 0.15 * math.sin(math.pi * (u - 0.18) / 0.64)
            else:
                crouch = -0.05 * math.sin(math.pi * (u - 0.82) / 0.18)
        else:
            crouch = -0.008 * math.sin(math.pi * (u - 1))
        pose = Pose().turn("spine", rot((1, 0, 0), 3 * lift / 0.15)).turn("head", rot((1, 0, 0), -4 * lift / 0.15))
        pose.hips = Vector((0, 0, lift + crouch))
        for side in "lr":
            # Feet leave the floor with the body, tucked a little under it in the air.
            pose.targets[f"leg.{side}"] = (ANKLE[side] + Vector((0, 0.02 * lift / 0.15, lift * 0.85)), KNEE_POLE)
        for side, sign in (("l", 1), ("r", -1)):
            spread = 0.1 * lift / 0.15
            hand = Vector((sign * (0.42 + spread), -0.06, 0.67 + lift + crouch + 0.06 * lift / 0.15))
            pose.targets[f"arm.{side}"] = (hand, (sign, 0.3, 0))
        return pose

    return frames, pose_at


def clip_wedding_bouquet():
    """The bride: bouquet held in both hands, a gentle sway and a look around."""
    frames = 60

    def pose_at(f):
        p = 2 * math.pi * f / frames
        lean = rot((0, 1, 0), 3 * math.sin(p))
        head = rot((0, 0, 1), 7 * math.sin(p)) @ rot((0, 1, 0), 4 * math.sin(p)) @ lean
        pose = Pose().turn("spine", lean).turn("head", head)
        planted_feet(pose)
        for side, sign in (("l", 1), ("r", -1)):
            hand = around((sign * 0.09, -0.36, 0.86 + 0.015 * math.sin(2 * p)), lean, SPINE_PIVOT)
            pose.targets[f"arm.{side}"] = (hand, (sign, 0.2, -0.4))
        return pose

    return frames, pose_at


def clip_wedding_groom():
    """The groom: chest out, hands behind his back, rocking on his heels with a nod."""
    frames = 60

    def pose_at(f):
        p = 2 * math.pi * f / frames
        proud = rot((1, 0, 0), -5)
        nod = rot((1, 0, 0), 6 * max(0.0, math.sin(2 * p)) - 4)
        pose = Pose().turn("spine", proud).turn("head", nod @ proud)
        pose.hips = Vector((0, 0, 0.012 * math.sin(2 * p)))
        planted_feet(pose)
        for side, sign in (("l", 1), ("r", -1)):
            hand = around((sign * 0.13, 0.3, 0.8), proud, SPINE_PIVOT) + pose.hips
            pose.targets[f"arm.{side}"] = (hand, (sign, 0.6, 0))
        return pose

    return frames, pose_at


def clip_band_guitar():
    """Strumming twice a second, fretting hand sliding a little, head banging gently."""
    frames = 30

    def pose_at(f):
        p = 2 * math.pi * f / frames
        bob = rot((1, 0, 0), 2.5 * math.sin(2 * p))
        pose = Pose().turn("spine", bob).turn("head", rot((1, 0, 0), 9 * math.sin(2 * p)) @ bob)
        pose.hips = Vector((0, 0, -0.012 * (1 + math.sin(2 * p))))
        planted_feet(pose)
        strum = 0.06 * math.sin(4 * p)
        right = around(GUITAR_CENTER + Vector((-0.04, -0.07, 0.04 + strum)), bob, SPINE_PIVOT) + pose.hips
        left = around(GUITAR_NECK_HAND + Vector((0.02 * math.sin(p), 0, 0)), bob, SPINE_PIVOT) + pose.hips
        pose.targets["arm.r"] = (right, (-1, 0.4, -0.2))
        pose.targets["arm.l"] = (left, (1, 0.4, -0.6))
        return pose

    return frames, pose_at


def clip_band_sing():
    """Microphone at the mouth, the other arm out and waving, swaying with the song."""
    frames = 60

    def pose_at(f):
        p = 2 * math.pi * f / frames
        sway = rot((0, 1, 0), 5 * math.sin(p))
        head = rot((0, 1, 0), 6 * math.sin(p)) @ rot((1, 0, 0), -6) @ sway
        pose = Pose().turn("spine", sway).turn("head", head)
        planted_feet(pose)
        mic = around(MIC_HAND, sway, SPINE_PIVOT)
        left = around((0.58, -0.22, 1.25 + 0.12 * math.sin(p)), sway, SPINE_PIVOT)
        pose.targets["arm.r"] = (mic, (-1, 0.2, -0.6))
        pose.targets["arm.l"] = (left, (0.3, 0.5, -1))
        return pose

    return frames, pose_at


def clip_band_keyboard():
    """Both hands on the keys, pressing in turn, head nodding to the beat."""
    frames = 30

    def pose_at(f):
        p = 2 * math.pi * f / frames
        sway = rot((0, 1, 0), 3 * math.sin(p))
        pose = Pose().turn("spine", sway).turn("head", rot((1, 0, 0), 8 * math.sin(2 * p)) @ sway)
        planted_feet(pose)
        for side, sign, phase in (("l", 1, 0.0), ("r", -1, math.pi)):
            press = max(0.0, math.sin(4 * p + phase))
            hand = Vector((sign * (0.16 + 0.07 * math.sin(p + phase)), KEYBOARD_Y + 0.1,
                           KEYBOARD_TOP + 0.07 - 0.04 * press))
            pose.targets[f"arm.{side}"] = (hand, (sign, 0.3, -0.3))
        return pose

    return frames, pose_at


CLIPS = {
    "Fest_Sway": clip_fest_sway,
    "Fest_March": clip_fest_march,
    "Fest_Hop": clip_fest_hop,
    "Wedding_Bouquet": clip_wedding_bouquet,
    "Wedding_Groom": clip_wedding_groom,
    "Band_Guitar": clip_band_guitar,
    "Band_Sing": clip_band_sing,
    "Band_Keyboard": clip_band_keyboard,
}


def pose_clip(arm, clip, frame=0):
    """Puts the armature in a clip's pose (for binding hand-held props, and previews)."""
    _, pose_at = CLIPS[clip]()
    apply_pose(arm, pose_at(frame))


def bind_to_pose(arm, obj, bone):
    """Moves a part placed where `bone` is in the current pose back to the rest pose.

    Hand-held props are easiest to place in the pose that holds them; the skin binds in
    rest, so the part is carried back by the bone's own pose transform.
    """
    pb = arm.pose.bones[bone]
    obj.data.transform(pb.bone.matrix_local @ pb.matrix.inverted())
    obj.data.update()


def bake_clip(arm, name):
    frames, pose_at = CLIPS[name]()
    arm.animation_data_create()
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    arm.animation_data.action = action
    for frame in range(frames + 1):
        apply_pose(arm, pose_at(frame % frames))
        for pb in arm.pose.bones:
            pb.keyframe_insert("rotation_quaternion", frame=frame)
            pb.keyframe_insert("location", frame=frame)
    return action
