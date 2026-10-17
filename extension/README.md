# Image Viewer に取り込む (ブラウザ拡張)

ページ上の画像を、PC で起動中の Image Viewer のライブラリ (`Imported` フォルダ) に取り込む拡張です。
Firefox と Chrome / Edge で同じコードが動きます。

## 使い方

- 画像を右クリック →「Image Viewer に取り込む」
- または `Alt+Shift` を押しながら画像をクリック (拡張の設定で `Ctrl+Shift` などに変えられます。macOS では Ctrl の代わりに ⌘)
- 画像がリンクになっていてリンク先が画像なら、リンク先 (原寸) を取り込みます
- 取り込めると画像に一瞬緑の枠が出ます (黄: 取り込み済み / 赤: 失敗)。Image Viewer 側にも通知が出ます

## 準備

1. Image Viewer の設定で「ブラウザからの取り込みを受け付ける」をオンにする
2. 拡張を入れる (下記)。入れると設定画面が開くので、Image Viewer に表示されたポート番号と合言葉を貼り付ける
3. 「接続を確かめる」で「Image Viewer につながりました」と出れば準備完了

## 入れ方

配布用の zip はリポジトリのルートで `npm run extension` を実行すると `release/extension/` にできます。

### Firefox

Firefox の正式版は、Mozilla の署名がない拡張を常時入れておけません。

- **試すだけ**: `about:debugging#/runtime/this-firefox` →「一時的なアドオンを読み込む」で `extension/manifest.json` を選ぶ
  (Firefox を終了すると外れます)
- **常用する**: Mozilla の開発者アカウント (https://addons.mozilla.org/developers/) で API キーを発行し、
  「自分用 (unlisted)」として署名します。署名済みの `.xpi` はファイルをドラッグするだけで入れられます。

  ```bash
  npx web-ext sign --source-dir extension --channel unlisted \
    --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"
  ```

入れた後に「すべてのウェブサイトのデータへのアクセス」が許可されていないと取り込めません。拡張の設定画面に
「アクセスを許可する」ボタンが出ていれば押してください。

### Chrome / Edge

1. `chrome://extensions` (Edge は `edge://extensions`) を開き、「デベロッパーモード」をオンにする
2. 「パッケージ化されていない拡張機能を読み込む」で `extension` フォルダを選ぶ

## 仕組み

Image Viewer は `127.0.0.1` (この PC の中だけ) で受け口を開きます。拡張は画像をページと同じ Cookie・Referer で取得し、
合言葉を付けて受け口へ送ります。合言葉の違う送信や、普通の Web ページからの送信は受け付けません。
