// Build an isolated package so UI acceptance cannot hot-reload the installed Desktop plugin.
import { cpSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve('.')
const preview = join(root, '.cache/preview-package')
rmSync(preview, { recursive: true, force: true })
mkdirSync(preview, { recursive: true })
for (const file of [
  'src',
  'scripts/build.mjs',
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'tsconfig.base.json',
  'tsconfig.host-build.json',
  'tsconfig.client.json',
]) {
  cpSync(join(root, file), join(preview, file), { recursive: true })
}
symlinkSync(join(root, 'node_modules'), join(preview, 'node_modules'), 'dir')
execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: preview, stdio: 'inherit' })
console.log(`Isolated package ready: ${preview}`)
