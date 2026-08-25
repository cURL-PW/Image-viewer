/**
 * Electron 本体 (実行バイナリ) を取得する postinstall スクリプト。
 *
 * Electron 38 以降、npm パッケージ側の postinstall による自動ダウンロードは廃止され、
 * `install-electron` を明示的に実行する方式になった。これを踏まないと
 * node_modules/electron/path.txt が作られず、electron-vite が
 * "Error: Electron uninstall" で起動に失敗する。
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)

/** electron パッケージの場所。devDependencies を入れない install では見つからない。 */
function findElectronDir() {
  try {
    return path.dirname(require.resolve('electron/package.json'))
  } catch {
    return null
  }
}

/** path.txt と実行ファイルが揃っているか。install.js 側の isInstalled() と同じ観点。 */
function isInstalled(electronDir) {
  try {
    const executable = fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim()
    return executable !== '' && fs.existsSync(path.join(electronDir, 'dist', executable))
  } catch {
    return false
  }
}

const electronDir = findElectronDir()
if (electronDir === null) {
  // electron が入っていない構成 (--omit=dev など)。ここで失敗させる理由はない。
  process.exit(0)
}

if (isInstalled(electronDir)) {
  process.exit(0)
}

console.log('[postinstall] Electron 本体を取得します…')
const result = spawnSync(process.execPath, [path.join(electronDir, 'install.js')], {
  stdio: 'inherit'
})

if (result.status === 0 && isInstalled(electronDir)) {
  process.exit(0)
}

console.error(
  [
    '',
    '[postinstall] Electron 本体の取得に失敗しました。',
    'このままでは `npm run dev` が "Error: Electron uninstall" で起動しません。',
    '',
    '  手動で再試行     : npx install-electron',
    '  社内プロキシ経由 : ELECTRON_GET_USE_PROXY=1 と GLOBAL_AGENT_HTTPS_PROXY を設定して再実行',
    '  キャッシュ破損時 : 下記を削除してから再実行',
    '                     Windows %LOCALAPPDATA%\\electron\\Cache',
    '                     macOS   ~/Library/Caches/electron',
    '                     Linux   ~/.cache/electron',
    ''
  ].join('\n')
)
process.exit(1)
