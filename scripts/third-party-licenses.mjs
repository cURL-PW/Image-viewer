// 配布物に同梱する第三者ライセンス一覧 (out/THIRD_PARTY_LICENSES.txt) を作る。
// node_modules に実際に入っているパッケージだけを対象にするので、
// ビルドする OS ごとの sharp / libvips のバイナリ版がそのまま載る。
//   - アプリに同梱される依存 (package.json の dependencies とその依存)
//   - レンダラーにバンドルされる依存 (RENDERER_BUNDLED とその依存)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outFile = path.join(root, 'out', 'THIRD_PARTY_LICENSES.txt')

/** devDependencies だが electron-vite でレンダラーに取り込まれるもの */
const RENDERER_BUNDLED = ['react', 'react-dom', 'zustand']

/** ライセンス本文を持たないパッケージ向けに、同梱している標準のライセンス文 */
const STANDARD_TEXTS = {
  'Apache-2.0': 'licenses/Apache-2.0.txt',
  'LGPL-3.0': 'licenses/LGPL-3.0.txt',
  'LGPL-3.0-or-later': 'licenses/LGPL-3.0.txt'
}

/** ライセンス本文を同梱していないパッケージの著作権者 (package.json の author と違うもの) */
const COPYRIGHT_HOLDERS = {
  'onnxruntime-common': 'Microsoft Corporation',
  'onnxruntime-node': 'Microsoft Corporation'
}

/** 補足の案内 */
const EXTRA_NOTES = {
  'onnxruntime-node':
    'Third-party notices for the bundled ONNX Runtime binaries:\nhttps://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt'
}

const PERMISSIVE_TEMPLATES = {
  MIT: (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  ISC: (holder) => `ISC License

Copyright (c) ${holder}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i

/** name を from ディレクトリから Node と同じ規則で探す */
function resolvePackageDir(name, from) {
  let dir = from
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function collect() {
  const seen = new Map()
  const rootPkg = readJson(path.join(root, 'package.json'))
  const queue = [...Object.keys(rootPkg.dependencies ?? {}), ...RENDERER_BUNDLED].map((name) => [
    name,
    root
  ])
  while (queue.length > 0) {
    const [name, from] = queue.shift()
    const dir = resolvePackageDir(name, from)
    // 別の OS 向けの optionalDependencies は入っていないので飛ばす
    if (!dir || seen.has(dir)) continue
    const pkg = readJson(path.join(dir, 'package.json'))
    seen.set(dir, pkg)
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies }
    for (const dep of Object.keys(deps)) queue.push([dep, dir])
  }
  return [...seen.entries()]
    .map(([dir, pkg]) => ({ dir, pkg }))
    .sort((a, b) => a.pkg.name.localeCompare(b.pkg.name) || a.dir.localeCompare(b.dir))
}

function repositoryUrl(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (!repo) return pkg.homepage ?? ''
  return repo.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/')
}

/** README の "## Licensing" 節 (sharp-libvips はここに同梱ライブラリの一覧を書いている) */
function readmeLicensing(dir) {
  const readme = path.join(dir, 'README.md')
  if (!fs.existsSync(readme)) return null
  const lines = fs.readFileSync(readme, 'utf8').split(/\r?\n/)
  const start = lines.findIndex((line) => /^## Licensing\s*$/.test(line))
  if (start < 0) return null
  const end = lines.findIndex((line, i) => i > start && /^## /.test(line))
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim()
}

function licenseText({ dir, pkg }) {
  const file = fs.readdirSync(dir).find((f) => LICENSE_FILE.test(f))
  const parts = []
  if (file) parts.push(fs.readFileSync(path.join(dir, file), 'utf8').trim())
  const licensing = readmeLicensing(dir)
  if (licensing) parts.push(licensing)
  const template = PERMISSIVE_TEMPLATES[pkg.license]
  if (parts.length === 0 && template) {
    const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name
    const holder = COPYRIGHT_HOLDERS[pkg.name] ?? author?.replace(/\s*<[^>]*>/, '')
    parts.push(template(holder ?? `the ${pkg.name} authors`))
  }
  if (parts.length === 0) {
    const standard = String(pkg.license ?? '')
      .split(/\s+(?:AND|OR)\s+/)
      .map((id) => STANDARD_TEXTS[id.replace(/[()]/g, '')])
      .filter(Boolean)
    parts.push(
      standard.length > 0
        ? `License text: see ${[...new Set(standard)].join(', ')}`
        : `License: ${pkg.license ?? 'unknown'} (see the repository above)`
    )
  }
  if (EXTRA_NOTES[pkg.name]) parts.push(EXTRA_NOTES[pkg.name])
  return parts.join('\n\n')
}

/** LGPL の部品について、差し替え方法とソースの入手先を書く */
function lgplNotice(packages) {
  const lgpl = packages.filter(({ pkg }) => /LGPL/.test(String(pkg.license)))
  if (lgpl.length === 0) return ''
  const lines = lgpl.map(({ pkg }) => {
    const repo = repositoryUrl(pkg)
    return `  - ${pkg.name}@${pkg.version} (${pkg.license})\n    Source: ${repo}/releases/tag/v${pkg.version}`
  })
  return `NOTICE ABOUT LGPL COMPONENTS

The following components are licensed under the GNU Lesser General Public
License version 3 (licenses/LGPL-3.0.txt, which incorporates
licenses/GPL-3.0.txt). They are shipped unmodified as separate files under
resources/app.asar.unpacked/node_modules/ and are loaded at runtime, so you
may replace them with your own modified versions.

${lines.join('\n')}

`
}

function main() {
  const packages = collect()
  const ownPkg = readJson(path.join(root, 'package.json'))
  const sections = packages.map(({ dir, pkg }) => {
    const header = `${pkg.name}@${pkg.version}\nLicense: ${pkg.license ?? 'unknown'}\nRepository: ${repositoryUrl(pkg)}`
    return `${'='.repeat(78)}\n${header}\n${'-'.repeat(78)}\n${licenseText({ dir, pkg })}\n`
  })
  const text = `THIRD-PARTY SOFTWARE NOTICES

${ownPkg.build?.productName ?? ownPkg.name} itself is licensed under the MIT License (see LICENSE).
It includes the following third-party software. Paths below are relative
to the application's resources folder. Electron and Chromium notices are
in LICENSE.electron.txt and LICENSES.chromium.html, shipped with the app.

The WD14 tagger models (SmilingWolf/wd-*-tagger-v3, Apache-2.0) are not
included; they are downloaded from Hugging Face on first use.

${lgplNotice(packages)}${sections.join('\n')}`
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, text)
  console.log(`${path.relative(root, outFile)}: ${packages.length} packages`)
}

main()
