"""生成 Viskluke 应用图标（build/icon.ico + build/icon.png）

风格跟界面一致：深色圆角方块 + 白色 V + 一点蓝色的下划强调。
只依赖 Pillow，输出多尺寸 ICO（16~256）与 512 PNG。
"""

import os
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "build")
os.makedirs(OUT_DIR, exist_ok=True)

BG_TOP = (30, 30, 46)       # #1e1e2e 界面背景色
BG_BOTTOM = (24, 24, 39)
ACCENT = (59, 130, 246)     # 蓝色强调（跟 .btn 一致）
FG = (250, 250, 252)

SCALE = 4                   # 先画大图再缩小，边缘更干净
SIZE = 256
BIG = SIZE * SCALE


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def find_font(size):
    """找一个能画出 V 的字体；找不到就退回默认（放大后依然可用）"""
    candidates = [
        r"C:\Windows\Fonts\seguisb.ttf",
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\arial.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    try:
        return ImageFont.load_default(size)
    except Exception:
        return ImageFont.load_default()


def build():
    img = Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 竖向渐变的圆角底色
    for y in range(BIG):
        t = y / max(1, BIG - 1)
        color = tuple(
            int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)
        ) + (255,)
        draw.line([(0, y), (BIG, y)], fill=color)

    # 用一个圆角蒙版把渐变裁成圆角方块
    mask = Image.new("L", (BIG, BIG), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, BIG - 1, BIG - 1], radius=int(BIG * 0.22), fill=255
    )
    img.putalpha(mask)

    # 白色 V
    font = find_font(int(BIG * 0.62))
    text = "V"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(
        ((BIG - tw) / 2 - bbox[0], (BIG - th) / 2 - bbox[1] - BIG * 0.055),
        text,
        font=font,
        fill=FG,
    )

    # 底部一条蓝色短线，呼应 UI 里的按钮
    bar_w, bar_h = int(BIG * 0.30), int(BIG * 0.055)
    bar_x = (BIG - bar_w) // 2
    bar_y = int(BIG * 0.745)
    draw.rounded_rectangle(
        [bar_x, bar_y, bar_x + bar_w, bar_y + bar_h],
        radius=bar_h // 2,
        fill=ACCENT + (255,),
    )

    icon = img.resize((SIZE, SIZE), Image.LANCZOS)
    png_path = os.path.join(OUT_DIR, "icon.png")
    icon.resize((512, 512), Image.LANCZOS).save(png_path)

    ico_path = os.path.join(OUT_DIR, "icon.ico")
    icon.save(
        ico_path,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("icon.ico:", ico_path, os.path.getsize(ico_path), "bytes")
    print("icon.png:", png_path, os.path.getsize(png_path), "bytes")


if __name__ == "__main__":
    build()
