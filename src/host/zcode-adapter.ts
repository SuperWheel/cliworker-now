import {
  mkdirSync,
  chmodSync,
  writeFileSync,
  existsSync,
  readFileSync,
  statSync,
  lstatSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { EFFORTS, type Effort, type ModelChoice, type TaskMode } from '../shared/types.ts'
import type { EventInput, ProtocolResult } from './protocol.ts'

// Native ZCode uses exact tool-name sets, not globs. Deny its own delegation
// surface and bundled browser REPL. This is not a general MCP isolation policy;
// arbitrary MCP tool names cannot be safely represented by "mcp__*" here.
export const ZCODE_DENIED_TOOLS = [
  'Agent',
  'Task',
  'Skill',
  'TaskOutput',
  'TaskStop',
  'SendMessage',
  'ReadSessionContext',
  'CreateWorkflow',
  'AmendWorkflow',
  'SaveWorkflow',
  'EvalWorkflowSnippet',
  'ListWorkflowRuns',
  'GetWorkflowRun',
  'ResumeWorkflowRun',
  'ResolveWorkflowQuestion',
  'ListSavedWorkflows',
  'ListModels',
  'mcp__node_repl__js',
] as const

export interface ZCodeInput {
  executable: string
  project: string
  preference: { model: string; effort: Effort }
  mode: TaskMode
  prompt: string
  conversationId?: string
  stateDirectory: string
  authDirectory?: string
  builtinConfig?: string
}
const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim()

function builtinPath(executable: string, builtin?: string): string {
  const adjacent = join(dirname(executable), 'provider/zcode-builtin.json')
  const config =
    builtin ??
    (existsSync(adjacent)
      ? adjacent
      : '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json')
  if (!existsSync(config)) throw new Error('请配置与 ZCode CLI 配套的 zcodeBuiltinConfig')
  return config
}
export function zcodeEnvironment(executable: string, state: string, auth?: string, builtin?: string) {
  for (const dir of [state, join(state, 'storage'), join(state, 'logs'), join(state, 'tmp')]) {
    // CLI tools can write their own state; do not follow a planted link on the next run.
    let info
    try {
      info = lstatSync(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      info = lstatSync(dir)
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('ZCode state directory must not be a symlink')
    chmodSync(dir, 0o700)
  }
  return {
    ZCODE_DATA_BASE_DIR: auth ?? state,
    ZCODE_STORAGE_DIR: join(state, 'storage'),
    ZCODE_SESSION_DB_PATH: join(state, 'storage/session.sqlite'),
    ZCODE_LOG_DIR: join(state, 'logs'),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(state, 'personal.json'),
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath(executable, builtin),
    TMPDIR: join(state, 'tmp'),
  }
}
function writePersonalConfig(path: string, value: unknown): void {
  const temporary = join(dirname(path), `.personal-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    // rename replaces an existing symlink itself; never chmod/write its target.
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}
export async function prepareZCode(input: ZCodeInput) {
  const parts = input.preference.model.split('/')
  if (parts.length !== 2 || !parts.every(nonempty)) throw new Error('ZCode 需要原生 provider/model 选型')
  const env = zcodeEnvironment(
    input.executable,
    input.stateDirectory,
    input.authDirectory,
    input.builtinConfig,
  )
  writePersonalConfig(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      defaultModelSelection: {
        providerId: parts[0],
        modelId: parts[1],
        ...(input.preference.effort !== 'default'
          ? { options: { reasoningLevel: input.preference.effort } }
          : {}),
      },
    },
  })
  const argv = [
    ...(/\.[cm]?js$/.test(input.executable) ? [process.execPath, input.executable] : [input.executable]),
    '--cwd',
    input.project,
    '--mode',
    input.mode === 'plan' ? 'plan' : 'edit',
    '--output-format',
    'stream-json',
    '--disallowedTools',
    ZCODE_DENIED_TOOLS.join(','),
    ...(input.conversationId ? ['--resume', input.conversationId] : []),
    '--prompt',
    `任务：\n${input.prompt}`,
  ]
  return { argv, env }
}

/** A deliberately limited installed catalog, not an account-entitlement check.
 * app-server does not load standalone account credentials; do not create an empty
 * session or submit a slash-command prompt to try to enumerate account models.
 * Only the route whose headless protocol was accepted is exposed in this release.
 */
export function parseZCodeBuiltin(value: unknown): ModelChoice[] {
  const providerId = 'account:bigmodel-individual-coding-plan'
  const modelId = 'GLM-5.3-Flash'
  if (!record(value) || value.schemaVersion !== 1 || !record(value.config))
    throw new Error('Unsupported ZCode builtin catalog schema')
  const providers = value.config.providerConfigRules?.providerRules
  const rules = value.config.modelConfigRules
  if (!Array.isArray(providers) || !record(rules)) throw new Error('Invalid ZCode builtin catalog')
  const matches = providers.filter((p) => record(p) && p.providerId === providerId)
  if (matches.length !== 1) throw new Error('ZCode builtin catalog lacks the accepted BigModel route')
  const provider = matches[0]
  const config = provider.config
  if (
    provider.enabled === false ||
    provider.templateId ||
    !record(config) ||
    config.visibility === 'hidden' ||
    !Array.isArray(config.builtinModelIds) ||
    !config.builtinModelIds.includes(modelId) ||
    !record(config.api) ||
    !nonempty(config.api.type) ||
    !nonempty(config.api.baseUrl)
  )
    throw new Error('ZCode builtin catalog does not enable the accepted GLM model')
  // Mirror native ModelConfigRules: anchored regex, model IDs insensitive to case;
  // model -> model-api -> provider-site -> template -> exact provider/model order.
  const match = (pattern: unknown, text: string, ignoreCase = false) => {
    if (!nonempty(pattern) || pattern.length > 4096) throw new Error('Invalid ZCode model rule')
    return new RegExp(`^(?:${pattern})$`, ignoreCase ? 'i' : undefined).test(text)
  }
  const endpoint = new URL(config.api.baseUrl)
  const suffix = `${endpoint.search}${endpoint.hash}`
  const serialized = endpoint.toString()
  const baseUrl = `${(suffix ? serialized.slice(0, -suffix.length) : serialized).replace(/\/+$/, '')}${suffix}`
  let enabled = false
  let values: unknown
  for (const key of [
    'modelRules',
    'modelApiRules',
    'providerSiteRules',
    'templateModelRules',
    'builtinProviderModelRules',
  ]) {
    if (!Array.isArray(rules[key])) throw new Error('Incomplete ZCode builtin rule groups')
    for (const rule of rules[key]) {
      if (!record(rule) || !record(rule.config)) throw new Error('Invalid ZCode builtin rule')
      if (key === 'templateModelRules') continue // Accepted account route has no template.
      if (key === 'builtinProviderModelRules') {
        if (rule.providerId !== providerId || rule.modelId !== modelId) continue
      } else {
        if (!match(rule.modelMatch, modelId, true)) continue
        if (
          (key === 'modelApiRules' || key === 'providerSiteRules') &&
          rule.apiTypeMatch !== undefined &&
          !match(rule.apiTypeMatch, config.api.type)
        )
          continue
        if (key === 'providerSiteRules' && !match(rule.baseUrlMatch, baseUrl)) continue
      }
      const overlay = rule.config
      if (overlay.enabled !== undefined) {
        if (typeof overlay.enabled !== 'boolean') throw new Error('Invalid ZCode model enabled rule')
        enabled = overlay.enabled
      }
      if (overlay.optionSpecs === null || overlay.optionSpecs?.reasoningLevel === null) values = undefined
      else if (record(overlay.optionSpecs?.reasoningLevel) && 'values' in overlay.optionSpecs.reasoningLevel)
        values = overlay.optionSpecs.reasoningLevel.values
    }
  }
  if (!enabled || !Array.isArray(values) || !values.length || !values.every(nonempty))
    throw new Error('ZCode builtin catalog has no supported model reasoning choices')
  const efforts = [...new Set(values.filter((value): value is Effort => EFFORTS.includes(value as Effort)))]
  if (!efforts.length) throw new Error('ZCode model reasoning choices are not supported by this plugin')
  return [{ id: `${providerId}/${modelId}`, label: `${modelId}（本机配套目录）`, efforts }]
}
export async function discoverZCode(
  executable: string,
  _capture: (argv: string[], env?: Record<string, string>) => Promise<string>,
  _stateDirectory: string,
  _authDirectory?: string,
  builtinConfig?: string,
): Promise<ModelChoice[]> {
  const path = builtinPath(executable, builtinConfig)
  if (statSync(path).size > 2 * 1024 * 1024) throw new Error('ZCode builtin catalog is too large')
  return parseZCodeBuiltin(JSON.parse(readFileSync(path, 'utf8')))
}

export class ZCodeProtocol {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private steps = new Map<string, number>()
  private open = new Set<string>()
  private toolNames = new Map<string, string>()
  private failed = false
  private completed = false
  private ended = false
  conversationId?: string
  result?: ProtocolResult
  constructor(
    private emit: (event: EventInput) => void,
    private identify: (id: string) => void,
    private maxLineBytes: number,
  ) {}
  feed(chunk: Buffer | string) {
    if (this.ended) throw new Error('ZCode stream already ended')
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let n: number
    while ((n = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, n).trim()
      this.pending = this.pending.slice(n + 1)
      if (line) this.line(line)
    }
    if (Buffer.byteLength(this.pending) > this.maxLineBytes) throw new Error('ZCode event too large')
  }
  end() {
    if (this.ended) return
    this.ended = true
    this.pending += this.decoder.end()
    if (this.pending.trim()) this.line(this.pending.trim())
    this.pending = ''
  }
  private step(id: string) {
    if (!this.steps.has(id)) this.steps.set(id, this.steps.size)
    return this.steps.get(id)!
  }
  private line(line: string) {
    if (Buffer.byteLength(line) > this.maxLineBytes) throw new Error('ZCode event too large')
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error('Invalid ZCode stream-json event')
    }
    if (!record(value) || !nonempty(value.type) || this.result) throw new Error('Unexpected ZCode event')
    const v = value
    const p = record(v.payload) ? v.payload : {}
    if (nonempty(v.sessionId)) {
      if (this.conversationId && this.conversationId !== v.sessionId) throw new Error('ZCode session changed')
      if (!this.conversationId) {
        this.conversationId = v.sessionId
        this.identify(v.sessionId)
      }
    }
    if (v.type === 'model.streaming' && p.kind === 'text_delta') {
      if (!nonempty(p.assistantMessageId) || typeof p.delta !== 'string')
        throw new Error('Invalid ZCode text delta')
      this.emit({ kind: 'assistant', step: this.step(p.assistantMessageId), text: p.delta })
    } else if (v.type === 'session.updated' && nonempty(p.providerId) && nonempty(p.modelId)) {
      this.emit({ kind: 'status', text: 'ZCode 模型已确认', observedModel: `${p.providerId}/${p.modelId}` })
    } else if (v.type === 'tool.updated') {
      if (p.kind === 'batch') {
        // Native permission rejection may only emit scheduled + batch(errorCount),
        // with no started/result event. Never let turn.completed erase that fact.
        if (!Number.isSafeInteger(p.errorCount) || p.errorCount < 0)
          throw new Error('Invalid ZCode tool batch')
        if (p.errorCount > 0) this.failed = true
      } else if (['scheduled', 'started', 'result'].includes(p.kind)) {
        if (!nonempty(p.toolCallId)) throw new Error('Invalid ZCode tool identity')
        const done = p.kind === 'result'
        if (done) {
          this.open.delete(p.toolCallId)
          if (p.result?.success !== true) this.failed = true
        } else this.open.add(p.toolCallId)
        if (nonempty(p.toolName)) this.toolNames.set(p.toolCallId, p.toolName)
        this.emit({
          kind: 'tool',
          step: this.step(p.toolCallId),
          text: this.toolNames.get(p.toolCallId) ?? '工具',
          state: done ? (p.result?.success === true ? 'COMPLETED' : 'FAILED') : 'RUNNING',
          detail: JSON.stringify(p.result ?? p),
        })
      }
    } else if (
      v.type === 'permission.resolved' &&
      (p.decision === 'deny' || p.decision?.behavior === 'deny' || p.resolution === 'deny')
    ) {
      this.failed = true
      this.emit({ kind: 'diagnostic', text: 'ZCode 权限请求被拒绝' })
    } else if (v.type === 'turn.failed' || v.type === 'error') {
      this.failed = true
      this.emit({ kind: 'diagnostic', text: 'ZCode 执行失败', detail: JSON.stringify(p) })
    } else if (v.type === 'turn.completed') {
      this.completed = p.resultType === 'success'
      if (!this.completed) this.failed = true
    } else if (v.type === 'result') {
      if (!this.conversationId || !nonempty(v.sessionId) || typeof v.response !== 'string')
        throw new Error('ZCode result missing session/text')
      const status = this.completed && !this.failed && !this.open.size ? 'SUCCESS' : 'ERROR'
      this.result = {
        conversationId: this.conversationId,
        status,
        response: v.response,
        ...(status === 'ERROR' ? { error: 'ZCode 未成功完成，存在失败工具、权限拒绝或缺失终态' } : {}),
      }
      this.emit({ kind: 'result', text: v.response, state: status })
    }
  }
}
