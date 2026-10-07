import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { build } from 'tsdown'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const root = resolve('.')
// Discard only generated outputs so old entry points cannot leak into packages.
rmSync(join(root, 'lib'), { recursive: true, force: true })
rmSync(join(root, '.cache/typert'), { recursive: true, force: true })
const tsc = (project) =>
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', project], { stdio: 'inherit' })
tsc('tsconfig.host-build.json')
for (const name of [
  'private-launch',
  'terminal-bridge',
  'pi-omp-bridge',
  'pi-native-catalog',
  'zcode-resume',
  'pi-login',
  'grok-catalog',
]) {
  const source = `src/host/${name}.mjs`
  if (existsSync(source)) cpSync(source, `lib/${name}.mjs`)
}
await build({
  entry: { index: 'lib/types/host/index.js' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  clean: false,
  sourcemap: true,
  dts: false,
  outputOptions: { entryFileNames: '[name].js' },
})

// The published generator requires a packages/* workspace inventory. Stage our
// single package at build time; no Harness source checkout is needed by users.
const stage = join(root, '.cache/typert')
const owner = join(stage, 'packages/cliworker')
mkdirSync(owner, { recursive: true })
cpSync('src', join(owner, 'src'), { recursive: true })
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const stagedManifest = structuredClone(manifest)
stagedManifest.exports['.'] = { types: './src/host/index.ts', default: './src/host/index.ts' }
writeFileSync(join(owner, 'package.json'), JSON.stringify(stagedManifest))
cpSync('lib/types', join(owner, 'lib/types'), { recursive: true })
if (!existsSync(join(stage, 'node_modules')))
  symlinkSync(join(root, 'node_modules'), join(stage, 'node_modules'), 'dir')
writeFileSync(
  join(owner, 'tsconfig.host.json'),
  JSON.stringify({
    ...JSON.parse(readFileSync('tsconfig.base.json')),
    include: ['src/host/**/*.ts', 'src/shared/**/*.ts'],
  }),
)
const protocol = join(stage, 'packages/protocol')
cpSync('node_modules/@deepseek-ai/dsh-typert-protocol', protocol, { recursive: true, dereference: true })
cpSync(join(protocol, 'lib/types'), join(protocol, 'declarations'), { recursive: true })
const protocolManifest = JSON.parse(readFileSync(join(protocol, 'package.json')))
protocolManifest.exports['.'] = { types: './declarations/index.d.ts', default: './declarations/index.d.ts' }
protocolManifest.exports['./types'] = {
  types: './declarations/types.d.ts',
  default: './declarations/types.d.ts',
}
writeFileSync(join(protocol, 'package.json'), JSON.stringify(protocolManifest))
writeFileSync(join(protocol, 'tsconfig.host.json'), JSON.stringify({ include: ['lib/types/**/*.d.ts'] }))
writeFileSync(
  join(stage, 'tsconfig.host.json'),
  JSON.stringify({
    compilerOptions: {
      ...JSON.parse(readFileSync('tsconfig.base.json')).compilerOptions,
      paths: {
        '@deepseek-ai/dsh-typert-protocol': ['./packages/protocol/declarations/index.d.ts'],
        '@deepseek-ai/dsh-typert-protocol/types': ['./packages/protocol/declarations/types.d.ts'],
      },
    },
    files: [],
    references: [
      { path: './packages/cliworker/tsconfig.host.json' },
      { path: './packages/protocol/tsconfig.host.json' },
    ],
  }),
)
const generator = new WorkspaceTypertGenerator(stage, { checkDiagnostics: false })
const artifacts = generator.generate([manifest.name], ['host'])
if (artifacts.length !== 1 || !artifacts[0].remote) throw new Error('Missing generated Host/Remote contract')
const artifact = artifacts[0]
writeFileSync('lib/typert.host.js', artifact.js)
writeFileSync('lib/typert.host.d.ts', artifact.dts)
writeFileSync('lib/typert.remote-client.js', artifact.remote.js)
writeFileSync('lib/typert.remote-client.d.ts', artifact.remote.dts)
writeFileSync('lib/typert.remote-client.d.ts.map', artifact.remote.dtsMap)
if (process.argv.includes('--host-only')) process.exit(0)
tsc('tsconfig.client.json')
cpSync('src/client/assets', 'lib/types/client/assets', { recursive: true })
await build({
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  platform: 'browser',
  loader: { '.png': 'dataurl' },
  format: 'cjs',
  clean: false,
  dts: false,
  sourcemap: true,
  deps: {
    alwaysBundle: ['zod', '@xterm/xterm', '@xterm/addon-fit', 'dsh-cliworker-now/remote'],
    neverBundle: [
      'react',
      'react-dom',
      'react/jsx-runtime',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
  },
  outputOptions: {
    banner: 'window.__ModuleLoader__.load({ id: "dsh-cliworker-now", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
    entryFileNames: '[name].js',
  },
})
