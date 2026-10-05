import { mkdir, mkdtemp, realpath, writeFile, lstat, open, rename, rm } from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ModelChoice, TaskMode } from '../shared/types.ts'

export type PiOmpCli = 'pi' | 'omp'
export interface PiOmpInput {
  cli: PiOmpCli
  executable: string
  project: string
  preference: { model: string; effort: string }
  mode: TaskMode
  prompt: string
  conversationId?: string
  stateDirectory: string
}
const modelFor = (cli: PiOmpCli) => `${cli === 'pi' ? 'zai-coding-cn' : 'cliworker-zai-cn'}/glm-5.3-flash`
const bridgePath = () => {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, 'pi-omp-bridge.mjs'), resolve(here, '../../pi-omp-bridge.mjs')])
    if (existsSync(candidate)) return candidate
  throw new Error('Pi/OMP bridge 未安装，请重新构建插件')
}
async function privateDirectory(path: string) {
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
async function argumentsFor(
  input: PiOmpInput | { cli: PiOmpCli; executable: string; stateDirectory: string; discover: true },
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
  const requestDirectory = await mkdtemp(join(isolated, 'request-'))
  const requestPath = join(requestDirectory, 'request.json')
  const temporary = join(requestDirectory, `.request-${randomUUID()}.tmp`)
  try {
    await writeFile(
      temporary,
      JSON.stringify({
        ...input,
        stateDirectory: isolated,
        ...('project' in input ? { project: await realpath(input.project) } : {}),
      }),
      { flag: 'wx', mode: 0o600 },
    )
    await rename(temporary, requestPath)
  } finally {
    await rm(temporary, { force: true })
  }
  return { argv: [process.execPath, bridgePath(), requestPath] }
}

/** Only the previously verified CN route is enabled. Credentials are supplied by Host at spawn. */
export async function preparePiOmp(
  input: PiOmpInput,
): Promise<{ argv: string[]; env?: Record<string, string> }> {
  if (input.cli !== 'pi' && input.cli !== 'omp') throw new Error('Unsupported Pi/OMP CLI')
  if (input.preference.model !== modelFor(input.cli))
    throw new Error('Pi/OMP 首版仅支持已验证的智谱 GLM-5.3-Flash 路由')
  if (!['low', 'high', 'max'].includes(input.preference.effort))
    throw new Error('GLM-5.3-Flash 强度必须明确选择 low/high/max')
  if (!['plan', 'accept-edits'].includes(input.mode)) throw new Error('Unsupported task mode')
  if (!input.prompt.trim()) throw new Error('Prompt must not be empty')
  return argumentsFor(input)
}

export async function discoverPiOmp(
  cli: PiOmpCli,
  executable: string,
  capture: (argv: string[], env?: Record<string, string>) => Promise<string>,
  stateDirectory: string,
): Promise<ModelChoice[]> {
  if (cli !== 'pi' && cli !== 'omp') throw new Error('Unsupported Pi/OMP CLI')
  const launch = await argumentsFor({ cli, executable, stateDirectory, discover: true })
  const raw: unknown = JSON.parse(await capture(launch.argv))
  if (!Array.isArray(raw)) throw new Error('Invalid Pi/OMP model catalog')
  return raw.flatMap((model): ModelChoice[] => {
    if (!model || typeof model !== 'object' || model.id !== modelFor(cli) || !Array.isArray(model.efforts))
      return []
    const efforts = model.efforts.filter(
      (effort: unknown): effort is 'low' | 'high' | 'max' =>
        effort === 'low' || effort === 'high' || effort === 'max',
    )
    return efforts.length ? [{ id: model.id, label: 'GLM-5.3-Flash（智谱 Coding CN）', efforts }] : []
  })
}
