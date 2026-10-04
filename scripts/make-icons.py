#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从源图生成插件图标 icons/icon{16,48,128}.png。

用法: python3 scripts/make-icons.py [源图路径]
默认源图: assets/icon-source.png
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ICONS = os.path.join(ROOT, "icons")
DEFAULT_SOURCE = os.path.join(ROOT, "assets", "icon-source.png")

# 猫头 + 耳机特写在源图中的取景框（相对宽高的分数坐标），
# 上移底部边界以避开原图右下角的水印。
CROP = (0.171, 0.020, 0.664, 0.513)
SIZES = (16, 48, 128)
RADIUS_RATIO = 0.16
SHARPEN_SIZES = {16, 48}


def build(size, crop):
    image = crop.resize((size, size), Image.LANCZOS)
    if size in SHARPEN_SIZES:
        # 小尺寸先锐化，16px 下仍能认出主体轮廓
        image = image.filter(ImageFilter.UnsharpMask(radius=1.2, percent=110, threshold=2))
    image = image.convert("RGBA")

    # 圆角遮罩走 4 倍超采样，缩小后边缘抗锯齿
    scale = 4
    side = size * scale
    mask = Image.new("L", (side, side), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, side - 1, side - 1],
        radius=int(size * RADIUS_RATIO * scale),
        fill=255,
    )
    image.putalpha(mask.resize((size, size), Image.LANCZOS))
    return image


def main():
    source_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SOURCE
    if not os.path.exists(source_path):
        raise SystemExit(f"找不到源图: {source_path}")

    source = Image.open(source_path).convert("RGB")
    width, height = source.size
    crop = source.crop(
        (
            int(CROP[0] * width),
            int(CROP[1] * height),
            int(CROP[2] * width),
            int(CROP[3] * height),
        )
    )

    os.makedirs(ICONS, exist_ok=True)
    for size in SIZES:
        path = os.path.join(ICONS, f"icon{size}.png")
        build(size, crop).save(path)
        print(f"生成 {os.path.relpath(path, ROOT)}")


if __name__ == "__main__":
    main()
