"""Regenerate Android launcher icons and splash images from assets/icon-source.png.

Usage (from the repo root):  python3 scripts/generate_icons.py
Requires: pip install pillow
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "android/app/src/main/res"
SRC = Image.open(ROOT / "assets/icon-source.png").convert("RGBA")

# Gradient colours sampled from the artwork so adaptive-icon backgrounds blend in.
W = SRC.width
TOP = SRC.getpixel((W // 2, int(W * 0.08)))[:3]
BOTTOM = SRC.getpixel((W // 2, int(W * 0.92)))[:3]

LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ADAPTIVE = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}


def gradient(n):
    img = Image.new("RGB", (n, n))
    d = ImageDraw.Draw(img)
    for y in range(n):
        t = y / (n - 1)
        d.line([(0, y), (n, y)], fill=tuple(int(TOP[i] * (1 - t) + BOTTOM[i] * t) for i in range(3)))
    return img.convert("RGBA")


def art(n, scale=1.0):
    k = int(n * scale)
    canvas = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    canvas.alpha_composite(SRC.resize((k, k), Image.LANCZOS), ((n - k) // 2, (n - k) // 2))
    return canvas


def circle_mask(n):
    m = Image.new("L", (n * 4, n * 4), 0)
    ImageDraw.Draw(m).ellipse((0, 0, n * 4 - 1, n * 4 - 1), fill=255)
    return m.resize((n, n), Image.LANCZOS)


for dpi, n in LEGACY.items():
    out = RES / f"mipmap-{dpi}"
    art(n).save(out / "ic_launcher.png")
    round_icon = gradient(n)
    round_icon.alpha_composite(art(n, 0.86))
    round_icon.putalpha(circle_mask(n))
    round_icon.save(out / "ic_launcher_round.png")

for dpi, n in ADAPTIVE.items():
    out = RES / f"mipmap-{dpi}"
    art(n, 0.80).save(out / "ic_launcher_foreground.png")
    gradient(n).convert("RGB").save(out / "ic_launcher_background.png")

# Splash: neutral background with the icon centred, at each existing splash size.
for splash in RES.glob("drawable*/splash.png"):
    w, h = Image.open(splash).size
    img = Image.new("RGB", (w, h), (246, 247, 249))
    k = int(min(w, h) * 0.26)
    img.paste(SRC.resize((k, k), Image.LANCZOS), ((w - k) // 2, (h - k) // 2), SRC.resize((k, k), Image.LANCZOS))
    img.save(splash)

print("Icons generated.")
