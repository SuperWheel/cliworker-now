import { extendedCatalog, isExtendedCli } from './extended-adapters.ts'
import { ZCodeProtocol, managedZCodeEntry } from './zcode-adapter.ts'
import { HermesProtocol } from './hermes-adapter.ts'
import { GrokProtocol } from './grok-adapter.ts'
import { OpenCodeProtocol } from './opencode-adapter.ts'
import { BridgeProtocol } from './bridge-protocol.ts'
import { groupAgyModels, resolveModel } from '../shared/models.ts'
import { readFileSync, existsSync, statSync, accessSync, constants } from 'node:fs'
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
  discoverModels,
  ProcessCleanupUnconfirmedError,
  type ProcessBackend,
  type RuntimeConfig,
} from './process.ts'

export interface Catalog {
  cli: CliId
  models: ModelChoice[]
  notice: string
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
    const managed = join(
      homedir(),
      '.local/share/cliworker-now/runtimes/pi-1.0.2/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
    )
    if (existsSync(managed)) return managed
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
  const executable = await resolveCliExecutable(cli, backend, config)
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
    if (!models.length)
      throw new Error(
        ['pi', 'omp', 'opencode'].includes(cli)
          ? `${CLI_LABELS[cli]} 尚无可确认当前账号支持的 Worker 模型；请检查登录及账号模型权限后刷新。仅有目录、自定义配置或旧成功记录的候选已隐藏。`
          : `${CLI_LABELS[cli]} 未返回可选模型，请检查原生安装与凭据配置`,
      )
    return {
      cli,
      models,
      notice:
        cli === 'zcode'
          ? 'ZCode 使用原生可见服务商和模型目录；目录不证明账号或额度可用。交互权限请求拒绝；原生允许的全局 MCP 仍可能执行。'
          : cli === 'grok'
            ? 'Grok 仅完成离线协议验证；账号、真实任务和续聊尚未验收。模型来自原生目录，不代表订阅可用。'
            : cli === 'pi' || cli === 'omp' || cli === 'opencode'
              ? '仅列出有当前账号支持证据且适用于 Worker 的模型，无法确认的通用目录已隐藏。相同型号去重，新选择优先有明确证据的免费额度；当前额度仍以服务商实时结果为准，失败不会切换模型。'
              : '模型来自原生 CLI；目录不代表账号额度。额外权限默认拒绝，失败时不切换 CLI 或模型。',
    }
  }
  if (cli === 'antigravity')
    return {
      cli,
      models: groupAgyModels(await discoverModels(backend, config, cwd, signal)),
      notice: '模型与强度来自 agy models；未公开强度的模型沿用 CLI 配置。',
    }
  if (cli === 'codex') {
    const cache = JSON.parse(
      readFileSync(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json'), 'utf8'),
    )
    const models: ModelChoice[] = (cache.models ?? [])
      .filter((m: any) => m.visibility === 'list')
      .map((m: any) => ({
        id: String(m.slug),
        label: String(m.display_name ?? m.slug),
        efforts: (m.supported_reasoning_levels ?? [])
          .map((e: any) => e.effort)
          .filter((e: any) => EFFORTS.includes(e)),
      }))
      .filter((m: ModelChoice) => m.id && m.efforts?.length)
    if (!models.length) throw new Error('没有 Codex 模型缓存；请先在终端启动 Codex 刷新模型列表')
    return {
      cli,
      models,
      notice: '模型来自本机 Codex 缓存，可能过期。使用 workspace-write / read-only 沙箱；不自动批准提权。',
    }
  }
  if (cli === 'claude') {
    const help = await capture(backend, config, [executable, '--help'], cwd, signal)
    if (!help.includes('--effort') || !help.includes('--output-format'))
      throw new Error('Claude 版本不支持所需参数，请升级后重试')
    const efforts = EFFORTS.filter((e) =>
      new RegExp(`\\b${e}\\b`).test(help.match(/--effort[\s\S]*?(?=\n\s+--|$)/)?.[0] ?? ''),
    )
    return {
      cli,
      models: ['sonnet', 'opus'].map((id) => ({
        id,
        label: `Claude 官方模型别名 ${id}（账户可用性由 CLI 验证）`,
        efforts,
      })),
      notice:
        'Claude acceptEdits 模式；保留原生权限检查，需要额外授权的工具会被拒绝并显示原因。别名不代表账户一定可用。',
    }
  }
  if (cli === 'kimi') {
    const raw = JSON.parse(
      await capture(backend, config, [executable, 'provider', 'list', '--json'], cwd, signal),
    )
    const models = Object.keys(raw.models ?? {}).map((id) => ({
      id,
      label: id,
      efforts: ['default' as const],
    }))
    if (!models.length) throw new Error('Kimi 尚无模型配置，请先在终端登录并配置模型')
    return {
      cli,
      models,
      notice: 'Kimi -p 自动执行工具；当前 CLI 没有强度参数，只能沿用其配置，且不支持只读派遣。',
    }
  }
  if (cli === 'mimo') {
    const output = await capture(backend, config, [executable, 'models', '--verbose'], cwd, signal)
    const models = parseMimoModels(output)
    if (!models.length) throw new Error('MiMo 未返回模型，请先在官方 mimo CLI 配置提供商')
    return {
      cli,
      models,
      notice:
        '仅适配 XiaomiMiMo/MiMo-Code 官方 CLI。使用 build / plan agent，保留原生权限检查；强度取自模型 variants。',
    }
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
      '--effort',
      preference.effort,
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
): Promise<string> {
  const executable = executableFor(cli, config)
  if (isExtendedCli(cli) && /\.[cm]?js$/.test(executable) && existsSync(executable)) {
    // JavaScript launchers run through Node and need readability, not an executable bit.
    // A directory ending in .js is a broken configuration, not an installed CLI.
    if (!statSync(executable).isFile()) throw new Error('CLI 脚本路径不是普通文件')
    accessSync(executable, constants.R_OK)
    return executable
  }
  return backend.resolveExecutable(executable)
}
