#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 PWA 图标与 favicon —— 零第三方依赖（只用 zlib + struct 手写 PNG/ICO）。

为什么要有这个脚本：
    manifest.webmanifest 的 icons 与 index.html 的 favicon 都指向真实文件。
    图标是「可安装 PWA」的硬前提（offline-sync-contract §7.1 的 display=standalone
    只有在真的能装到主屏时才有意义）。手搓二进制不可复跑，故脚本入库。

产物：
    frontend/public/favicon.ico                    （内嵌 32x32 PNG）
    frontend/public/icons/icon-192.png
    frontend/public/icons/icon-512.png
    frontend/public/icons/icon-maskable-512.png     （内容缩到 80% 安全区）

用法：
    python tools/make-icons.py
"""

from __future__ import annotations

import os
import struct
import zlib

# ----------------------------------------------------------------------------
# 配色（与 index.html 的 theme-color 一致）
# ----------------------------------------------------------------------------
BG = (0x11, 0x18, 0x27)  # #111827
FG = (0xF9, 0xFA, 0xFB)  # #f9fafb
ACCENT = (0x34, 0xD3, 0x99)  # #34d399

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(REPO, "frontend", "public")
ICONS = os.path.join(PUBLIC, "icons")


def _png(width: int, height: int, rgba: bytes) -> bytes:
    """把原始 RGBA 字节编成 PNG（单张 IDAT，无隔行）。"""
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        raw += rgba[y * stride : (y + 1) * stride]

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def _draw(size: int, inset_ratio: float) -> bytes:
    """
    画一枚「三根柱状图」标记。
    inset_ratio = 0 表示铺满画布；0.10 表示四周留 10% 安全区（maskable 用）。
    """
    px = bytearray(size * size * 4)
    pad = int(size * inset_ratio)
    inner = size - 2 * pad

    # 柱状图几何：三根柱，宽度各 1/7 画布，高度 3/8、6/8、4.5/8
    bar_w = inner / 7.0
    heights = (0.38, 0.62, 0.46)
    gap = inner - bar_w * 3  # 两段间隙合计
    step = gap / 2.0

    base_y = pad + inner  # 柱脚（画布下方）
    for y in range(size):
        for x in range(size):
            i = (y * size + x) * 4
            r, g, b, a = BG[0], BG[1], BG[2], 255

            # 判定是否落在某一根柱内（坐标换算到 inner 空间）
            ix = x - pad
            iy = y - pad
            if 0 <= ix < inner and 0 <= iy < inner:
                for k, h in enumerate(heights):
                    x0 = k * (bar_w + step)
                    top = inner * (1.0 - h)
                    if x0 <= ix < x0 + bar_w and iy >= top:
                        r, g, b = ACCENT if k == 1 else FG
                        break

            px[i] = r
            px[i + 1] = g
            px[i + 2] = b
            px[i + 3] = a

            # 圆角：四角半径 18% 裁掉（只对非 maskable 版）
            if inset_ratio == 0.0:
                rad = size * 0.18
                cx = min(x, size - 1 - x)
                cy = min(y, size - 1 - y)
                if cx < rad and cy < rad:
                    dx = rad - cx
                    dy = rad - cy
                    if dx * dx + dy * dy > rad * rad:
                        px[i + 3] = 0

    return bytes(px)


def _ico(png_bytes: bytes, size: int) -> bytes:
    """把一张 PNG 包进 ICO 容器（ICO 允许直接内嵌 PNG 数据）。"""
    header = struct.pack("<HHH", 0, 1, 1)  # reserved, type=icon, count=1
    dim = 0 if size >= 256 else size
    entry = struct.pack(
        "<BBBBHHII",
        dim,
        dim,
        0,
        0,
        1,
        32,
        len(png_bytes),
        6 + 16,  # 数据偏移：ICONDIR(6) + ICONDIRENTRY(16)
    )
    return header + entry + png_bytes


def main() -> int:
    os.makedirs(ICONS, exist_ok=True)
    written = []

    for name, size, inset in (
        ("icon-192.png", 192, 0.0),
        ("icon-512.png", 512, 0.0),
        ("icon-maskable-512.png", 512, 0.10),
    ):
        path = os.path.join(ICONS, name)
        with open(path, "wb") as fh:
            fh.write(_png(size, size, _draw(size, inset)))
        written.append((path, os.path.getsize(path)))

    fav_size = 32
    fav = _ico(_png(fav_size, fav_size, _draw(fav_size, 0.0)), fav_size)
    fav_path = os.path.join(PUBLIC, "favicon.ico")
    with open(fav_path, "wb") as fh:
        fh.write(fav)
    written.append((fav_path, os.path.getsize(fav_path)))

    for path, size in written:
        print("%8d B  %s" % (size, os.path.relpath(path, REPO)))
    print("共 %d 个文件。" % len(written))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
