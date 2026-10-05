import { defineConfig } from 'vitest/config'
import ts from 'typescript'
export default defineConfig({
  plugins: [
    {
      name: 'test-host-remote-decorators',
      enforce: 'pre',
      transform(source, id) {
        if (!id.endsWith('/src/host/index.ts')) return
        // Match the production TS compiler's standard decorator transform so
        // Host Remote admission can be exercised without replacing its methods.
        const result = ts.transpileModule(source, {
          fileName: id,
          compilerOptions: {
            target: ts.ScriptTarget.ES2023,
            module: ts.ModuleKind.ESNext,
            sourceMap: true,
          },
        })
        return { code: result.outputText, map: result.sourceMapText }
      },
    },
  ],
  test: { include: ['tests/**/*.test.{ts,tsx}'], testTimeout: 15000 },
})
