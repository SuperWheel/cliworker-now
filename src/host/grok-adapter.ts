import { chmod, lstat, mkdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { EFFORTS, type Effort, type ModelChoice, type TaskMode } from '../shared/types.ts'
import type { EventInput, ProtocolResult } from './protocol.ts'
import { assertGrokNativeEnvironment, discoverGrokAccountModels } from './grok-models.ts'

export interface GrokInput {
  executable: string
  project: string
  preference: { model: string; effort: Effort }
  mode: TaskMode
  prompt: string
  conversationId?: string
  stateDirectory: string
}
const record = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const config = `[cli]\nauto_update = false\nuse_leader = false\n[features]\nsupport_permission = true\ntelemetry = false\nfeedback = false\ncodebase_indexing = false\n[telemetry]\ntrace_upload = false\nmixpanel_enabled = false\n[subagents]\nenabled = false\n[session]\nload_envrc = false\n[shell_environment_policy]\ninherit = "core"\nignore_default_excludes = false\n`
function bridgePath() {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const path of [join(here, 'grok-catalog.mjs'), resolve(here, '../../grok-catalog.mjs')])
    if (existsSync(path)) return path
  throw new Error('Grok catalog bridge 未安装，请重新构建插件')
}
async function state(stateDirectory: string, project?: string) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  if ((await lstat(stateDirectory)).isSymbolicLink()) throw new Error('Unsafe Grok state symlink')
  await chmod(stateDirectory, 0o700)
  const parent = join(await realpath(stateDirectory), 'grok')
  const identity = project
    ? createHash('sha256')
        .update(await realpath(project))
        .digest('hex')
    : 'catalog'
  const root = join(parent, identity),
    home = join(root, 'home'),
    tmp = join(root, 'tmp')
  for (const path of [parent, root, home, tmp]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Unsafe Grok state symlink')
    await chmod(path, 0o700)
  }
  const configPath = join(home, 'config.toml')
  // Do not follow a modified state's configuration symlink when updating the safety defaults.
  try {
    if ((await lstat(configPath)).isSymbolicLink()) throw new Error('Unsafe Grok configuration symlink')
  } catch (e) {
    if (!record(e) || e.code !== 'ENOENT') throw e
  }
  await writeFile(configPath, config, { mode: 0o600 })
  await chmod(configPath, 0o600)
  if (project) {
    const original = join(homedir(), '.grok', 'auth.json'),
      target = join(home, 'auth.json')
    // This path is a derived worker reference, never an account source. Replace
    // the link itself so logout cannot be undone by a surviving worker copy.
    try {
      const existing = await lstat(target)
      if (!existing.isFile() && !existing.isSymbolicLink()) throw new Error('Unsafe Grok auth snapshot')
      await unlink(target)
    } catch (e) {
      if (!record(e) || e.code !== 'ENOENT') throw e
    }
    if (existsSync(original)) await symlink(original, target)
  }
  return {
    root,
    env: {
      GROK_HOME: home,
      GROK_AUTH_PATH: join(home, 'auth.json'),
      XAI_API_KEY: '',
      GROK_CODE_XAI_API_KEY: '',
      TMPDIR: tmp,
      GROK_MEMORY: '0',
      GROK_SUBAGENTS: '0',
      GROK_WORKFLOWS: '0',
      GROK_WEB_FETCH: '0',
      GROK_TELEMETRY_ENABLED: '0',
      GROK_TELEMETRY_TRACE_UPLOAD: '0',
      GROK_TELEMETRY_MIXPANEL_ENABLED: '0',
    },
  }
}
/** Offline help/ACP verified; subscription-dependent task execution remains unverified. */
export async function prepareGrok(
  input: GrokInput,
): Promise<{ argv: string[]; env: Record<string, string> }> {
  assertGrokNativeEnvironment()
  if (!input.preference.model.trim()) throw new Error('Grok model must be selected')
  if (!EFFORTS.includes(input.preference.effort)) throw new Error('Invalid Grok effort')
  if (!['plan', 'accept-edits'].includes(input.mode)) throw new Error('Invalid Grok mode')
  if (!input.prompt.trim()) throw new Error('Prompt must not be empty')
  const prepared = await state(input.stateDirectory, input.project)
  return {
    argv: [
      input.executable,
      '--cwd',
      input.project,
      '--model',
      input.preference.model,
      ...(input.preference.effort === 'default' ? [] : ['--reasoning-effort', input.preference.effort]),
      '--output-format',
      'streaming-json',
      '--permission-mode',
      input.mode === 'plan' ? 'default' : 'acceptEdits',
      '--no-memory',
      '--no-subagents',
      '--disable-web-search',
      ...(input.mode === 'plan' ? ['--tools', 'read_file,grep,list_dir'] : []),
      ...(input.conversationId ? ['--resume', input.conversationId] : []),
      '--single',
      `任务：\n${input.prompt}`,
    ],
    env: prepared.env,
  }
}
export async function discoverGrok(
  executable: string,
  capture: (argv: string[], env?: Record<string, string>, phase?: 'native-candidates') => Promise<string>,
  stateDirectory: string,
  options: { signal?: AbortSignal; home?: string; fetch?: typeof fetch } = {},
): Promise<ModelChoice[]> {
  options.signal?.throwIfAborted()
  assertGrokNativeEnvironment()
  const prepared = await state(stateDirectory)
  const raw: unknown = JSON.parse(
    await capture(
      [process.execPath, bridgePath(), executable, prepared.root],
      prepared.env,
      'native-candidates',
    ),
  )
  if (!Array.isArray(raw)) throw new Error('Invalid Grok catalog')
  const models = raw.map((x): ModelChoice => {
    if (
      !record(x) ||
      typeof x.id !== 'string' ||
      !x.id ||
      typeof x.label !== 'string' ||
      !Array.isArray(x.efforts)
    )
      throw new Error('Invalid Grok model')
    const efforts = x.efforts.filter(
      (v): v is Effort => typeof v === 'string' && EFFORTS.includes(v as Effort),
    )
    if (!efforts.length || efforts.length !== x.efforts.length)
      throw new Error('Unsupported Grok reasoning levels')
    return { id: x.id, label: x.label, efforts }
  })
  if (!models.length || new Set(models.map((x) => x.id)).size !== models.length)
    throw new Error('Grok 模型目录为空或重复')
  options.signal?.throwIfAborted()
  const version = await capture([executable, '--version'], prepared.env, 'native-candidates')
  options.signal?.throwIfAborted()
  return discoverGrokAccountModels(models, {
    ...options,
    nativeDynamicSchema: version.trim() === 'grok 1.0.0 (3cd0d0cbcebe)',
  })
}
/** Native streaming-json parser from installed 1.0.0 docs; no fabricated execution evidence. */
export class GrokProtocol {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private response = ''
  private terminal = false
  private failure?: string
  private ended = false
  private tools = new Map<string, { step: number; name: string; done: boolean }>()
  result?: ProtocolResult
  conversationId?: string
  constructor(
    private emit: (event: EventInput) => void,
    private identify: (id: string) => void,
    private maxLineBytes: number,
  ) {}
  feed(chunk: Buffer | string) {
    if (this.ended) throw new Error('Grok stream already ended')
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let end: number
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end).trim()
      this.pending = this.pending.slice(end + 1)
      if (line) this.line(line)
    }
    if (Buffer.byteLength(this.pending) > this.maxLineBytes) throw new Error('CLI event exceeds maxLineBytes')
  }
  end() {
    if (this.ended) return
    this.pending += this.decoder.end()
    if (this.pending.trim()) this.line(this.pending.trim())
    this.pending = ''
    this.ended = true
    if (!this.conversationId) return
    const error =
      this.failure ??
      (!this.terminal
        ? 'Grok 缺少 end 终态'
        : [...this.tools.values()].some((x) => !x.done)
          ? 'Grok 工具没有完成结果'
          : undefined)
    this.result = {
      conversationId: this.conversationId,
      status: error ? 'ERROR' : 'SUCCESS',
      response: this.response,
      ...(error ? { error } : {}),
    }
    this.emit({
      kind: 'result',
      text: this.response,
      state: this.result.status,
      ...(error ? { detail: error } : {}),
    })
  }
  private id(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid Grok session identity')
    if (this.conversationId && this.conversationId !== value) throw new Error('Grok session identity changed')
    if (!this.conversationId) this.identify(value)
    this.conversationId = value
  }
  private line(line: string) {
    if (Buffer.byteLength(line) > this.maxLineBytes) throw new Error('CLI event exceeds maxLineBytes')
    const e: unknown = JSON.parse(line)
    if (!record(e) || typeof e.type !== 'string') throw new Error('Invalid Grok event')
    if (this.terminal) throw new Error('Unexpected event after Grok end')
    if (e.sessionId !== undefined) this.id(e.sessionId)
    if (e.type === 'thought') return
    if (e.type === 'text') {
      if (typeof e.data !== 'string') throw new Error('Invalid Grok text')
      this.response += e.data
      this.emit({ kind: 'assistant', text: e.data })
      return
    }
    if (e.type === 'tool_call' || e.type === 'tool_call_update') {
      if (typeof e.toolCallId !== 'string' || !e.toolCallId) throw new Error('Missing Grok tool identity')
      let tool = this.tools.get(e.toolCallId)
      if (e.type === 'tool_call') {
        if (tool) throw new Error('Duplicate Grok tool identity')
        tool = { step: this.tools.size + 1, name: String(e.toolName ?? e.title ?? '工具'), done: false }
        this.tools.set(e.toolCallId, tool)
      }
      if (!tool || tool.done) throw new Error('Unmatched Grok tool update')
      if (['failed', 'error', 'denied', 'cancelled'].includes(String(e.status))) {
        this.failure = `Grok 工具失败或被拒绝：${tool.name}`
        tool.done = true
      } else if (e.status === 'completed') tool.done = true
      else if (e.status !== undefined && !['pending', 'in_progress'].includes(String(e.status)))
        this.failure = `Grok 未识别的工具状态：${String(e.status)}`
      this.emit({
        kind: 'tool',
        text: tool.name,
        step: tool.step,
        state: String(e.status ?? 'running'),
        detail: JSON.stringify(e.type === 'tool_call' ? e.rawInput : (e.rawOutput ?? e.content)),
      })
      return
    }
    if (e.type === 'end') {
      if (!this.conversationId) throw new Error('Missing Grok end session identity')
      this.terminal = true
      if (e.stopReason !== 'end_turn') this.failure ??= `Grok 未正常完成：${String(e.stopReason)}`
      return
    }
    if (e.type === 'error' || e.type === 'max_turns_reached') {
      this.failure = typeof e.message === 'string' ? e.message : `Grok ${e.type}`
      this.emit({ kind: 'diagnostic', text: this.failure, state: 'error' })
      return
    }
    if (e.type === 'usage') return
    if (e.type === 'plan') {
      this.emit({ kind: 'status', text: 'Grok 更新计划', detail: JSON.stringify(e.entries) })
      return
    }
    if (e.type === 'available_commands') return
    this.emit({ kind: 'diagnostic', text: `未识别 Grok 事件：${e.type}`, detail: line })
  }
}
