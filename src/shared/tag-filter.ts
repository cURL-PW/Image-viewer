/**
 * 「タグをコピー (除外あり)」で使う除外ルール。
 *
 * 1 件につき 1 つの正規表現で、タグ名全体と大文字小文字を区別せずに照合する。
 * 全体一致にしているのは、`1girl` のように普通のタグ名をそのまま登録したとき
 * `1girls` まで巻き込まないため。部分一致にしたければ `.*hair.*` のように書く。
 */

export interface TagPatternError {
  pattern: string
  message: string
}

export interface CompiledTagPatterns {
  regexes: RegExp[]
  /** 正規表現として解釈できなかったもの。照合には使わない */
  errors: TagPatternError[]
}

export function compileTagPatterns(patterns: readonly string[]): CompiledTagPatterns {
  const regexes: RegExp[] = []
  const errors: TagPatternError[] = []
  for (const raw of patterns) {
    const pattern = raw.trim()
    if (pattern === '') continue
    try {
      regexes.push(new RegExp(`^(?:${pattern})$`, 'iu'))
    } catch (error) {
      errors.push({ pattern, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { regexes, errors }
}

/** 除外ルールのどれかに一致するタグを取り除く。並び順はそのまま */
export function excludeTags(names: readonly string[], patterns: readonly string[]): string[] {
  const { regexes } = compileTagPatterns(patterns)
  if (regexes.length === 0) return [...names]
  return names.filter((name) => !regexes.some((regex) => regex.test(name)))
}
