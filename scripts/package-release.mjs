import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Prepare an already verified build. This script never builds, installs or publishes.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootManifestText = readFileSync(join(root, 'package.json'), 'utf8')
const rootManifest = JSON.parse(rootManifestText)
if (rootManifest.name !== 'dsh-cliworker-now' || rootManifest.private !== true)
  throw new Error('The development manifest must remain private dsh-cliworker-now')
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(rootManifest.version))
  throw new Error('A concrete release version is required')

const allowlist = ['README.md', 'README.en.md', 'LICENSE', 'cordis.patch.yml']
const helperNames = [
  'account-models',
  'grok-catalog',
  'native-launch',
  'own-account-lease',
  'pi-installation',
  'pi-login',
  'pi-native-catalog',
  'pi-omp-bridge',
  'pi-omp-environment',
  'pi-omp-refresh',
  'private-launch',
  'terminal-bridge',
  'zcode-resume',
]
const required = new Set([
  ...helperNames.map((name) => `lib/${name}.mjs`),
  'lib/hermes-native-entry.py',
  'lib/types/host/hermes-native-entry.py',
])
const runtimeEntries = new Set(helperNames.map((name) => `lib/${name}.mjs`))
const typeEntries = new Set()
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const inside = (base, path) => {
  const rel = relative(base, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
function regular(path) {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1)
    throw new Error(`Not an independent regular release file: ${relative(root, path)}`)
  return entry
}
function directory(path) {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isDirectory())
    throw new Error(`Not an independent release directory: ${relative(root, path)}`)
}
function inventory(base, part) {
  const path = join(base, part)
  const entry = lstatSync(path)
  if (entry.isSymbolicLink()) throw new Error(`Symlink is forbidden in release resources: ${part}`)
  if (entry.isDirectory())
    return readdirSync(path)
      .sort()
      .flatMap((name) => inventory(base, join(part, name)))
  regular(path)
  if (part.endsWith('.tsbuildinfo')) return []
  if (
    /(?:^|[\\/])(?:\.env(?:\.[^/]*)?|\.npmrc|\.git|\.cache|\.test-data|node_modules|host\.lock|cleanup-blocked\.json)$/.test(
      part,
    ) ||
    /\.(?:worker\.json|events\.jsonl|account-binding\.json)$/.test(part)
  )
    throw new Error(`Private resource is forbidden in a release: ${part}`)
  return [part.replaceAll(sep, '/')]
}

function declaredFiles(value, kind) {
  if (typeof value === 'string') {
    if (!value.startsWith('./')) throw new Error(`Release entry must be package-relative: ${value}`)
    required.add(value.slice(2))
    if (kind === 'types') typeEntries.add(value.slice(2))
    if (kind === 'runtime') runtimeEntries.add(value.slice(2))
  } else if (Array.isArray(value)) value.forEach((entry) => declaredFiles(entry, kind))
  else if (value && typeof value === 'object')
    Object.entries(value).forEach(([key, entry]) => declaredFiles(entry, key === 'types' ? 'types' : kind))
  else throw new Error('Unsupported release entry declaration')
}
declaredFiles(rootManifest.main, 'runtime')
declaredFiles(rootManifest.types, 'types')
declaredFiles(rootManifest.exports, 'runtime')
declaredFiles(rootManifest.dsh.bundle.patch)
// Unbundled declarations/runtime retain these native helper companions.
for (const name of [
  'account-models',
  'pi-installation',
  'native-launch',
  'pi-omp-environment',
  'own-account-lease',
  'pi-omp-refresh',
]) {
  required.add(`lib/types/host/${name}.mjs`)
  required.add(`lib/types/host/${name}.d.mts`)
}

directory(join(root, 'lib'))
const files = [...inventory(root, 'lib'), ...allowlist]
for (const part of allowlist) regular(join(root, part))
for (const part of required) {
  const path = resolve(root, part)
  if (!inside(root, path) || !files.includes(part)) throw new Error(`Missing prebuilt release entry: ${part}`)
  regular(path)
}
const hashes = new Map()
for (const part of files) {
  const bytes = readFileSync(join(root, part))
  hashes.set(part, sha256(bytes))
  if (!/\.(?:[cm]?js|[cm]?ts|map|py|md|yml)$/.test(part)) continue
  const text = bytes.toString('utf8')
  if ([root, homedir()].some((path) => path.length > 1 && text.includes(path)))
    throw new Error(`Machine-private absolute path in release file: ${part}`)
}
// Public JS/MJS entry points and dynamic native helpers form the execution graph.
// TSC's incidental lib/types/*.js outputs are copied unchanged, but are not a
// second public execution graph; type entry points resolve declaration modules.
function validateModules(entries, types) {
  const seen = new Set()
  const queue = [...entries]
  while (queue.length) {
    const part = queue.shift()
    if (seen.has(part)) continue
    seen.add(part)
    if (!(types ? /\.d\.[cm]?ts$/ : /\.[cm]?js$/).test(part)) continue
    const text = readFileSync(join(root, part), 'utf8')
    const references = text.matchAll(
      /(?:\b(?:from|import)\s*\(?\s*|\bnew\s+URL\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g,
    )
    for (const match of references) {
      const target = resolve(root, dirname(part), match[1])
      if (!inside(root, target)) throw new Error(`Local module escapes release resources: ${part}`)
      const relativeTarget = relative(root, target).replaceAll(sep, '/')
      const candidates = types
        ? [
            relativeTarget.replace(/\.(?:ts|js)$/, '.d.ts'),
            relativeTarget.replace(/\.(?:mts|mjs)$/, '.d.mts'),
            relativeTarget.replace(/\.(?:cts|cjs)$/, '.d.cts'),
            relativeTarget,
          ]
        : [relativeTarget]
      const found = candidates.find((candidate) => files.includes(candidate))
      if (!found) throw new Error(`Missing local module referenced by ${part}: ${relativeTarget}`)
      queue.push(found)
    }
  }
}
validateModules(runtimeEntries, false)
validateModules(typeEntries, true)
const evidencePath = join(root, 'artifacts', `${rootManifest.name}-${rootManifest.version}-verification.json`)
regular(evidencePath)
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
if (
  evidence.version !== rootManifest.version ||
  evidence.packageMatchesBuild !== true ||
  evidence.sourceMatchesPreview !== true ||
  evidence.clientMatchesVerifiedUI !== true ||
  evidence.hostMatchesPreview !== true ||
  evidence.clientSha256 !== hashes.get('lib/client.js')
)
  throw new Error('The prebuilt Client/version does not match the verified release evidence')

const manifestFields = [
  'name',
  'version',
  'description',
  'type',
  'license',
  'engines',
  'main',
  'types',
  'exports',
  'dsh',
  'dependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'files',
]
const manifest = Object.fromEntries(
  manifestFields
    .filter((field) => rootManifest[field] !== undefined)
    .map((field) => [field, structuredClone(rootManifest[field])]),
)
Object.assign(manifest, {
  private: false,
  repository: { type: 'git', url: 'git+https://github.com/SuperWheel/cliworker-now.git' },
  bugs: { url: 'https://github.com/SuperWheel/cliworker-now/issues' },
  homepage: 'https://github.com/SuperWheel/cliworker-now#readme',
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
})

// Reject aliased output ancestors before creating or replacing our one owned package directory.
for (const part of ['dist', 'dist/npm']) {
  const path = join(root, part)
  if (existsSync(path)) directory(path)
  else mkdirSync(path, { mode: 0o700 })
}
const output = join(root, 'dist/npm', manifest.name)
if (existsSync(output)) directory(output)
const stage = `${output}.${randomUUID()}.tmp`
mkdirSync(stage, { mode: 0o700 })
try {
  for (const part of files) {
    const destination = join(stage, part)
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    cpSync(join(root, part), destination, { dereference: false })
    regular(destination)
    if (sha256(readFileSync(destination)) !== hashes.get(part))
      throw new Error(`Release input changed during preparation: ${part}`)
  }
  writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  const prepared = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'))
  if (
    prepared.name !== rootManifest.name ||
    prepared.version !== rootManifest.version ||
    prepared.private !== false ||
    ['scripts', 'devDependencies', 'packageManager'].some((field) => Object.hasOwn(prepared, field))
  )
    throw new Error('Invalid public release manifest')
  if (readFileSync(join(root, 'package.json'), 'utf8') !== rootManifestText)
    throw new Error('Development manifest changed during release preparation')
  rmSync(output, { recursive: true, force: true })
  renameSync(stage, output)
  console.log(
    JSON.stringify(
      {
        directory: output,
        name: manifest.name,
        version: manifest.version,
        files: files.length + 1,
        nativeHelpers: helperNames.length + 1,
        clientSha256: hashes.get('lib/client.js'),
        rootPrivate: true,
        publicPrivate: false,
        lifecycleScripts: false,
        built: false,
        packed: false,
        published: false,
      },
      null,
      2,
    ),
  )
} finally {
  rmSync(stage, { recursive: true, force: true })
}
