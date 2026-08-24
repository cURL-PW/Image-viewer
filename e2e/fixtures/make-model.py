#!/usr/bin/env python3
"""E2E テスト用のダミー WD14 tagger モデルを生成する。

本物の WD14 モデル (数百 MB, Hugging Face からダウンロード) の代わりに、
同じ入出力形状を持つ小さな ONNX モデルを使ってタグ付け経路を検証する。

入力  : float32 [1, 448, 448, 3]  NHWC / BGR / 0-255 (WD14 と同じ前処理を期待)
出力  : float32 [1, 7]            0-1 の確信度

各タグは画像の平均色から決まるので、テスト側で期待値を組み立てられる。
    python3 e2e/fixtures/make-model.py
"""

import pathlib

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

HERE = pathlib.Path(__file__).parent

# selected_tags.csv と同じ並び順
TAGS = [
    ("red_image", 0),
    ("green_image", 0),
    ("blue_image", 0),
    ("bright", 0),
    ("warm_character", 4),
    ("general", 9),
    ("sensitive", 9),
]

# 平均色 (b, g, r) / 255 から各タグのスコアを作る行列。
# 補色を引いて「その色が支配的か」を測るので、白パディングの割合が変わっても
# 相対的な順序は保たれる。
WEIGHTS = np.array(
    [
        # red    green   blue   bright  warm    general sensitive
        [-0.90, -0.90, +1.80, 0.3333, 0.00, 0.0, 0.0],  # b
        [-0.90, +1.80, -0.90, 0.3333, 0.55, 0.0, 0.0],  # g
        [+1.80, -0.90, -0.90, 0.3333, 0.55, 0.0, 0.0],  # r
    ],
    dtype=np.float32,
)
# general は常に付くタグ、sensitive は常に付かないタグ (rating の argmax 確認用)
BIAS = np.array([0.0, 0.0, 0.0, 0.0, 0.0, 0.9, 0.1], dtype=np.float32)


def build() -> onnx.ModelProto:
    image = helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 448, 448, 3])
    scores = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, len(TAGS)])

    initializers = [
        numpy_helper.from_array(np.array([255.0], dtype=np.float32), "divisor"),
        numpy_helper.from_array(WEIGHTS, "weights"),
        numpy_helper.from_array(BIAS, "bias"),
        numpy_helper.from_array(np.array(0.0, dtype=np.float32), "lower"),
        numpy_helper.from_array(np.array(1.0, dtype=np.float32), "upper"),
    ]

    nodes = [
        # 空間方向を平均して [1, 3] (b, g, r) にする
        helper.make_node("ReduceMean", ["input"], ["mean"], axes=[1, 2], keepdims=0),
        helper.make_node("Div", ["mean", "divisor"], ["norm"]),
        helper.make_node("MatMul", ["norm", "weights"], ["projected"]),
        helper.make_node("Add", ["projected", "bias"], ["raw"]),
        helper.make_node("Clip", ["raw", "lower", "upper"], ["output"]),
    ]

    graph = helper.make_graph(nodes, "dummy-wd14", [image], [scores], initializers)
    model = helper.make_model(
        graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="image-viewer-e2e"
    )
    model.ir_version = 8
    onnx.checker.check_model(model)
    return model


def main() -> None:
    onnx.save(build(), HERE / "model.onnx")

    lines = ["tag_id,name,category,count"]
    for index, (name, category) in enumerate(TAGS):
        lines.append(f"{index},{name},{category},1000")
    (HERE / "selected_tags.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"wrote {HERE / 'model.onnx'} and {HERE / 'selected_tags.csv'}")


if __name__ == "__main__":
    main()
