import { discoverCodexModels } from './codex-models.ts'
import { discoverFirstPartySources, readFirstPartyModelSources } from './first-party-models.ts'
import { extendedCatalog, isExtendedCli } from './extended-adapters.ts'
import { ZCodeProtocol, managedZCodeEntry } from './zcode-adapter.ts'
import { HermesProtocol } from './hermes-adapter.ts'
import { GrokProtocol } from './grok-adapter.ts'
import { OpenCodeProtocol } from './opencode-adapter.ts'
import { BridgeProtocol } from './bridge-protocol.ts'
import { verifyPiOmpExecutable } from './pi-omp-identity.ts'
import { resolveModel } from '../shared/models.ts'
import { existsSync, statSync, lstatSync, accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CLI_LABELS,
  EFFORTS,
  cliOf,
  type CliId,
  type ModelChoice,
  type Preference,
  type TaskMode,
} from '../shared/types.ts'
import { AgyProtocol, type EventInput } from './protocol.ts'
import { CliProtocol } from './cli-protocol.ts'
import {
  agyArguments,
  ProcessCleanupUnconfirmedError,
  type ProcessBackend,
  type RuntimeConfig,
} from './process.ts'

export interface Catalog {
  cli: CliId
  models: ModelChoice[]
  notice: string
}
const managedPiEntry = () =>
  join(
    homedir(),
    '.local/share/cliworker-now/runtimes/pi-1.0.2/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
  )
function entryPresent(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error: any) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    throw error
  }
}
export const executableFor = (cli: CliId, config: RuntimeConfig): string => {
  if (cli === 'harness') throw new Error('Harness CLI 已移除，请新建 Hermes 任务')
  if (cli === 'antigravity') return config.executable
  const configured = config[`${cli}Executable`]
  if (configured && configured !== cli) return configured
  if (cli === 'zcode')
    return existsSync(managedZCodeEntry())
      ? managedZCodeEntry()
      : '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'
  if (cli === 'grok') return join(homedir(), '.grok/bin/grok')
  if (cli === 'pi') {
    const native = join(homedir(), '.local/bin/pi')
    if (entryPresent(native)) return native
    const official = join(homedir(), '.pi/agent/bin/pi')
    if (entryPresent(official)) return official
  }
  // Desktop processes do not source .zshrc. Recognize official per-user installers.
  const nativeDirectory = cli === 'kimi' ? '.kimi-code/bin' : cli === 'mimo' ? '.mimocode/bin' : '.local/bin'
  const nativePath = join(homedir(), nativeDirectory, cli)
  return existsSync(nativePath) ? nativePath : (configured ?? cli)
}
/** Read-only discovery with bounded output. Never persist or expose provider credentials. */
export async function captureCatalogMetadata(
  backend: ProcessBackend,
  config: RuntimeConfig,
  argv: string[],
  cwd: string,
  signal: AbortSignal,
  env?: Record<string, string>,
) {
  signal.throwIfAborted()
  const control = AbortSignal.any([signal, AbortSignal.timeout(15000)])
  const process = backend.spawn({
    argv,
    cwd,
    env,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: config.graceMs,
    signal: control,
  })
  void process.done.catch(() => undefined)
  let output = '',
    bytes = 0
  const read = async (stream: typeof process.stdout, keep: boolean) => {
    if (stream)
      for await (const chunk of stream) {
        bytes += Buffer.byteLength(chunk)
        if (bytes > config.maxRunBytes) throw new Error('CLI discovery output too large')
        if (keep) output += String(chunk)
      }
  }
  const readers = [read(process.stdout, true), read(process.stderr, false)]
  try {
    await Promise.all(readers)
    const outcome = await process.done
    control.throwIfAborted()
    if (outcome.exitCode !== 0) throw new Error('CLI 模型查询失败，请在终端检查该 CLI 配置')
    return output
  } finally {
    let exited = false
    try {
      process.terminate()
      exited = await process.waitForExit()
    } catch {
      throw new ProcessCleanupUnconfirmedError()
    }
    if (!exited) throw new ProcessCleanupUnconfirmedError()
    await Promise.allSettled([...readers, process.done])
  }
}
const capture = captureCatalogMetadata
export async function catalogFor(
  cli: CliId,
  backend: ProcessBackend,
  config: RuntimeConfig,
  cwd: string,
  signal: AbortSignal,
): Promise<Catalog> {
  const executable = await resolveCliExecutable(cli, backend, config, signal)
  signal.throwIfAborted()
  if (isExtendedCli(cli)) {
    const models = await extendedCatalog(
      cli,
      executable,
      (argv, env) => capture(backend, config, argv, cwd, signal, env),
      config.stateDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cliworker-now'),
      config,
      signal,
    )
    if (!models.length) throw new Error(`${CLI_LABELS[cli]} 当前账号暂无可用模型，请登录或刷新`)
    return {
      cli,
      models,
      notice: '当前账号可用模型',
    }
  }
  if (cli === 'antigravity') throw new Error('Antigravity 尚未提供可确认的账号模型范围')
  if (cli === 'codex') {
    const models = await discoverCodexModels(backend, config, executable, cwd, signal)
    if (!models.length) throw new Error('Codex 当前账号暂无可确认模型，请刷新')
    return { cli, models, notice: '当前账号可用模型' }
  }
  if (cli === 'claude' || cli === 'kimi' || cli === 'mimo') {
    const sources = await readFirstPartyModelSources(
      cli,
      executable,
      cwd,
      (argv, env) => capture(backend, config, argv, cwd, signal, env),
      signal,
    )
    const models = await discoverFirstPartySources(sources, signal)
    if (!models.length) throw new Error(`${CLI_LABELS[cli]} 当前账号暂无可确认模型，请检查配置`)
    return { cli, models, notice: '当前账号可用模型' }
  }
  throw new Error('Unsupported CLI')
}
/** Official models --verbose prints provider/model followed by a pretty JSON object. */
export function parseMimoModels(output: string): ModelChoice[] {
  const models: ModelChoice[] = []
  let id = '',
    buffer = ''
  for (const line of output.split(/\r?\n/)) {
    if (!buffer && /^[A-Za-z0-9_.:-]+\/[^\s]+/.test(line)) {
      id = line.split(/\s/)[0]!
      continue
    }
    if (!buffer && line.trim() !== '{') continue
    buffer += line + '\n'
    try {
      const model = JSON.parse(buffer)
      if (id)
        models.push({
          id,
          label: String(model.name ?? id),
          efforts: [
            'default',
            ...Object.keys(model.variants ?? {}).filter((e) => e !== 'default' && EFFORTS.includes(e as any)),
          ] as ModelChoice['efforts'],
        })
      id = ''
      buffer = ''
    } catch {
      /* Wait for the rest of the pretty-printed JSON object. */
    }
  }
  return models
}
export function validatePreference(preference: Preference, catalog: Catalog): void {
  if (cliOf(preference) !== catalog.cli) throw new Error('CLI 配置不匹配')
  resolveModel(preference, catalog.models)
}
export function workerArguments(
  executable: string,
  project: string,
  preference: Preference,
  mode: TaskMode,
  prompt: string,
  timeoutMs: number,
  conversationId?: string,
): string[] {
  const cli = cliOf(preference)
  const task = `任务：\n${prompt}`
  if (cli === 'antigravity')
    return agyArguments(executable, project, preference, mode, prompt, timeoutMs, conversationId)
  if (cli === 'codex')
    return [
      executable,
      'exec',
      ...(conversationId ? ['resume', conversationId] : []),
      '--json',
      '--skip-git-repo-check',
      '--model',
      preference.model,
      '-c',
      `model_reasoning_effort=${JSON.stringify(preference.effort)}`,
      '-c',
      `sandbox_mode=${JSON.stringify(mode === 'plan' ? 'read-only' : 'workspace-write')}`,
      '-c',
      'approval_policy="never"',
      task,
    ]
  if (cli === 'claude')
    return [
      executable,
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--model',
      preference.model,
      ...(preference.effort !== 'default' ? ['--effort', preference.effort] : []),
      '--permission-mode',
      mode === 'plan' ? 'plan' : 'acceptEdits',
      ...(conversationId ? ['--resume', conversationId] : []),
      task,
    ]
  if (cli === 'kimi') {
    if (mode === 'plan')
      throw new Error('Kimi 当前非交互模式不支持只读派遣，请使用其他 CLI 或明确授权写入任务')
    if (preference.effort !== 'default') throw new Error('Kimi CLI 不支持传入思考强度')
    return [
      executable,
      '--model',
      preference.model,
      '--output-format',
      'stream-json',
      ...(conversationId ? ['--session', conversationId] : []),
      '-p',
      task,
    ]
  }
  if (cli === 'mimo')
    return [
      executable,
      'run',
      '--format',
      'json',
      '--model',
      preference.model,
      '--agent',
      mode === 'plan' ? 'plan' : 'build',
      ...(preference.effort !== 'default' ? ['--variant', preference.effort] : []),
      ...(conversationId ? ['--session', conversationId] : []),
      task,
    ]
  throw new Error(`${CLI_LABELS[cli]} 尚未接入`)
}
export function protocolFor(
  cli: CliId,
  emit: (event: EventInput) => void,
  identify: (id: string) => void,
  maxLineBytes: number,
  expectedModel?: string,
) {
  if (cli === 'harness') throw new Error('Harness CLI 已移除，历史记录仅供查看')
  if (cli === 'zcode') return new ZCodeProtocol(emit, identify, maxLineBytes, expectedModel)
  if (cli === 'hermes') return new HermesProtocol(emit, identify, maxLineBytes)
  if (cli === 'grok') return new GrokProtocol(emit, identify, maxLineBytes)
  if (cli === 'opencode') return new OpenCodeProtocol(emit, identify, maxLineBytes)
  if (cli === 'pi' || cli === 'omp') return new BridgeProtocol(emit, identify, maxLineBytes)
  return cli === 'antigravity'
    ? new AgyProtocol(emit, identify, maxLineBytes)
    : new CliProtocol(cli, emit, identify, maxLineBytes)
}

export async function resolveCliExecutable(
  cli: CliId,
  backend: ProcessBackend,
  config: RuntimeConfig,
  signal: AbortSignal = AbortSignal.timeout(15000),
): Promise<string> {
  signal.throwIfAborted()
  const executable = executableFor(cli, config)
  let resolved: string
  if (isExtendedCli(cli) && /\.[cm]?js$/.test(executable) && existsSync(executable)) {
    // JavaScript launchers run through Node and need readability, not an executable bit.
    // A directory ending in .js is a broken configuration, not an installed CLI.
    if (!statSync(executable).isFile()) throw new Error('CLI 脚本路径不是普通文件')
    accessSync(executable, constants.R_OK)
    resolved = executable
  } else {
    const lookup = async () => {
      try {
        return await backend.resolveExecutable(executable)
      } catch (error: any) {
        // Only an absent default PATH entry can use the legacy private install.
        // A broken or incompatible native/configured entry must remain an error.
        if (cli === 'pi' && executable === 'pi' && ['ENOENT', 'ENOTDIR'].includes(error.code)) {
          const managed = managedPiEntry()
          if (existsSync(managed) && statSync(managed).isFile()) {
            accessSync(managed, constants.R_OK)
            return managed
          }
        }
        throw error
      }
    }
    // Path lookup owns no process; it may be abandoned, but no late resolution
    // may start an identity probe after its caller has cancelled.
    resolved = await new Promise<string>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      void lookup()
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort))
      if (signal.aborted) abort()
    })
  }
  signal.throwIfAborted()
  if (cli === 'pi' || cli === 'omp')
    return verifyPiOmpExecutable(cli, resolved, (argv, cwd, env) =>
      captureCatalogMetadata(backend, config, argv, cwd, signal, env),
    )
  return resolved
}
