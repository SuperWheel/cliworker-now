import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalSpawnSpec,
  SubprocessTerminalHandle,
} from '@deepseek-ai/dsh-subprocess'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'
import type { ModelChoice, Preference, TaskMode } from '../shared/types.ts'

export interface ProcessBackend {
  resolveExecutable(name: string): Promise<string>
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
  spawnTerminal?(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
}
/** A process range is still unconfirmed; callers must stop admitting work. */
export class ProcessCleanupUnconfirmedError extends Error {
  constructor() {
    super('CLI catalog process cleanup did not reach quiescence')
    this.name = 'ProcessCleanupUnconfirmedError'
  }
}
export interface RuntimeConfig {
  executable: string
  codexExecutable?: string
  claudeExecutable?: string
  kimiExecutable?: string
  mimoExecutable?: string
  zcodeExecutable?: string
  grokExecutable?: string
  ompExecutable?: string
  piExecutable?: string
  hermesExecutable?: string
  hermesHome?: string
  opencodeExecutable?: string
  zcodeAuthDirectory?: string
  zcodeBuiltinConfig?: string
  stateDirectory?: string
  zaiCredentialRef?: string
  resolveCredential?: (ref: string) => Promise<string | undefined>
  maxConcurrent: number
  timeoutMs: number
  graceMs: number
  maxLineBytes: number
  maxRunBytes: number
  maxTimelineItems: number
}
export const DEFAULT_CONFIG: RuntimeConfig = {
  executable: 'agy',
  maxConcurrent: 2,
  timeoutMs: 1_800_000,
  graceMs: 5000,
  maxLineBytes: 1_048_576,
  maxRunBytes: 16_777_216,
  maxTimelineItems: 1000,
}

export function projectDirectory(input: string): string {
  if (!isAbsolute(input)) throw new Error('Project must be an absolute directory')
  const path = realpathSync(input)
  const home = realpathSync(homedir())
  if (path === sep || path === home || home.startsWith(path + sep))
    throw new Error('Refusing a root or home directory as workspace')
  const forbidden = [
    '.ssh',
    '.aws',
    '.codex',
    '.claude',
    '.kimi-code',
    '.config/mimocode',
    '.local/share/mimocode',
    '.agents',
    '.grok',
    '.pi',
    '.omp',
    '.dsh',
    '.hermes',
    '.zcode',
    '.local/share/opencode',
    '.gemini',
    '.config',
    'Library/Keychains',
    'Library/Application Support/Google',
    'Library/Application Support/Microsoft Edge',
  ]
  if (
    forbidden.some((name) => {
      const root = resolve(home, name)
      return path === root || path.startsWith(root + sep)
    })
  )
    throw new Error('Refusing a credential or application configuration directory')
  if (!statSync(path).isDirectory()) throw new Error('Project is not a directory')
  accessSync(path, constants.R_OK | constants.X_OK)
  return path
}

export function agyArguments(
  executable: string,
  project: string,
  preference: Preference,
  mode: TaskMode,
  prompt: string,
  timeoutMs: number,
  conversationId?: string,
): string[] {
  // --disable-slash-commands also disables --mode plan in agy 1.2.16.
  // Prefix plain task text instead, and keep the native mode effective.
  return [
    executable,
    '--add-dir',
    project,
    '--sandbox',
    '--dangerously-skip-permissions',
    '--mode',
    mode,
    '--model',
    preference.model,
    ...(preference.effort === 'default' ? [] : ['--effort', preference.effort]),
    '--output-format',
    'stream-json',
    '--print-timeout',
    `${Math.ceil(timeoutMs / 1000)}s`,
    ...(conversationId ? ['--conversation', conversationId] : []),
    '--print',
    `任务：\n${prompt}`,
  ]
}

/** Bound discovery and always await managed process cleanup. No agent prompt is sent. */
export async function discoverModels(
  backend: ProcessBackend,
  config: RuntimeConfig,
  cwd: string,
  signal: AbortSignal,
): Promise<ModelChoice[]> {
  const executable = await backend.resolveExecutable(config.executable)
  signal.throwIfAborted()
  const control = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  const process = backend.spawn({
    argv: [executable, 'models'],
    cwd,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: config.graceMs,
    signal: control,
  })
  void process.done.catch(() => undefined)
  let stdout = ''
  let stderr = ''
  const read = async (stream: typeof process.stdout, out: (s: string) => void) => {
    if (stream) for await (const chunk of stream) out(String(chunk))
  }
  try {
    await Promise.all([
      read(process.stdout, (s) => {
        stdout += s
        if (stdout.length > config.maxLineBytes) throw new Error('Model catalog too large')
      }),
      read(process.stderr, (s) => {
        stderr = (stderr + s).slice(-4096)
      }),
    ])
    const outcome = await process.done
    control.throwIfAborted()
    if (outcome.exitCode !== 0) throw new Error(`无法读取 Antigravity 模型：${stderr || outcome.exitCode}`)
    const models = stdout.split(/\r?\n/).flatMap((line) => {
      const [id, ...label] = line.split('\t')
      return id && label.length && /^[A-Za-z0-9_.:/-]+$/.test(id)
        ? [{ id, label: label.join(' ').trim() }]
        : []
    })
    if (!models.length) throw new Error('Antigravity returned no model catalog; check login with agy models')
    return models
  } finally {
    process.terminate()
    await process.waitForExit()
    await process.done.catch(() => undefined)
  }
}
