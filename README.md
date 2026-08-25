# Image Viewer

指定したフォルダを再帰的に読み込み、WD14 tagger による自動タグ付けとタグ絞り込みができるデスクトップ画像ビューアーです。

詳細な仕様は [SPEC.md](./SPEC.md) を参照してください。

## 主な機能

- **再帰読み込み** — ルートフォルダ配下のすべての画像 (jpg / png / webp / gif / bmp / avif / **heic**) を収集
- **iCloud / iPhone の写真** — HEIC をそのまま閲覧・タグ付けできる。同期フォルダを開くだけで使える
- **リアルタイム反映** — ファイルの追加・変更・削除を監視して即座に反映。起動時は差分同期で、アプリを閉じている間の変化にも追随
- **ビューアー** — 既定でウィンドウ幅いっぱい (fit-width) に表示。画像の左右端クリックで前後の画像へ、ホイールでカーソル位置を中心に拡大縮小、ドラッグでパン、ダブルクリックで元に戻す
- **ライブラリ** — フォルダ階層ツリー (枚数バッジ付き) と仮想スクロールのサムネイルグリッド
- **自動タグ付け** — WD14 tagger (ONNX) でバックグラウンドスキャン。GPU があれば CUDA / DirectML、なければ CPU で実行
- **タグ絞り込み** — タグの AND / OR / 除外 (NOT) と、フォルダ選択の組み合わせで絞り込み

## 動作環境

- Node.js 22.12 以降 (開発時。Electron 43 の要求に合わせています)
- Windows / macOS / Linux

タグ付けの実行プロバイダは CUDA → DirectML → CPU の順に試し、使えるものへ自動でフォールバックします。
GPU が無くても追加のセットアップなしで動作します。プラットフォームごとの事情は次のとおりです。

| | 既定で使える GPU 実行 | 追加ダウンロード |
| --- | --- | --- |
| Windows (x64) | **DirectML** (DirectX 12 対応 GPU なら設定不要) | なし |
| Linux (x64) | CUDA (CUDA 12 + cuDNN が必要) | あり (`npm install` 時に自動、サイズ大) |
| macOS | — (CPU 実行。CoreML 対応は将来) | なし |

Windows で CUDA を使いたい場合は、明示的に指定してインストールします (CUDA 12 + cuDNN が別途必要)。

```bash
npm install --onnxruntime-node-install=cuda12
```

逆に Linux で CUDA バイナリのダウンロードを省略したい場合は次のようにします。

```bash
npm install --onnxruntime-node-install=skip
```

## セットアップ

```bash
npm install
npm run dev
```

`npm install` の postinstall で Electron 本体 (実行バイナリ) を取得します。Electron 38 以降、
これは npm install に付随しなくなったため、本リポジトリでは
`scripts/install-electron-binary.mjs` から明示的に実行しています。
`--ignore-scripts` を付けてインストールした場合は、次を手動で実行してください。

```bash
npx install-electron
```

## iCloud の写真を見る (Windows)

Windows 版 iCloud が同期しているフォルダを、そのままルートフォルダとして開けます。

```
%USERPROFILE%\Pictures\iCloud Photos
```

iPhone の既定形式である **HEIC に対応**しています。HEIC は Chromium も sharp のプリビルドも
そのままでは扱えないため、WASM 版 libheif で復号し、表示用に変換したものをキャッシュして表示します。
追加のセットアップは要りません。Live Photos の `.mov` と編集情報の `.aae` は自動的に無視されます。

### 未ダウンロードの写真について

iCloud で「ストレージを最適化」にしていると、実体がクラウドにあるプレースホルダが並びます。
これは **読み込むとダウンロードが始まり、1 枚あたり数秒かかります**。
サムネイルを一斉に作ろうとするとダウンロードが延々と続き、アプリの応答も止まります。

そこで本アプリは、**未ダウンロードの写真を既定では読み込みません**。

- グリッドでは雲のアイコンのタイルになります (元ファイルは読みません)
- 自動タグ付けは止まり、上部に案内バーが出ます
- **写真を開けば、その 1 枚だけ**ダウンロードして表示します

判定は 2 段構えです。ファイルの割り当て状況からプレースホルダを推測し、それが外れても
**読み込みが遅い状態が続けば自動的に打ち切ります**。同期クライアントの実装に依存しないので、
推測が当たらない環境でも止まります。

まとめて処理したいときは、案内バーの「このフォルダをダウンロードしてタグ付け」を使います。
選んだフォルダだけを順にダウンロードし、進捗を出しながらタグ付けまで進めます (中断可)。

> ライブラリ全体を落とすなら、エクスプローラーでフォルダを右クリックして
> 「このデバイス上に常に保持する」を選ぶ方が高速です。Windows がまとめて同期します。

未ダウンロードでも常に読み込みたい場合は、案内バーか設定画面の
「未ダウンロードの写真も読み込む」を有効にしてください。

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

HEIC の経路は、実物の HEVC ファイル (`e2e/fixtures/sample.heic`) で検証しています。こちらも再生成できます。

```bash
pip install pillow-heif
python3 e2e/fixtures/make-heic.py
```

ヘッドレス環境では `xvfb-run -a npm run e2e` のように実行してください。

### 構成

```
src/
├─ main/            メインプロセス
│  ├─ index.ts        起動・ウィンドウ・プロトコル登録
│  ├─ db.ts           SQLite スキーマとクエリ
│  ├─ library.ts      再帰走査・差分同期・ファイル監視
│  ├─ images.ts       画像を開く入口 (HEIC の復号と EXIF の向き補正)
│  ├─ image-cache.ts  サムネイル / 表示用変換のディスクキャッシュ
│  ├─ cloud-guard.ts  クラウド同期フォルダの自動ダウンロードを止める門番
│  ├─ semaphore.ts    同時実行数の制限
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
- **HEIC は WASM で復号** — sharp のプリビルドに含まれる libheif には HEVC デコーダ (libde265) が
  無く、コンテナは読めても画素まで復号できません。`src/main/images.ts` が WASM 版 libheif での
  復号と EXIF orientation の適用を引き受け、他のコードは形式を意識せずに済むようにしています
- **派生画像の生成は同時 2 件まで** — libuv のスレッドプールは既定 4 本で、Electron 起動後に
  `UV_THREADPOOL_SIZE` を変えても効きません (実測で確認)。遅い読み込みが並ぶとプールが埋まり、
  フォルダ走査まで巻き添えで止まるため、`src/main/semaphore.ts` で常に空きを残しています
- **クラウド同期フォルダは門番を通す** — `src/main/cloud-guard.ts` が「未ダウンロードらしさ」と
  「読み込みの遅さ」の 2 つを見て、自動のダウンロードを止めます。ユーザーが明示的に開いた 1 枚と
  一括ダウンロードは素通りさせ、速く読めるようになれば自動で通常モードへ戻します

## トラブルシューティング

### `Error: Electron uninstall` で起動しない

Electron 本体 (実行バイナリ) が入っていません。`node_modules/electron/path.txt` が無いと
electron-vite はこのエラーを出します。次のコマンドで取得できます。

```bash
npx install-electron
```

`npm install --ignore-scripts` を使った場合や、ダウンロードが途中で失敗した場合に起こります。
社内プロキシ配下では `ELECTRON_GET_USE_PROXY=1` と `GLOBAL_AGENT_HTTPS_PROXY` を設定してください。
キャッシュが壊れている場合は下記を削除してからやり直します。

| OS | キャッシュの場所 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\electron\Cache` |
| macOS | `~/Library/Caches/electron` |
| Linux | `~/.cache/electron` |

### HEIC の読み込みが遅い

HEIC の復号は WASM 版 libheif で行うため、JPEG より時間がかかります (12MP でおよそ
0.3〜1 秒/枚)。初回のサムネイル生成とタグ付けは HEIC 中心のライブラリだと時間がかかりますが、
一度作ったサムネイルと表示用の変換結果はディスクにキャッシュされるので、2 回目以降は速くなります。

### Linux で sharp の互換性警告が出る

`[SharpElectronLinux] Warning: Binaries provided by Electron for use on Linux may be
incompatible with sharp` は、Electron が同梱する共有ライブラリと sharp の組み合わせに対する
警告です。動作に問題が出なければ無視して構いません。実際に読み込みへ失敗する場合は
[sharp のインストール手引き](https://sharp.pixelplumbing.com/install#electron-and-linux)
を参照してください。

## ライセンス

MIT
