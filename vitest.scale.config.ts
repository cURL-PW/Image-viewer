import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 9 万ファイルの規模テスト専用の設定。
 * 準備だけで分単位かかるので、普段の `npm test` からは外してある。
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.scale.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000
  }
})
