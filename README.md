# Image Viewer

指定したフォルダを再帰的に読み込み、WD14 tagger による自動タグ付けとタグ絞り込みができるデスクトップ画像ビューアーです。

詳細な仕様は [SPEC.md](./SPEC.md) を参照してください。

## 主な機能

- **再帰読み込み** — ルートフォルダ配下のすべての画像 (jpg / png / webp / gif / bmp / avif) を収集
- **リアルタイム反映** — ファイルの追加・変更・削除を監視して即座に反映。起動時は差分同期で、アプリを閉じている間の変化にも追随
- **ビューアー** — 既定でウィンドウ幅いっぱい (fit-width) に表示。画像の左右端クリックで前後の画像へ、ホイールでカーソル位置を中心に拡大縮小、ドラッグでパン、ダブルクリックで元に戻す
- **ライブラリ** — フォルダ階層ツリー (枚数バッジ付き) と仮想スクロールのサムネイルグリッド
- **自動タグ付け** — WD14 tagger (ONNX) でバックグラウンドスキャン。GPU があれば CUDA / DirectML、なければ CPU で実行
- **タグ絞り込み** — タグの AND / OR / 除外 (NOT) と、フォルダ選択の組み合わせで絞り込み

## 動作環境

- Node.js 20 以降 (開発時)
- Windows / macOS / Linux
- タグ付けの GPU 実行 (任意)
  - Windows: CUDA 12 + cuDNN、または DirectML
  - Linux: CUDA 12 + cuDNN
  - macOS: 現状 CPU 実行 (CoreML 対応は将来)

GPU が使えない場合は自動的に CPU にフォールバックするため、追加のセットアップなしで動作します。

## セットアップ

```bash
npm install
npm run dev
```

GPU 用バイナリのダウンロードを省略したい場合は、環境変数を付けてインストールします。

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install
```

## 使い方

起動後に「フォルダを開く」から画像フォルダを選ぶと、配下を再帰的に読み込みます。コマンドラインからフォルダを指定することもできます。

```bash
# パッケージ版
image-viewer /path/to/images
image-viewer --root /path/to/images

# 開発時 (electron-vite が --root を解釈してしまうため環境変数を使う)
IMAGE_VIEWER_ROOT=/path/to/images npm run dev
```

初回のタグ付け時に、選択中の WD14 モデル (既定: `SmilingWolf/wd-eva02-large-tagger-v3`) を Hugging Face から自動ダウンロードし、以降はローカルにキャッシュします。

### 操作

| 操作 | 動作 |
| --- | --- |
| サムネイルをクリック | 単画像ビューを開く |
| 画像の左端 / 右端をクリック | 前 / 次の画像へ (等倍表示のときのみ) |
| ホイール | カーソル位置を中心に拡大縮小 |
| Shift + ホイール | 縦スクロール |
| ドラッグ | パン |
| ダブルクリック | ウィンドウ幅に合わせて表示 |
| ← / → , PageUp / PageDown | 前 / 次の画像へ |
| Home / End | 先頭 / 末尾の画像へ |
| Esc | 一覧へ戻る |

### タグ絞り込み

サイドバーのタグ一覧はフォルダ選択の範囲で集計されます。タグ名をクリックすると「そのタグを含む」条件、行右端の `−` で「そのタグを除外する」条件になります。複数タグは AND / OR を切り替えられ、フォルダ選択とも組み合わさります。

しきい値やモデルを変更すると付与されるタグが変わるため、全画像が自動で再スキャンされます。

## 開発

```bash
npm run dev        # 開発サーバー + Electron 起動
npm run build      # 型チェック + ビルド
npm test           # ユニットテスト (vitest)
npm run e2e        # E2E テスト (Playwright + Electron)
npm run dist       # インストーラ / パッケージを作成
```

E2E テストは Hugging Face からモデルを取得せず、同じ入出力形状のダミー ONNX モデル (`e2e/fixtures/model.onnx`) を使ってタグ付け経路を検証します。ダミーモデルは次のコマンドで再生成できます。

```bash
pip install onnx numpy
python3 e2e/fixtures/make-model.py
```

ヘッドレス環境では `xvfb-run -a npm run e2e` のように実行してください。

### 構成

```
src/
├─ main/            メインプロセス
│  ├─ index.ts        起動・ウィンドウ・プロトコル登録
│  ├─ db.ts           SQLite スキーマとクエリ
│  ├─ library.ts      再帰走査・差分同期・ファイル監視
│  ├─ thumbnails.ts   サムネイル生成とディスクキャッシュ
│  ├─ protocol.ts     app-image:// / app-thumb:// の配信
│  ├─ ipc.ts          IPC ハンドラ
│  └─ tagger/         モデル管理・推論ワーカー・スキャンキュー
├─ preload/         contextBridge で公開する API
├─ renderer/        React UI
└─ shared/          main と renderer で共有する型と IPC 契約
```

### 設計上のメモ

- **SQLite は Electron 内蔵の `node:sqlite` を使用** — ネイティブモジュールの再ビルドが不要になり、配布時の環境依存を減らせます。実験的 API のため起動時に警告が出ますが動作に影響はありません
- **推論は utilityProcess で実行** — onnxruntime と sharp の重い処理をメインプロセスから切り離し、UI の応答性を保ちます
- **画像は ID でのみ参照** — renderer にはファイルパスを渡さず、`app-image://` プロトコル側でルート配下かを検証してから配信します
- **並び順は自然順** — `p2.jpg` が `p10.jpg` より前に来るよう、DB に自然順ソート用のキーを持たせています

## ライセンス

MIT
