# One scene of a 3D explainer (blueprint 6d), built and rendered by Blender in the background:
#
#   blender -b --factory-startup -P blender/explainer3d.py -- scene.json out.mp4
#
# scene.json: {"layout": "Title3D" | "Bars3D" | "Words3D", "data": {...}, "frames": 120, "fps": 24,
#              "width": 1280, "height": 720, "primary": "#b3121f", "accent": "#ffc400", "cues": [0, 30, 60]}
#
# The engine writes the scene (what is said and when); this file only turns it into pictures. Workbench is the render
# engine: it needs no GPU, renders a minute of 720p in a few minutes on a laptop CPU, and its studio lighting and flat
# object colours read as clean motion graphics rather than as an unfinished photoreal scene. Elements arrive on their
# cue frames — the frame where the narration names them — with a short overshoot, and the camera never stops moving.
import bpy, json, math, os, sys, glob

argv = sys.argv[sys.argv.index("--") + 1:]
spec = json.load(open(argv[0], encoding="utf-8"))
out = os.path.abspath(argv[1])

bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene
fps, frames = int(spec.get("fps", 24)), max(24, int(spec.get("frames", 120)))
scn.render.fps, scn.frame_start, scn.frame_end = fps, 1, frames
scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage = int(spec.get("width", 1280)), int(spec.get("height", 720)), 100
vertical = scn.render.resolution_y > scn.render.resolution_x

def rgb(hexstr, fallback=(0.7, 0.1, 0.12)):
    h = str(hexstr or "").lstrip("#")
    if len(h) != 6: return fallback
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
primary, accent = rgb(spec.get("primary")), rgb(spec.get("accent"), (1.0, 0.77, 0.0))
dark = tuple(c * 0.18 for c in primary)
light = tuple(c + (1 - c) * 0.45 for c in primary)   # the brand colour lifted, so it stands out on the dark ground

scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading
sh.light, sh.color_type, sh.show_shadows, sh.show_cavity = "STUDIO", "OBJECT", True, True
world = bpy.data.worlds.new("bg"); world.color = dark; scn.world = world

def ease(t): return 1 - (1 - t) ** 3
def pop(obj, at, length=12):
    """Grow from nothing to full size, overshooting a little, starting at frame `at`."""
    at = max(1, int(at))
    obj.scale = (0.001, 0.001, 0.001); obj.keyframe_insert("scale", frame=at)
    obj.scale = (1.08, 1.08, 1.08); obj.keyframe_insert("scale", frame=at + int(length * 0.7))
    obj.scale = (1, 1, 1); obj.keyframe_insert("scale", frame=at + length)

def text(body, size, color, loc, extrude=0.06):
    cu = bpy.data.curves.new("t", type="FONT"); cu.body = str(body); cu.size = size; cu.extrude = extrude
    cu.bevel_depth = extrude * 0.25; cu.align_x, cu.align_y = "CENTER", "CENTER"
    ob = bpy.data.objects.new("t", cu); ob.color = (*color, 1); ob.location = loc; ob.rotation_euler = (math.radians(90), 0, 0)
    scn.collection.objects.link(ob); return ob

def bar(x, height, width, color):
    me = bpy.data.meshes.new("b")
    v = [(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0), (-1, -1, 2), (1, -1, 2), (1, 1, 2), (-1, 1, 2)]
    f = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    me.from_pydata(v, [], f); ob = bpy.data.objects.new("b", me); ob.color = (*color, 1)
    ob.location = (x, 0, 0); ob.scale = (width / 2, 0.35, max(0.001, height / 2))
    scn.collection.objects.link(ob); return ob

cues = [int(c) for c in spec.get("cues", [])]
def cue(i, default):
    return (cues[i] if i < len(cues) else default) + 1

data, layout = spec.get("data", {}), spec.get("layout", "Title3D")
span = 7.0 if vertical else 12.0
if layout == "Bars3D":
    items = [d for d in data.get("data", []) if isinstance(d, dict)][:6] or [{"label": "", "value": 1}]
    top = max(float(d.get("value") or 0) for d in items) or 1
    n, maxh = len(items), (4.6 if vertical else 3.6)
    step = span / n
    for i, d in enumerate(items):
        x = -span / 2 + step * (i + 0.5); h = max(0.05, float(d.get("value") or 0) / top * maxh); at = cue(i, 10 + i * 14)
        b = bar(x, h, step * 0.55, accent if i % 2 == 0 else light)
        b.scale.z = 0.001; b.keyframe_insert("scale", frame=at)
        b.scale.z = h / 2; b.keyframe_insert("scale", frame=at + 16)
        lab = text(d.get("label", ""), 0.42, (1, 1, 1), (x, -0.4, -0.45), 0.02); pop(lab, at)
        val = text(f'{d.get("value", "")}{data.get("unit", "")}', 0.48, (1, 1, 1), (x, -0.4, h + 0.35), 0.03); pop(val, at + 10)
    if data.get("heading"): pop(text(data["heading"], 0.72, (1, 1, 1), (0, -0.2, maxh + 1.1)), 1)
    look_z = (maxh + 1.1 - 0.5) / 2                     # the middle of everything from the labels up to the heading
elif layout == "Words3D":
    words = [str(w) for w in data.get("words", [])][:5] or [str(data.get("heading", ""))]
    if data.get("heading"): pop(text(data["heading"], 0.7, accent, (0, 0, 3.4 if vertical else 2.9)), 1)
    for i, w in enumerate(words):
        pop(text(w, 1.2 if vertical else 1.15, (1, 1, 1) if i % 2 else (*accent,), (0, 0, (1.7 if vertical else 1.5) - i * (1.55 if vertical else 1.4))), cue(i, 10 + i * 18))
    look_z = 0
else:  # Title3D
    t = text(data.get("title", ""), 1.1 if vertical else 1.6, (1, 1, 1), (0, 0, 0.6), 0.14); pop(t, cue(0, 4), 18)
    if data.get("subtitle"): pop(text(data["subtitle"], 0.65, accent, (0, 0, -0.9), 0.05), cue(0, 4) + 14)
    floor = bar(0, 0.02, span * 2, light); floor.location.z = -1.6
    look_z = 0

# A camera that keeps moving: a slow push in and a slight drift sideways over the whole scene.
cam_data = bpy.data.cameras.new("cam"); cam_data.lens = 35 if vertical else 40
cam = bpy.data.objects.new("cam", cam_data); scn.collection.objects.link(cam); scn.camera = cam
dist = 13.5 if vertical else 17.5   # a tall frame is narrow: closer, so the content fills it
def place(frame, y, x):
    cam.location = (x, y, look_z + 1.2)
    d = (0 - x, 0 - y, look_z - (look_z + 1.2)); cam.rotation_euler = (math.atan2(math.hypot(d[0], d[1]), -d[2]), 0, math.atan2(d[1], d[0]) - math.pi / 2)
    cam.keyframe_insert("location", frame=frame); cam.keyframe_insert("rotation_euler", frame=frame)
place(1, -dist, -0.4); place(frames, -dist * 0.94, 0.4)

scn.render.image_settings.file_format = "FFMPEG"
scn.render.ffmpeg.format, scn.render.ffmpeg.codec, scn.render.ffmpeg.constant_rate_factor = "MPEG4", "H264", "MEDIUM"
work = out + ".parts"; os.makedirs(work, exist_ok=True)
scn.render.filepath = os.path.join(work, "scene")
bpy.ops.render.render(animation=True)
# Blender names the file after the frame range; the engine wants the name it asked for.
made = sorted(glob.glob(os.path.join(work, "scene*")), key=os.path.getmtime)
if not made: raise SystemExit("Blender rendered nothing")
os.replace(made[-1], out)
for f in glob.glob(os.path.join(work, "*")): os.remove(f)
os.rmdir(work)
