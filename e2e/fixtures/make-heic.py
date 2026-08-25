#!/usr/bin/env python3
"""E2E / ユニットテスト用の HEIC サンプルを生成する。

iPhone が撮る HEIC と同じ HEVC 符号化のファイルを作る。sharp のプリビルドは
HEVC を復号できないため、これらは WASM 版 libheif を通す経路の検証に使う。

    pip install pillow-heif
    python3 e2e/fixtures/make-heic.py
"""

import pathlib

import pillow_heif
from PIL import Image, ImageDraw

HERE = pathlib.Path(__file__).parent

pillow_heif.register_heif_opener()


def draw_marker(width: int, height: int) -> Image.Image:
    """上下左右が判別できる画像。向きの扱いを検証するために使う。"""
    image = Image.new("RGB", (width, height), (30, 90, 170))
    draw = ImageDraw.Draw(image)
    # 上辺だけ赤、左辺だけ黄にして回転を判定できるようにする
    draw.rectangle([0, 0, width - 1, height // 8], fill=(220, 60, 60))
    draw.rectangle([0, 0, width // 8, height - 1], fill=(230, 200, 70))
    return image


def main() -> None:
    # 通常の HEIC (向きの指定なし)
    draw_marker(640, 480).save(HERE / "sample.heic", format="HEIF", quality=80)

    # EXIF orientation = 6 (時計回りに 90 度回して表示すべき画像)
    rotated = draw_marker(480, 640)
    exif = Image.Exif()
    exif[0x0112] = 6
    rotated.save(HERE / "sample-rotated.heic", format="HEIF", quality=80, exif=exif)

    for name in ("sample.heic", "sample-rotated.heic"):
        path = HERE / name
        print(f"wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
