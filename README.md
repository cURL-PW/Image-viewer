# Image Viewer

フォルダの画像を再帰的に読み込み、WD14 tagger による自動タグ付けとタグでの絞り込みができるデスクトップ画像ビューアーです。iPhone の HEIC や iCloud for Windows の写真フォルダもそのまま扱えます。

> **アルファ版です。** 仕様や保存形式が予告なく変わることがあります。

## ダウンロード

[Releases](https://github.com/cURL-PW/Image-viewer/releases) から OS に合ったファイルを取得してください。

| OS | ファイル |
| --- | --- |
| Windows | `Image-Viewer-Setup-*.exe` (インストーラ) / `Image-Viewer-*-win.zip` (展開して使う版) |
| macOS | `Image-Viewer-*.dmg` |
| Linux | `Image-Viewer-*.AppImage` |

配布物にはコード署名をしていません。初回起動時に Windows の SmartScreen (「Windows によって PC が保護されました」) や macOS の Gatekeeper の警告が出ることがあります。Windows では「詳細情報」→「実行」で起動できます。

## 主な機能

- **複数ライブラリ** — 画像フォルダを複数登録し、サイドバーから切り替えられる
- **再帰読み込み** — ルートフォルダ配下のすべての画像 (jpg / png / webp / gif / bmp / avif / **heic**) を収集
- **iCloud / iPhone の写真** — HEIC をそのまま閲覧・タグ付けできる。同期フォルダを開くだけで使える
- **リアルタイム反映** — ファイルの追加・変更・削除を監視して即座に反映。起動時は差分同期で、アプリを閉じている間の変化にも追随
- **ビューアー** — 既定で**画像全体が収まる大きさ**で表示 (画面より小さい画像は等倍のまま)。画像の左右端クリックで前後の画像へ、ホイールでカーソル位置を中心に拡大縮小、ドラッグでパン、ダブルクリックで元に戻す。`F11` で全画面、`R` で表示を回転 (元ファイルは変えない)
- **ライブラリ** — フォルダ階層ツリー (枚数バッジ付き) と仮想スクロールのサムネイルグリッド
- **自動タグ付け** — WD14 tagger (ONNX) でバックグラウンドスキャン。GPU があれば CUDA / DirectML、なければ CPU で実行
- **タグ絞り込み** — タグの AND / OR / 除外 (NOT) と、フォルダ選択の組み合わせで絞り込み
- **検索・お気に入り** — ファイル名・パスの部分一致検索、★ で付けたお気に入りだけの表示、よく使う絞り込み条件の保存
- **整理** — Ctrl / Shift クリックで複数選択してまとめて操作、ごみ箱へ移動、タグの手動追加・削除
- **サムネイルの大きさ** — 一覧で Ctrl + ホイール / Ctrl + − ＋ 0 で 96〜512px に変更
- **似た画像** — タグの似ている画像をライブラリ全体から探して似ている順に並べる
- **ブラウザから取り込む** — ブラウザ拡張から、ページ上の画像をライブラリへ保存

## 動作環境

- Windows (x64) / macOS / Linux (x64)

タグ付けの実行プロバイダは CUDA → DirectML → CPU の順に試し、使えるものへ自動でフォールバックします。GPU が無くても追加のセットアップなしで動作します。

| | 既定で使える GPU 実行 |
| --- | --- |
| Windows (x64) | **DirectML** (DirectX 12 対応 GPU なら設定不要) |
| Linux (x64) | CUDA (CUDA 12 + cuDNN が必要) |
| macOS | — (CPU 実行) |

## 使い方

起動後に「ライブラリを追加」から画像フォルダを選ぶと、配下を再帰的に読み込みます。フォルダは複数登録でき、左の「ライブラリ」一覧から切り替えられます (×で登録を外しても、フォルダ内の画像は消えません)。コマンドラインからフォルダを指定することもできます。

```bash
image-viewer /path/to/images
image-viewer --root /path/to/images
```

初回のタグ付け時に、選択中の WD14 モデル (既定: `SmilingWolf/wd-eva02-large-tagger-v3`) を Hugging Face から自動ダウンロードし、以降はローカルにキャッシュします。モデルは数百 MB 以上あるので、初回は時間がかかります。

### 操作

| 操作 | 動作 |
| --- | --- |
| サムネイルをクリック | 単画像ビューを開く |
| 画像の左端 / 右端をクリック | 前 / 次の画像へ (全体表示のときのみ) |
| ホイール | カーソル位置を中心に拡大縮小 |
| Shift + ホイール | 縦スクロール |
| ドラッグ | パン |
| ダブルクリック | 全体が収まる大きさに戻す |
| ← / → , PageUp / PageDown | 前 / 次の画像へ |
| Home / End | 先頭 / 末尾の画像へ |
| F11 | 全画面 |
| R | 表示を回転 |
| Esc / マウスの戻るボタン | 一覧へ戻る |
| 一覧で Ctrl + ホイール / Ctrl + − ＋ 0 | サムネイルの大きさを変える (0 で既定) |
| 画像を右クリック | メニュー (開く / 既定のアプリで開く / エクスプローラー (Finder) で表示 / 似た画像を探す / 画像・パス・ファイル名・タグをコピー / 除外タグを除いてタグをコピー) |

### タグ絞り込み

サイドバーのタグ一覧はフォルダ選択の範囲で集計されます。タグ名をクリックすると「そのタグを含む」条件、行右端の `−` で「そのタグを除外する」条件になります。複数タグは AND / OR を切り替えられ、フォルダ選択とも組み合わさります。

しきい値やモデルを変更すると付与されるタグが変わるため、全画像が自動で再スキャンされます。

### ブラウザから取り込む

ブラウザ拡張を入れると、ページ上の画像を右クリックメニュー「Image Viewer に取り込む」か `Alt+Shift+クリック` で、開いているライブラリに取り込めます。詳しい入れ方は [extension/README.md](extension/README.md) を見てください。

1. Image Viewer の設定で「ブラウザからの取り込みを受け付ける」をオンにする
2. 表示されたポート番号と合言葉を、拡張の設定画面に貼り付けて「接続を確かめる」

保存先はライブラリごとに「Imported フォルダ」か「ライブラリ直下」を選べます。iCloud 写真のフォルダは中に作ったフォルダを同期しないので、「ライブラリ直下」にしてください。

## iCloud の写真を見る (Windows)

iCloud for Windows が同期しているフォルダ (`%USERPROFILE%\Pictures\iCloud Photos` など) を、そのままライブラリとして追加できます。HEIC は追加のセットアップなしで表示・タグ付けできます。Live Photos の `.mov` と編集情報の `.aae` は自動的に無視されます。

### 未ダウンロードの写真

iCloud で「ストレージを最適化」にしていると、実体がクラウドにある写真が並びます。これを読むとダウンロードが始まり 1 枚あたり数秒かかるため、本アプリは**未ダウンロードの写真を既定では読み込みません**。

- グリッドでは雲のアイコンのタイルになります
- 自動タグ付けは止まり、上部に案内バーが出ます
- **写真を開けば、その 1 枚だけ**ダウンロードして表示します
- ローカルにある写真は今までどおりサムネイル生成もタグ付けも進みます

まとめて処理したいときは、案内バーの「このフォルダをダウンロードしてタグ付け」を使います。選んだフォルダだけを順にダウンロードし、進捗を出しながらタグ付けまで進めます (中断可)。

> ライブラリ全体を落とすなら、エクスプローラーでフォルダを右クリックして
> 「このデバイス上に常に保持する」を選ぶ方が高速です。Windows がまとめて同期します。

未ダウンロードでも常に読み込みたい場合は、案内バーか設定画面の「未ダウンロードの写真も読み込む」を有効にしてください。判定の内訳は設定画面の「クラウド同期フォルダの診断」で確認できます。

## プライバシー

- 画像やタグはすべて手元の PC に保存され、外部へ送信しません
- 通信するのは、タグ付けモデルを Hugging Face からダウンロードするときだけです
- ブラウザ取り込みの受け口は `127.0.0.1` (この PC の中) だけで待ち受け、合言葉が一致した要求だけを受け付けます。既定ではオフです
- 設定画面の診断にある**デバッグログ**は、ファイルに触れた操作をファイルパス付きで記録します。**既定ではオフ**で、調査のときだけ設定画面からオンにします (保存先は `%APPDATA%\image-viewer\logs\debug.log` など)。Issue などに貼るときは、パスに含まれる名前に注意してください

## 開発

Node.js 22.12 以降が必要です (Electron 43 の要求に合わせています)。

```bash
npm install
npm run dev        # 開発サーバー + Electron 起動
npm run build      # 型チェック + ビルド
npm test           # ユニットテスト (vitest)
npm run e2e        # E2E テスト (Playwright + Electron)
npm run dist       # インストーラ / パッケージを作成
```

開発時にフォルダを指定するときは、electron-vite が `--root` を解釈してしまうため環境変数を使います。

```bash
IMAGE_VIEWER_ROOT=/path/to/images npm run dev
```

`npm install` の postinstall で Electron 本体 (実行バイナリ) を取得します (`scripts/install-electron-binary.mjs`)。`--ignore-scripts` を付けてインストールした場合は `npx install-electron` を手動で実行してください。

onnxruntime の GPU 版は次のように切り替えます。

```bash
# Windows で CUDA を使う (CUDA 12 + cuDNN が別途必要)
npm install --onnxruntime-node-install=cuda12
# Linux で CUDA バイナリ (サイズ大) のダウンロードを省略する
npm install --onnxruntime-node-install=skip
```

### テスト

E2E テストは Hugging Face からモデルを取得せず、同じ入出力形状のダミー ONNX モデル (`e2e/fixtures/model.onnx`) を使ってタグ付け経路を検証します。HEIC の経路は実物の HEVC ファイル (`e2e/fixtures/sample.heic`) で検証しています。どちらも再生成できます。

```bash
pip install onnx numpy pillow-heif
python3 e2e/fixtures/make-model.py
python3 e2e/fixtures/make-heic.py
```

ヘッドレス環境では `xvfb-run -a npm run e2e` のように実行してください。

ブラウザ拡張の E2E (`e2e/browser-import.spec.ts`) は Chromium に `extension/` を読み込んで動かします。初回は `npx playwright install chromium` で Chromium を入れてください (別の場所の Chromium を使う場合は `PLAYWRIGHT_CHROMIUM_PATH` で指定できます)。拡張の配布用 zip は `npm run extension` で `release/extension/` に作られます。

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
│  ├─ debug-log.ts    ファイルに触れた操作の記録 (原因調査用)
│  ├─ fs-probe.ts     fs 呼び出しの計数
│  ├─ win-placeholders.ts  Windows のファイル属性から未ダウンロードを特定
│  ├─ semaphore.ts    同時実行数の制限
│  ├─ protocol.ts     app-image:// / app-thumb:// の配信
│  ├─ ipc.ts          IPC ハンドラ
│  └─ tagger/         モデル管理・推論ワーカー・スキャンキュー
├─ preload/         contextBridge で公開する API
├─ renderer/        React UI
└─ shared/          main と renderer で共有する型と IPC 契約
```

仕様は [SPEC.md](./SPEC.md)、設計判断とその理由は [docs/DESIGN.md](docs/DESIGN.md)、デバッグログの読み方は [docs/debug-log.md](docs/debug-log.md) にあります。

## トラブルシューティング

### HEIC の読み込みが遅い

HEIC の復号は WASM 版 libheif で行うため、JPEG より時間がかかります (12MP でおよそ
0.3〜1 秒/枚)。初回のサムネイル生成とタグ付けは HEIC 中心のライブラリだと時間がかかりますが、
一度作ったサムネイルと表示用の変換結果はディスクにキャッシュされるので、2 回目以降は速くなります。

### iCloud の写真のダウンロードが止まらない

設定画面の診断セクションで「デバッグログを記録する」をオンにし、アプリを再起動して症状を再現してから「直近をコピー」を押すと、デバッグログの末尾 300 行をコピーできます。Issue に貼っていただければ原因を追えます (貼る前にファイル名を確認してください)。読み方は [docs/debug-log.md](docs/debug-log.md) にあります。

### `Error: Electron uninstall` で起動しない (開発時)

Electron 本体 (実行バイナリ) が入っていません。`npx install-electron` で取得できます。
プロキシ配下では `ELECTRON_GET_USE_PROXY=1` と `GLOBAL_AGENT_HTTPS_PROXY` を設定してください。
キャッシュが壊れている場合は `%LOCALAPPDATA%\electron\Cache` (Windows) / `~/Library/Caches/electron` (macOS) / `~/.cache/electron` (Linux) を削除してからやり直します。

### Linux で sharp の互換性警告が出る

`[SharpElectronLinux] Warning: Binaries provided by Electron for use on Linux may be
incompatible with sharp` は、Electron が同梱する共有ライブラリと sharp の組み合わせに対する
警告です。動作に問題が出なければ無視して構いません。実際に読み込みへ失敗する場合は
[sharp のインストール手引き](https://sharp.pixelplumbing.com/install#electron-and-linux)
を参照してください。

## ライセンス

このアプリ本体は [MIT License](LICENSE) です。

- 配布物には、同梱している第三者ソフトウェアのライセンス一覧 `THIRD_PARTY_LICENSES.txt` と、その本文 (`licenses/`) が入ります。一覧は `npm run build` のときに `node_modules` から自動生成されます (`npm run licenses` で単独実行も可)。
- 画像処理の libvips (sharp 経由) と HEIC デコーダの libheif-js は LGPL-3.0 です。どちらも改変せず、差し替え可能な別ファイル (`app.asar.unpacked`) として同梱しています。
- タグ付けモデル ([SmilingWolf/wd-*-tagger-v3](https://huggingface.co/SmilingWolf)) は Apache-2.0 です。アプリには同梱せず、初回使用時に Hugging Face からダウンロードします。
