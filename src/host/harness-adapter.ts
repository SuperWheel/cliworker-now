import { chmod, lstat, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { EFFORTS, type Effort, type ModelChoice, type TaskMode } from '../shared/types.ts'
import type { EventInput, ProtocolResult } from './protocol.ts'

export interface HarnessInput {
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
const provider = 'zai-coding-cn'
function selection(id: string): [string, string] {
  const value: unknown = JSON.parse(id)
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value[0] !== provider ||
    typeof value[1] !== 'string' ||
    !value[1].trim()
  )
    throw new Error('Harness 首版仅支持已授权的 zai-coding-cn 原生模型目录')
  return [value[0], value[1]]
}
function bridgePath() {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const path of [join(here, 'harness-catalog.mjs'), resolve(here, '../../harness-catalog.mjs')])
    if (existsSync(path)) return path
  throw new Error('Harness catalog bridge 未安装，请重新构建插件')
}
async function state(stateDirectory: string, project?: string) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  if ((await lstat(stateDirectory)).isSymbolicLink()) throw new Error('Unsafe Harness state symlink')
  await chmod(stateDirectory, 0o700)
  const parent = join(await realpath(stateDirectory), 'harness')
  const identity = project
    ? createHash('sha256')
        .update(await realpath(project))
        .digest('hex')
    : 'catalog'
  const root = join(parent, identity)
  for (const path of [parent, root, join(root, 'home'), join(root, 'tmp')]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Unsafe Harness state symlink')
    await chmod(path, 0o700)
  }
  return {
    root,
    env: {
      DSH_HOME: join(root, 'home'),
      TMPDIR: join(root, 'tmp'),
      DSH_TELEMETRY_DISABLED: 'true',
      DSH_PRIMARY_RUNTIME: '',
    },
  }
}
async function patch(root: string, model?: string, effort?: Effort) {
  const config: unknown[] = [
    { id: 'llm-pi-ai', config: { providers: { [provider]: { apiKeyEnv: 'ZAI_CODING_CN_API_KEY' } } } },
    { id: 'session-title-llm', disabled: true },
  ]
  if (model) {
    const [provider, selected] = selection(model)
    config.push({
      id: 'agent-default-model',
      config: {
        provider,
        model: selected,
        ...(effort === 'default' ? {} : { reasoningEffort: effort === 'none' ? 'off' : effort }),
      },
    })
  }
  const request = await mkdtemp(join(root, 'request-'))
  const path = join(request, 'overlay.yml')
  await writeFile(path, JSON.stringify(config) + '\n', { mode: 0o600 })
  return path
}
/** Host must use Harness's native sandbox (no nested Seatbelt) and supply the credential env. */
export async function prepareHarness(
  input: HarnessInput,
): Promise<{ argv: string[]; env: Record<string, string> }> {
  selection(input.preference.model)
  if (!EFFORTS.includes(input.preference.effort)) throw new Error('Invalid Harness effort')
  if (!['plan', 'accept-edits'].includes(input.mode)) throw new Error('Invalid Harness mode')
  if (!input.prompt.trim()) throw new Error('Prompt must not be empty')
  const prepared = await state(input.stateDirectory, input.project)
  const overlay = await patch(prepared.root, input.preference.model, input.preference.effort)
  return {
    argv: [
      input.executable,
      '--profile',
      'headless',
      '--patch',
      overlay,
      '--json',
      ...(input.conversationId ? ['--session-id', input.conversationId] : []),
      `任务：\n${input.prompt}`,
    ],
    env: { ...prepared.env, DSH_PERMISSION_MODE: input.mode === 'plan' ? 'read-only' : 'workspace-write' },
  }
}
export async function discoverHarness(
  executable: string,
  capture: (argv: string[], env?: Record<string, string>) => Promise<string>,
  stateDirectory: string,
): Promise<ModelChoice[]> {
  const prepared = await state(stateDirectory)
  const overlay = await patch(prepared.root)
  const raw: unknown = JSON.parse(
    await capture([process.execPath, bridgePath(), executable, overlay, prepared.root], {
      ...prepared.env,
      DSH_PERMISSION_MODE: 'read-only',
    }),
  )
  if (!Array.isArray(raw)) throw new Error('Invalid Harness catalog')
  const models = raw.map((x): ModelChoice => {
    if (!record(x) || typeof x.id !== 'string' || typeof x.label !== 'string' || !Array.isArray(x.efforts))
      throw new Error('Invalid Harness model')
    selection(x.id)
    const efforts = x.efforts.filter(
      (v): v is Effort => typeof v === 'string' && EFFORTS.includes(v as Effort),
    )
    if (!efforts.length || efforts.length !== x.efforts.length)
      throw new Error('Unsupported Harness model efforts')
    return { id: x.id, label: x.label, efforts }
  })
  if (!models.length || new Set(models.map((x) => x.id)).size !== models.length)
    throw new Error('Harness 模型目录为空或重复')
  return models
}

/** Native headless NDJSON; fixtures are synthetic, live evidence is in doc/harness-probe.md. */
export class HarnessProtocol {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private response = ''
  private final?: string
  private completed = false
  private turnEnded = false
  private failure?: string
  private tools = new Map<string, { step: number; name: string; done: boolean }>()
  private ended = false
  result?: ProtocolResult
  conversationId?: string
  constructor(
    private emit: (event: EventInput) => void,
    private identify: (id: string) => void,
    private maxLineBytes: number,
  ) {}
  feed(chunk: Buffer | string) {
    if (this.ended) throw new Error('Harness stream already ended')
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
      (!this.completed
        ? 'Harness 未报告完成终态'
        : this.final === undefined
          ? 'Harness 缺少 final 事件'
          : [...this.tools.values()].some((x) => !x.done)
            ? 'Harness 工具没有完成结果'
            : undefined)
    this.result = {
      conversationId: this.conversationId,
      status: error ? 'ERROR' : 'SUCCESS',
      response: this.final ?? this.response,
      ...(error ? { error } : {}),
    }
    this.emit({
      kind: 'result',
      text: this.result.response,
      state: this.result.status,
      ...(error ? { detail: error } : {}),
    })
  }
  private id(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid Harness session identity')
    if (this.conversationId && this.conversationId !== value)
      throw new Error('Harness session identity changed')
    if (!this.conversationId) this.identify(value)
    this.conversationId = value
  }
  private line(line: string) {
    if (Buffer.byteLength(line) > this.maxLineBytes) throw new Error('CLI event exceeds maxLineBytes')
    const e: unknown = JSON.parse(line)
    if (!record(e) || typeof e.type !== 'string') throw new Error('Invalid Harness event')
    if (this.final !== undefined) throw new Error('Unexpected event after Harness final')
    if (e.type === 'session') {
      this.id(e.sessionId)
      this.emit({ kind: 'status', text: 'Harness 已连接' })
      return
    }
    if (e.type === 'thinking') return
    if (e.type === 'text') {
      if (typeof e.text !== 'string') throw new Error('Invalid Harness text')
      this.response += e.text
      this.emit({ kind: 'assistant', text: e.text })
      return
    }
    if (e.type === 'status') {
      if (e.phase === 'turn_end') {
        if (this.turnEnded) throw new Error('Duplicate Harness turn end')
        this.turnEnded = true
        this.completed = record(e.reason) && e.reason.kind === 'completed'
        if (!this.completed) this.failure = 'Harness 任务未完成：' + JSON.stringify(e.reason)
      }
      this.emit({
        kind: 'status',
        text: String(e.phase ?? 'status'),
        state: String(e.phase ?? 'status'),
        ...(typeof e.step === 'number' ? { step: e.step } : {}),
      })
      return
    }
    if (e.type === 'tool_call') {
      if (typeof e.callId !== 'string' || !e.callId || typeof e.tool !== 'string' || this.tools.has(e.callId))
        throw new Error('Invalid Harness tool identity')
      const tool = { step: this.tools.size + 1, name: e.tool, done: false }
      this.tools.set(e.callId, tool)
      this.emit({
        kind: 'tool',
        text: tool.name,
        step: tool.step,
        state: 'running',
        detail: JSON.stringify(e.input),
      })
      return
    }
    if (e.type === 'tool_result') {
      const tool = typeof e.callId === 'string' ? this.tools.get(e.callId) : undefined
      if (!tool || tool.done) throw new Error('Unmatched Harness tool result')
      tool.done = true
      if (e.status !== 'completed') this.failure = `Harness 工具失败或被拒绝：${tool.name}`
      this.emit({
        kind: 'tool',
        text: tool.name,
        step: tool.step,
        state: e.status === 'completed' ? 'completed' : 'error',
        detail: typeof e.result === 'string' ? e.result : JSON.stringify(e.result),
      })
      return
    }
    if (e.type === 'error') {
      this.failure = typeof e.message === 'string' ? e.message : 'Harness error'
      this.emit({ kind: 'diagnostic', text: this.failure, state: 'error' })
      return
    }
    if (e.type === 'final') {
      if (typeof e.text !== 'string') throw new Error('Invalid Harness final')
      this.final = e.text
      if (!this.response && e.text) this.emit({ kind: 'assistant', text: e.text })
      return
    }
    this.emit({ kind: 'diagnostic', text: `未识别 Harness 事件：${e.type}`, detail: line })
  }
}
