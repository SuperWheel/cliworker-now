import { mkdir, mkdtemp, realpath, writeFile, lstat, open, rename, rm } from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EFFORTS, type ModelChoice, type TaskMode } from '../shared/types.ts'
import { ProcessCleanupUnconfirmedError } from './process.ts'

import { snapshotPiOmpNative, safePiOmpAncestors, type PiOmpNativeOptions } from './pi-omp-native.ts'

export type PiOmpCli = 'pi' | 'omp'
export type PiOmpMetadataPhase = 'native-candidates' | 'account-scope'
export type PiOmpMetadataCapture = (
  argv: string[],
  env?: Record<string, string>,
  phase?: PiOmpMetadataPhase,
) => Promise<string>
export interface PiOmpInput extends PiOmpNativeOptions {
  managedCredentials?: boolean
  cli: PiOmpCli
  executable: string
  project: string
  preference: { model: string; effort: string }
  mode: TaskMode
  prompt: string
  conversationId?: string
  stateDirectory: string
}
const bridgePath = () => {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, 'pi-omp-bridge.mjs'), resolve(here, '../../pi-omp-bridge.mjs')])
    if (existsSync(candidate)) return candidate
  throw new Error('Pi/OMP bridge 未安装，请重新构建插件')
}
async function privateDirectory(path: string) {
  await safePiOmpAncestors(path)
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Unsafe Pi/OMP state directory symlink')
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (info.dev !== opened.dev || info.ino !== opened.ino)
      throw new Error('Pi/OMP state directory changed while opening')
    await handle.chmod(0o700)
  } finally {
    await handle.close()
  }
  return realpath(path)
}
async function contextFor(
  input:
    | PiOmpInput
    | ({ cli: PiOmpCli; executable: string; stateDirectory: string; discover: true } & PiOmpNativeOptions),
) {
  const stateDirectory = resolve(input.stateDirectory)
  const root = await privateDirectory(stateDirectory)
  const identity =
    'discover' in input
      ? 'catalog'
      : createHash('sha256')
          .update(await realpath(input.project))
          .digest('hex')
  const cliDirectory = await privateDirectory(join(root, input.cli))
  const isolated = await privateDirectory(join(cliDirectory, identity))
  const agent = await privateDirectory(join(isolated, 'agent'))
  // Refresh native model/config sources for every request. On continuation this
  // worker's refreshed OAuth takes precedence over old source credentials.
  const native = await snapshotPiOmpNative(input.cli, agent, {
    accountRoot: input.accountRoot ?? stateDirectory,
    nativeHome: input.nativeHome,
    preserveCredentials: 'conversationId' in input && !!input.conversationId,
  })
  const request = async (extra: Record<string, unknown> = {}) => {
    const requestDirectory = await mkdtemp(join(isolated, 'request-'))
    const requestPath = join(requestDirectory, 'request.json')
    const temporary = join(requestDirectory, `.request-${randomUUID()}.tmp`)
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          ...input,
          ...extra,
          stateDirectory: isolated,
          ...('project' in input ? { project: await realpath(input.project) } : {}),
        }),
        { flag: 'wx', mode: 0o600 },
      )
      await rename(temporary, requestPath)
    } finally {
      await rm(temporary, { force: true })
    }
    return { argv: [process.execPath, bridgePath(), requestPath], env: native.env }
  }
  return { request }
}

async function confirmedCatalog(
  context: Awaited<ReturnType<typeof contextFor>>,
  capture: PiOmpMetadataCapture,
) {
  for (const phase of ['native-candidates', 'account-scope'] as const) {
    const launch = await context.request({ metadataPhase: phase })
    let raw: unknown
    try {
      raw = JSON.parse(await capture(launch.argv, launch.env, phase))
    } catch (error) {
      if (error instanceof ProcessCleanupUnconfirmedError) throw error
      throw new Error('无法读取 Pi/OMP 原生模型目录，请检查本机配置')
    }
    if (phase === 'account-scope') return parseCatalog(raw)
    if (
      !raw ||
      typeof raw !== 'object' ||
      (raw as any).phase !== phase ||
      !Number.isSafeInteger((raw as any).count) ||
      (raw as any).count < 0
    )
      throw new Error('Invalid Pi/OMP candidate phase result')
  }
  throw new Error('Missing Pi/OMP account scope')
}

/** The bridge validates exact native model capabilities before sending any prompt. */
export async function preparePiOmp(
  input: PiOmpInput,
  capture?: PiOmpMetadataCapture,
): Promise<{ argv: string[]; env?: Record<string, string> }> {
  if (input.cli !== 'pi' && input.cli !== 'omp') throw new Error('Unsupported Pi/OMP CLI')
  if (!/^[A-Za-z0-9_.:-]+\/[^\s\x00-\x1f]+$/.test(input.preference.model))
    throw new Error('Pi/OMP 需要原生 provider/model 选型')
  if (!(EFFORTS as readonly string[]).includes(input.preference.effort))
    throw new Error('Unsupported native model effort')
  if (!['plan', 'accept-edits'].includes(input.mode)) throw new Error('Unsupported task mode')
  if (!input.prompt.trim()) throw new Error('Prompt must not be empty')
  const context = await contextFor(input)
  // Preparing a request is reversible. Execution requires the Host's two
  // captures on this exact snapshot; an unconfirmed request cannot send prompts.
  const catalog = capture ? await confirmedCatalog(context, capture) : undefined
  return context.request(catalog ? { confirmedCatalog: catalog } : {})
}
export async function discoverPiOmp(
  cli: PiOmpCli,
  executable: string,
  capture: PiOmpMetadataCapture,
  stateDirectory: string,
  options: PiOmpNativeOptions & { managedCredentials?: boolean } = {},
): Promise<ModelChoice[]> {
  if (cli !== 'pi' && cli !== 'omp') throw new Error('Unsupported Pi/OMP CLI')
  const context = await contextFor({ cli, executable, stateDirectory, discover: true, ...options })
  return confirmedCatalog(context, capture)
}
function parseCatalog(raw: unknown): ModelChoice[] {
  if (!Array.isArray(raw)) throw new Error('Invalid Pi/OMP model catalog')
  const ids = new Set<string>()
  return raw.map((model): ModelChoice => {
    if (
      !model ||
      typeof model !== 'object' ||
      typeof model.id !== 'string' ||
      !/^[A-Za-z0-9_.:-]+\/[^\s\x00-\x1f]+$/.test(model.id) ||
      typeof model.label !== 'string' ||
      !Array.isArray(model.efforts) ||
      !model.efforts.length ||
      model.efforts.some((effort: unknown) => !(EFFORTS as readonly unknown[]).includes(effort)) ||
      ids.has(model.id)
    )
      throw new Error('Invalid Pi/OMP native model entry')
    ids.add(model.id)
    return {
      id: model.id,
      label: model.label,
      efforts: [...new Set(model.efforts)] as ModelChoice['efforts'],
      ...(model.cost === 'free' || model.cost === 'paid' || model.cost === 'unknown'
        ? { cost: model.cost }
        : {}),
    }
  })
}
