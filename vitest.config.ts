import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 9 万ファイルを作る規模テストは重いので、普段の実行からは外す
    // (`npm run test:scale` で走らせる)
    exclude: ['**/node_modules/**', 'src/**/*.scale.test.ts']
  }
})
