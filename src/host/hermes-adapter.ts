import { chmod, lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { EFFORTS, type Effort, type ModelChoice, type TaskMode } from '../shared/types.ts'
import type { EventInput, ProtocolResult } from './protocol.ts'
import type { TokenUsage } from '../shared/telemetry.ts'
import { hermesAccountModels } from './hermes-models.ts'
import { verifyHermesExecutable } from './hermes-installation.ts'

export interface HermesInput {
  executable: string
  project: string
  preference: { model: string; effort: Effort }
  mode: TaskMode
  prompt: string
  conversationId?: string
  stateDirectory: string
  hermesHome?: string
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim() && !value.includes('\0')

export function hermesHomeDirectory(configured?: string): string {
  const path = configured?.trim() || process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes')
  return validateHermesHomeDirectory(path)
}

function assertConfinedHome(path: string) {
  const userHome = realpathSync(homedir())
  if (path === parse(path).root || path === userHome || userHome.startsWith(path + sep))
    throw new Error('Unsafe Hermes home: refusing filesystem root, user home or its ancestor')
}

/** Account setup may create a new home. Resolve its nearest existing ancestor before
 * granting writes, so a parent symlink cannot turn a narrow-looking path into all of HOME.
 * Returns a canonical path for the sandbox and native HERMES_HOME to share.
 */
export function validateHermesHomeDirectory(path: string): string {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Hermes home must be an absolute path')
  const absolute = resolve(path)
  assertConfinedHome(absolute)
  try {
    if (lstatSync(absolute).isSymbolicLink()) throw new Error('Unsafe Hermes home symlink')
  } catch (error) {
    if (!record(error) || error.code !== 'ENOENT') throw error
  }
  let ancestor = absolute
  const missing: string[] = []
  for (;;) {
    try {
      const canonical = join(realpathSync(ancestor), ...missing)
      assertConfinedHome(canonical)
      return canonical
    } catch (error) {
      if (!record(error) || error.code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

function selection(value: string): [string, string] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('请重新选择 Hermes 原生模型')
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || !parsed.every(nonempty))
    throw new Error('请重新选择 Hermes 原生模型')
  return [parsed[0], parsed[1]]
}

async function environment(stateDirectory: string, home: string) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  if ((await lstat(stateDirectory)).isSymbolicLink()) throw new Error('Unsafe Hermes state symlink')
  await chmod(stateDirectory, 0o700)
  const root = join(await realpath(stateDirectory), 'hermes')
  for (const path of [root, join(root, 'tmp')]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Unsafe Hermes state symlink')
    await chmod(path, 0o700)
  }
  // Preserve native provider/account configuration. No credentials are copied or injected.
  // SAFE_MODE is the plugin-discovery guard; the CLI --safe-mode switch would ALSO discard
  // user provider config, so it is deliberately not used. Host supplies the OS sandbox.
  return {
    HERMES_HOME: home,
    PYTHONDONTWRITEBYTECODE: '1',
    TMPDIR: join(root, 'tmp'),
    HERMES_SAFE_MODE: '1',
    HERMES_IGNORE_RULES: '1',
    HERMES_YOLO_MODE: '0',
    HERMES_ACCEPT_HOOKS: '0',
  }
}

async function requireConfiguration(home: string) {
  try {
    // Recheck canonical identities at use time, including symlinks in parent components.
    // A changed alias must not expand the writable native-state exception.
    const canonical = await realpath(home)
    if (validateHermesHomeDirectory(home) !== canonical || canonical !== home)
      throw new Error('Unsafe Hermes configuration path changed')
    const directory = await lstat(home)
    const config = await lstat(join(home, 'config.yaml'))
    if (!directory.isDirectory() || directory.isSymbolicLink() || !config.isFile() || config.isSymbolicLink())
      throw new Error('Unsafe Hermes configuration path')
    if ((await realpath(join(home, 'config.yaml'))) !== join(canonical, 'config.yaml'))
      throw new Error('Unsafe Hermes configuration realpath')
  } catch (error) {
    if (record(error) && error.code === 'ENOENT') throw new Error('请先在 Hermes 登录设置中选择服务商和模型')
    throw error
  }
}

/** Only explicit native cached capabilities for the selected provider are offered.
 * Other providers, unknown/stale capabilities and ambiguous endpoints keep native defaults.
 * Source: NousResearch/hermes-agent@4787e4d, hermes_cli/models_reasoning_caps.py.
 */
async function reasoningEfforts(home: string, provider: string, model: string): Promise<Effort[]> {
  const fallback: Effort[] = ['default']
  if (provider !== 'openrouter') return fallback
  try {
    const cacheDirectory = join(home, 'cache')
    const path = join(cacheDirectory, 'reasoning_caps.json')
    if ((await lstat(cacheDirectory)).isSymbolicLink()) return fallback
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) return fallback
    const cache: unknown = JSON.parse(await readFile(path, 'utf8'))
    const entry = record(cache) ? cache['https://openrouter.ai/api/v1/models'] : undefined
    if (
      !record(entry) ||
      typeof entry.ts !== 'number' ||
      !Number.isFinite(entry.ts) ||
      Date.now() / 1000 - entry.ts > 24 * 60 * 60 ||
      entry.ts > Date.now() / 1000 + 60 ||
      !record(entry.caps)
    )
      return fallback
    const capabilities = entry.caps[model]
    if (
      !record(capabilities) ||
      capabilities.supports_reasoning !== true ||
      !Array.isArray(capabilities.supported_efforts)
    )
      return fallback
    const efforts = capabilities.supported_efforts.filter(
      (value): value is Effort =>
        typeof value === 'string' && value !== 'default' && EFFORTS.includes(value as Effort),
    )
    return [...new Set([...fallback, ...efforts])]
  } catch {
    return fallback
  }
}

/** Read-only native scalar queries; never prints a config object containing API keys. */
export async function discoverHermes(
  executable: string,
  capture: (argv: string[], env?: Record<string, string>) => Promise<string>,
  stateDirectory: string,
  hermesHome?: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<ModelChoice[]> {
  options.signal?.throwIfAborted()
  await verifyHermesExecutable(executable, options.signal ?? AbortSignal.timeout(15000))
  const home = hermesHomeDirectory(hermesHome)
  await requireConfiguration(home)
  options.signal?.throwIfAborted()
  const env = await environment(stateDirectory, home)
  const get = async (key: string): Promise<unknown> => {
    options.signal?.throwIfAborted()
    const result = await capture([executable, 'config', 'get', key, '--json'], env)
    options.signal?.throwIfAborted()
    return JSON.parse(result)
  }
  // Native launchers take a per-home install lock and may initialize a new profile's
  // runtime. Parallel scalar queries can race that first initialization.
  const model = await get('model.default')
  const provider = await get('model.provider')
  if (!nonempty(model) || !nonempty(provider) || provider === 'auto')
    throw new Error('请在 Hermes 登录设置中明确选择服务商和模型，然后刷新')
  const scope = await hermesAccountModels(home, provider, options)
  options.signal?.throwIfAborted()
  if (scope.state !== 'supported') return []
  const models = await Promise.all(
    scope.models.map(async (candidate) => ({
      id: JSON.stringify([provider, candidate.id]),
      label: candidate.name ?? candidate.id,
      efforts: await reasoningEfforts(home, provider, candidate.id),
      cost: candidate.cost,
    })),
  )
  options.signal?.throwIfAborted()
  return models
}

/** Official stream-json CLI; not a claim of local installation or live execution. */
export async function prepareHermes(
  input: HermesInput,
): Promise<{ argv: string[]; env: Record<string, string> }> {
  await verifyHermesExecutable(input.executable, AbortSignal.timeout(15000))
  const [provider, model] = selection(input.preference.model)
  if (!['plan', 'accept-edits'].includes(input.mode)) throw new Error('Invalid Hermes mode')
  if (!nonempty(input.prompt)) throw new Error('Prompt must not be empty')
  if (input.conversationId !== undefined && !nonempty(input.conversationId))
    throw new Error('Invalid Hermes session identity')
  const home = hermesHomeDirectory(input.hermesHome)
  await requireConfiguration(home)
  const efforts = await reasoningEfforts(home, provider, model)
  if (!efforts.includes(input.preference.effort))
    throw new Error('Hermes 未确认支持此思考强度，请刷新模型后重选')
  return {
    argv: [
      input.executable,
      '--in',
      input.project,
      'chat',
      '--format',
      'stream-json',
      '--model',
      model,
      '--provider',
      provider,
      '--toolsets',
      'terminal,file',
      '--ignore-rules',
      ...(input.preference.effort === 'default' ? [] : ['--reasoning', input.preference.effort]),
      ...(input.conversationId ? ['--resume', input.conversationId] : []),
      '-q',
      input.prompt,
    ],
    env: await environment(input.stateDirectory, home),
  }
}

export type HermesRecord =
  | { type: 'system'; subtype: 'init'; session_id: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input?: Record<string, unknown>; tool_call_id?: string }
  | {
      type: 'tool_result'
      name: string
      output: string
      is_error: boolean
      duration_ms: number
      tool_call_id?: string
    }
  | {
      type: 'result'
      session_id: string
      exit_code: number
      text: string
      error?: string
      tokens?: Record<string, number>
      duration_ms?: number
    }

/** Map only counters actually reported by the native final envelope. These are run totals,
 * not a model context-window occupancy estimate and not per-message counters.
 */
export function hermesTokenUsage(tokens: unknown): TokenUsage | undefined {
  if (!record(tokens)) return undefined
  const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
  const total = count(tokens.total)
  if (total === undefined) return undefined
  return {
    total,
    input: count(tokens.input),
    output: count(tokens.output),
    cacheRead: count(tokens.cache_read),
    scope: 'run',
  }
}

/** Native record validation; the source protocol has no public reasoning event. */
export function parseHermesRecord(value: unknown): HermesRecord {
  if (!record(value)) throw new Error('Invalid Hermes event')
  const finite = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0
  switch (value.type) {
    case 'system':
      if (value.subtype === 'init' && nonempty(value.session_id) && nonempty(value.model))
        return value as HermesRecord
      break
    case 'text':
      if (typeof value.text === 'string') return value as HermesRecord
      break
    case 'tool_use':
    case 'tool_result':
      if (!nonempty(value.name) || (value.tool_call_id !== undefined && !nonempty(value.tool_call_id))) break
      if (value.type === 'tool_use' && (value.input === undefined || record(value.input)))
        return value as HermesRecord
      if (
        value.type === 'tool_result' &&
        typeof value.output === 'string' &&
        typeof value.is_error === 'boolean' &&
        finite(value.duration_ms)
      )
        return value as HermesRecord
      break
    case 'result':
      if (
        nonempty(value.session_id) &&
        typeof value.text === 'string' &&
        Number.isInteger(value.exit_code) &&
        (value.error === undefined || typeof value.error === 'string') &&
        (value.duration_ms === undefined || finite(value.duration_ms)) &&
        (value.tokens === undefined || (record(value.tokens) && Object.values(value.tokens).every(finite)))
      )
        return value as HermesRecord
      break
  }
  throw new Error('Invalid Hermes event')
}

export class HermesProtocol {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private response = ''
  private assistantStep = 0
  private assistantSegmentOpen = false
  private final?: string
  private terminal = false
  private ended = false
  private failure?: string
  private tools = new Map<string, { step: number; name: string; done: boolean }>()
  result?: ProtocolResult
  conversationId?: string
  constructor(
    private emit: (event: EventInput) => void,
    private identify: (id: string) => void,
    private maxLineBytes: number,
  ) {}
  feed(chunk: Buffer | string) {
    if (this.ended) throw new Error('Hermes stream already ended')
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
    // The native final envelope is authoritative. Tool-progress callbacks are advisory:
    // a model can recover from a failed tool, and a final envelope may follow an unfinished
    // callback. Preserve the observed tool row instead of rewriting the run's outcome.
    const error = this.failure ?? (!this.terminal ? 'Hermes 缺少 result 终态' : undefined)
    this.result = {
      conversationId: this.conversationId,
      status: error ? 'ERROR' : 'SUCCESS',
      response: this.final ?? this.response,
      ...(error ? { error } : {}),
    }
    this.emit({
      kind: 'result',
      step: this.assistantStep || undefined,
      text: this.result.response,
      state: this.result.status,
      ...(error ? { detail: error } : {}),
    })
  }
  private assistant(text: string) {
    if (!this.assistantSegmentOpen) {
      this.assistantStep += 1
      this.assistantSegmentOpen = true
    }
    this.emit({ kind: 'assistant', step: this.assistantStep, text })
  }
  private id(id: string) {
    if (this.conversationId && this.conversationId !== id) throw new Error('Hermes session identity changed')
    if (!this.conversationId) this.identify(id)
    this.conversationId = id
  }
  private line(line: string) {
    if (Buffer.byteLength(line) > this.maxLineBytes) throw new Error('CLI event exceeds maxLineBytes')
    if (this.terminal) throw new Error('Unexpected event after Hermes result')
    const event = parseHermesRecord(JSON.parse(line))
    if (event.type === 'system') {
      if (this.conversationId) throw new Error('Duplicate Hermes init')
      this.id(event.session_id)
      this.emit({ kind: 'status', text: 'CLI 已连接', observedModel: event.model })
      return
    }
    if (!this.conversationId) throw new Error('Missing Hermes init session identity')
    if (event.type === 'text') {
      // Native on_text_delta emits increments (including whitespace), not snapshots.
      // One step identifies a continuous response segment for foldEvents to append.
      if (event.text) {
        this.response += event.text
        this.assistant(event.text)
      }
      return
    }
    if (event.type === 'result') {
      this.id(event.session_id)
      this.terminal = true
      this.final = event.text
      if (event.exit_code !== 0 || event.error)
        this.failure = event.error || `Hermes 运行失败（${event.exit_code}）`
      // A final envelope replaces the last streamed segment during folding. It must
      // not append a second full answer. A tool boundary with no subsequent deltas
      // still needs a new response row after the tool, including non-streaming models.
      if (event.text && !this.assistantSegmentOpen) this.assistant(event.text)
      return
    }
    this.assistantSegmentOpen = false
    let key = event.tool_call_id
    if (event.type === 'tool_use') {
      if (!key) {
        if ([...this.tools.values()].some((tool) => tool.name === event.name && !tool.done))
          throw new Error('Ambiguous Hermes tool identity')
        key = `anonymous:${this.tools.size}`
      }
      if (this.tools.has(key)) throw new Error('Duplicate Hermes tool identity')
      const tool = { step: this.tools.size + 1, name: event.name, done: false }
      this.tools.set(key, tool)
      this.emit({
        kind: 'tool',
        text: tool.name,
        step: tool.step,
        state: 'running',
        detail: JSON.stringify(event.input ?? {}),
      })
    } else {
      if (!key) {
        const matching = [...this.tools.entries()].filter(
          ([, tool]) => tool.name === event.name && !tool.done,
        )
        if (matching.length !== 1) throw new Error('Unmatched Hermes tool result')
        key = matching[0]![0]
      }
      const tool = this.tools.get(key)
      if (!tool || tool.done || tool.name !== event.name) throw new Error('Unmatched Hermes tool result')
      tool.done = true
      this.emit({
        kind: 'tool',
        text: tool.name,
        step: tool.step,
        state: event.is_error ? 'failed' : 'completed',
        detail: event.output,
      })
    }
  }
}
