"""Erzeugt die PNG-App-Icons aus derselben Geometrie wie icon.svg (braucht Pillow).

    python web/icons/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
BLUE, FLAP, PAPER, PHOTO, LINE = "#1d4e89", "#cfdcec", "#ffffff", "#9fb8d6", "#b7c7da"

# (x, y, w, h, radius, farbe) – identisch mit icon.svg (512er-Raster)
SHAPES = [
    (88, 200, 70, 184, 16, FLAP),
    (120, 128, 272, 256, 18, PAPER),
    (152, 162, 208, 34, 6, BLUE),
    (152, 220, 88, 74, 6, PHOTO),
    (256, 222, 104, 13, 6, LINE),
    (256, 251, 104, 13, 6, LINE),
    (256, 280, 78, 13, 6, LINE),
    (152, 316, 208, 13, 6, LINE),
    (152, 344, 160, 13, 6, LINE),
]


def render(size, maskable=False):
    s = 4 * size / 512                      # 4-fach zeichnen, dann verkleinern (Kantenglättung)
    img = Image.new("RGBA", (4 * size, 4 * size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, 4 * size, 4 * size], fill=BLUE)      # Android schneidet selbst zu
        k, off = 0.72, 256 * (1 - 0.72)                        # Inhalt in die sichere Zone
    else:
        d.rounded_rectangle([0, 0, 4 * size - 1, 4 * size - 1], radius=112 * s, fill=BLUE)
        k, off = 1.0, 0.0
    for x, y, w, h, r, c in SHAPES:
        x0, y0 = (off + x * k) * s, (off + y * k) * s
        d.rounded_rectangle([x0, y0, x0 + w * k * s, y0 + h * k * s], radius=r * k * s, fill=c)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    render(192).save(HERE / "icon-192.png")
    render(512).save(HERE / "icon-512.png")
    render(512, maskable=True).save(HERE / "icon-maskable-512.png")
    # iOS legt selbst runde Ecken an → volles Quadrat ohne Transparenz
    render(180, maskable=True).convert("RGB").save(HERE / "apple-touch-icon.png")
    print("Icons erzeugt in", HERE)
