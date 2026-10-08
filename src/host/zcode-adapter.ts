import {
  mkdirSync,
  chmodSync,
  writeFileSync,
  existsSync,
  readSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
  lstatSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, dirname, basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { EFFORTS, type Effort, type ModelChoice, type TaskMode } from '../shared/types.ts'
import type { EventInput, ProtocolResult } from './protocol.ts'
import type { AccountIdentity } from './account-identity.ts'
import { probeAccountModels } from './account-models.mjs'
import { readZCodeAccountApiKeys } from './zcode-account-models.ts'

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
  nativeHome?: string
  personalConfig?: string
}
const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim()

/** Login and every worker share auth; sessions, logs and model choices stay isolated. */
export function zcodeAuthDirectory(configured?: string, stateDirectory?: string): string {
  return (
    configured ??
    join(
      stateDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cliworker-now'),
      'accounts',
      'zcode',
    )
  )
}

/** A complete, version-controlled CLI can be deployed here without relying on /tmp. */
export function managedZCodeEntry(home = homedir()): string {
  return join(home, '.local/share/cliworker-now/runtimes/zcode/cli/zcode.cjs')
}

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
  // Harness deliberately scrubs parent SECRET variables. Native authentication,
  // metadata decryption and resumed/headless tasks must use the same cipher key.
  // Keep it exclusively in the selected ZCode child's environment.
  const credentialSecret = process.env.ZCODE_CREDENTIAL_SECRET?.trim()
  return {
    ...(credentialSecret ? { ZCODE_CREDENTIAL_SECRET: credentialSecret } : {}),
    ZCODE_DATA_BASE_DIR: auth ?? zcodeAuthDirectory(),
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
  const builtin = readZCodeConfig(builtinPath(input.executable, input.builtinConfig), false)
  const personal = readZCodePersonal(input.authDirectory, input)
  const selected = resolveZCodeModels(builtin, personal).find(
    (entry) => entry.choice.id === input.preference.model,
  )
  if (!selected) throw new Error('ZCode 所选模型不在原生可见目录中')
  if (input.preference.effort !== 'default' && !selected.choice.efforts?.includes(input.preference.effort))
    throw new Error('ZCode 所选强度不受原生模型支持')
  const reasoning =
    input.preference.effort === 'default'
      ? selected.nativeReasoningDefault
      : input.preference.effort === 'none'
        ? 'disabled'
        : input.preference.effort
  const selection = {
    providerId: selected.providerId,
    modelId: selected.modelId,
    ...(reasoning ? { options: { reasoningLevel: reasoning } } : {}),
  }
  const env = zcodeEnvironment(
    input.executable,
    input.stateDirectory,
    input.authDirectory,
    input.builtinConfig,
  )
  // Preserve private provider/model overlays. Only this worker's default selection changes.
  writePersonalConfig(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, {
    ...personal,
    config: {
      ...personal.config,
      defaultModelSelection: selection,
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
  if (input.conversationId) {
    const request = join(input.stateDirectory, `resume-${randomUUID()}.json`)
    writePersonalConfig(request, {
      executable: input.executable,
      argv,
      project: input.project,
      conversationId: input.conversationId,
      selection,
    })
    return {
      argv: [process.execPath, fileURLToPath(new URL('./zcode-resume.mjs', import.meta.url)), request],
      env,
    }
  }
  return { argv, env }
}

interface PersonalDocument {
  schemaVersion: 1
  config: {
    providerConfigRules: { providerRules: Record<string, any>[] }
    modelConfigRules: {
      providerModelRules: Record<string, any>[]
      manualProviderModelRules: Record<string, any>[]
    }
    providerOrder?: string[]
    defaultModelSelection?: unknown
  }
}
export interface ZCodeDiscoveryOptions {
  nativeHome?: string
  personalConfig?: string
  signal?: AbortSignal
  /** Isolated read-only account metadata transport for tests. */
  probeOptions?: Parameters<typeof probeAccountModels>[1]
  credentialSecret?: string
}
const BUILTIN_MODEL_GROUPS = [
  'modelRules',
  'modelApiRules',
  'providerSiteRules',
  'templateModelRules',
  'builtinProviderModelRules',
] as const
const exactKey = (rule: Record<string, any>) => JSON.stringify([rule.providerId, rule.modelId])
const nativeId = (value: unknown): value is string =>
  nonempty(value) && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value)
const emptyPersonal = (): PersonalDocument => ({
  schemaVersion: 1,
  config: {
    providerConfigRules: { providerRules: [] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  },
})
/** Native ConfigOverlay: undefined preserves, null clears, arrays replace. Access types cannot mix. */
function overlayConfig(base: Record<string, any>, next: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(next)])].map((key) => {
      const value = next[key]
      if (value === undefined) return [key, base[key]]
      if (record(base[key]) && record(value) && !(key === 'access' && base[key].type !== value.type))
        return [key, overlayConfig(base[key], value)]
      return [key, value]
    }),
  )
}
function providerRules(value: unknown, personal = false): Record<string, any>[] {
  if (!Array.isArray(value)) throw new Error('Invalid ZCode provider rules')
  const ids = new Set<string>()
  return value.map((rule) => {
    if (
      !record(rule) ||
      !nativeId(rule.providerId) ||
      !record(rule.config) ||
      ids.has(rule.providerId) ||
      (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') ||
      (rule.templateId != null && !nativeId(rule.templateId))
    )
      throw new Error('Invalid ZCode provider rule')
    if (
      personal &&
      ('builtinModelIds' in rule.config ||
        (rule.providerId.startsWith('account:') && 'access' in rule.config))
    )
      throw new Error('Invalid ZCode personal provider overlay')
    ids.add(rule.providerId)
    return rule
  })
}
function parsePersonal(value: unknown): PersonalDocument {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.config))
    throw new Error('Unsupported ZCode personal config schema')
  const config = value.config,
    models = config.modelConfigRules
  const providers = providerRules(config.providerConfigRules?.providerRules, true)
  if (
    !record(models) ||
    !Array.isArray(models.providerModelRules) ||
    !Array.isArray(models.manualProviderModelRules)
  )
    throw new Error('Invalid ZCode personal model rules')
  const exact = new Set<string>()
  for (const group of [models.providerModelRules, models.manualProviderModelRules])
    for (const rule of group) {
      if (
        !record(rule) ||
        !nativeId(rule.providerId) ||
        !nativeId(rule.modelId) ||
        !record(rule.config) ||
        exact.has(exactKey(rule))
      )
        throw new Error('Invalid or duplicate ZCode personal model rule')
      exact.add(exactKey(rule))
    }
  if (
    config.providerOrder !== undefined &&
    (!Array.isArray(config.providerOrder) || !config.providerOrder.every(nativeId))
  )
    throw new Error('Invalid ZCode personal provider order')
  return {
    schemaVersion: 1,
    config: {
      ...config,
      providerConfigRules: { providerRules: providers },
      modelConfigRules: {
        providerModelRules: models.providerModelRules,
        manualProviderModelRules: models.manualProviderModelRules,
      },
    },
  }
}
function mergePersonal(documents: PersonalDocument[]): PersonalDocument {
  const providers = new Map<string, Record<string, any>>()
  const exact = new Map<string, { manual: boolean; rule: Record<string, any> }>()
  let config: PersonalDocument['config'] = emptyPersonal().config
  for (const document of documents) {
    config = { ...config, ...document.config }
    for (const rule of document.config.providerConfigRules.providerRules) {
      const prior = providers.get(rule.providerId)
      providers.set(
        rule.providerId,
        prior ? { ...prior, ...rule, config: overlayConfig(prior.config, rule.config) } : rule,
      )
    }
    for (const [manual, rules] of [
      [false, document.config.modelConfigRules.providerModelRules],
      [true, document.config.modelConfigRules.manualProviderModelRules],
    ] as const)
      for (const rule of rules) exact.set(exactKey(rule), { manual, rule })
  }
  return {
    schemaVersion: 1,
    config: {
      ...config,
      providerConfigRules: { providerRules: [...providers.values()] },
      modelConfigRules: {
        providerModelRules: [...exact.values()].filter((entry) => !entry.manual).map((entry) => entry.rule),
        manualProviderModelRules: [...exact.values()]
          .filter((entry) => entry.manual)
          .map((entry) => entry.rule),
      },
    },
  }
}
/** Bounded read of program metadata or private native configuration; never leak parse text. */
function readZCodeConfig(path: string, optional: boolean, personal = false): unknown | undefined {
  let fd: number | undefined
  const buffer = Buffer.alloc(2 * 1024 * 1024 + 1)
  try {
    if (personal) {
      // The native .zcode/v2 directory entries must not redirect a private read.
      const parent = lstatSync(dirname(path))
      if (!parent.isDirectory() || parent.isSymbolicLink())
        throw new Error('Unsafe personal config directory')
      if (
        basename(dirname(path)) === 'v2' &&
        basename(dirname(dirname(path))) === '.zcode' &&
        lstatSync(dirname(dirname(path))).isSymbolicLink()
      )
        throw new Error('Unsafe personal config ancestor')
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size >= buffer.length)
      throw new Error('Unsafe ZCode config file')
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
    const after = fstatSync(fd)
    if (length >= buffer.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error('ZCode config changed during read')
    return JSON.parse(buffer.subarray(0, length).toString('utf8'))
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(
      personal ? 'ZCode 个人模型配置无法安全读取或解析' : 'ZCode 内置模型目录无法安全读取或解析',
    )
  } finally {
    buffer.fill(0)
    if (fd !== undefined) closeSync(fd)
  }
}
function readZCodePersonal(authDirectory?: string, options: ZCodeDiscoveryOptions = {}): PersonalDocument {
  const explicit =
    options.personalConfig ??
    (options.nativeHome === undefined ? process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim() : undefined)
  const nativeBase = options.nativeHome ?? process.env.ZCODE_DATA_BASE_DIR?.trim() ?? homedir()
  const paths = new Map<string, boolean>([
    [resolve(explicit || join(nativeBase, '.zcode/v2/provider_config.json')), !explicit],
  ])
  const pluginPath = resolve(join(authDirectory ?? zcodeAuthDirectory(), '.zcode/v2/provider_config.json'))
  if (!paths.has(pluginPath)) paths.set(pluginPath, true)
  const documents: PersonalDocument[] = []
  for (const [path, optional] of paths) {
    const raw = readZCodeConfig(path, optional, true)
    if (raw !== undefined) documents.push(parsePersonal(raw))
  }
  return mergePersonal(documents)
}
/** Account evidence is an explicit native API credential, never a catalog entry. */
export function readZCodePersonalIdentity(
  authDirectory?: string,
  options: ZCodeDiscoveryOptions = {},
): AccountIdentity {
  try {
    const personal = readZCodePersonal(authDirectory, options)
    let unknown = false
    let configured = false
    for (const rule of personal.config.providerConfigRules.providerRules) {
      if (rule.enabled === false || rule.config.visibility === 'hidden') continue
      const access = rule.config.access
      if (access == null) continue
      if (!record(access)) throw new Error('Invalid ZCode access configuration')
      if (!['api-key', 'zhipu-coding-plan-api-key'].includes(access.type)) {
        unknown = true
        continue
      }
      if (access.apiKey != null && typeof access.apiKey !== 'string')
        throw new Error('Invalid ZCode API credential')
      if (nonempty(access.apiKey)) configured = true
    }
    if (configured)
      return {
        state: 'configured',
        authMethod: 'api',
        verification: 'local',
        summary: '已配置 ZCode API',
      }
    return unknown
      ? { state: 'unknown', verification: 'local', summary: '账号配置格式未知' }
      : { state: 'unconfigured', verification: 'local', summary: '尚未配置 ZCode API' }
  } catch {
    return { state: 'unavailable', verification: 'local', summary: '账号配置读取失败，请检查配置' }
  }
}
function nativeOrder(base: string[], personal: string[], order: string[] = []): string[] {
  const builtin = [...new Set(base)],
    own = [...new Set(personal)].filter((id) => !builtin.includes(id))
  const known = new Set([...builtin, ...own]),
    arranged = [...new Set(order)].filter((id) => known.has(id)),
    moved = new Set(arranged)
  return [...builtin.filter((id) => !moved.has(id)), ...arranged, ...own.filter((id) => !moved.has(id))]
}
function clearManualModel(config: Record<string, any>): Record<string, any> {
  const next = structuredClone(config)
  if (record(next.properties)) {
    for (const key of [
      'contextWindow',
      'supportsJsonSchemaOutput',
      'supportsNativeWebSearch',
      'supportsMidConversationSystem',
    ])
      delete next.properties[key]
    if (record(next.properties.inputFormat))
      for (const key of ['supportsImage', 'supportsVideo', 'supportsPdf'])
        delete next.properties.inputFormat[key]
  }
  if (record(next.optionSpecs)) {
    delete next.optionSpecs.reasoningLevel
    if (record(next.optionSpecs.maxOutputTokens)) delete next.optionSpecs.maxOutputTokens.max
  }
  return next
}
interface ResolvedZCodeModel {
  choice: ModelChoice
  providerId: string
  modelId: string
  nativeReasoningDefault?: string
  /** Private effective native routing; never returned as a public model choice. */
  providerConfig: Record<string, any>
}
function resolveZCodeModels(value: unknown, personal: PersonalDocument): ResolvedZCodeModel[] {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.config))
    throw new Error('Unsupported ZCode builtin catalog schema')
  const base = providerRules(value.config.providerConfigRules?.providerRules),
    rules = value.config.modelConfigRules
  if (!record(rules) || BUILTIN_MODEL_GROUPS.some((key) => !Array.isArray(rules[key])))
    throw new Error('Incomplete ZCode builtin rule groups')
  const templates = new Map<string, Record<string, any>>()
  for (const template of value.config.providerConfigRules?.templateRules ?? []) {
    if (
      !record(template) ||
      !nativeId(template.templateId) ||
      !record(template.config) ||
      templates.has(template.templateId)
    )
      throw new Error('Invalid ZCode provider template')
    templates.set(template.templateId, template.config)
  }
  const providers = new Map<string, Record<string, any>>()
  const withTemplate = (rule: Record<string, any>) => {
    const template = rule.templateId == null ? undefined : templates.get(rule.templateId)
    if (rule.templateId != null && !template) throw new Error('Missing ZCode provider template')
    return { ...rule, config: template ? overlayConfig(template, rule.config) : rule.config }
  }
  for (const rule of base) providers.set(rule.providerId, withTemplate(rule))
  for (const rule of personal.config.providerConfigRules.providerRules) {
    const prior = providers.get(rule.providerId)
    providers.set(
      rule.providerId,
      prior ? { ...prior, ...rule, config: overlayConfig(prior.config, rule.config) } : withTemplate(rule),
    )
  }
  const match = (pattern: unknown, text: string, insensitive = false) => {
    if (!nonempty(pattern) || pattern.length > 4096) throw new Error('Invalid ZCode model rule')
    try {
      return new RegExp(`^(?:${pattern})$`, insensitive ? 'i' : undefined).test(text)
    } catch {
      throw new Error('Invalid ZCode model rule pattern')
    }
  }
  const choices = new Map<string, ResolvedZCodeModel>()
  const providerIds = nativeOrder(
    base.map((rule) => rule.providerId),
    personal.config.providerConfigRules.providerRules.map((rule) => rule.providerId),
    personal.config.providerOrder,
  )
  for (const providerId of providerIds) {
    const provider = providers.get(providerId)!,
      config = provider.config
    if (provider.enabled === false || config.visibility === 'hidden') continue
    const builtinIds = config.builtinModelIds ?? [],
      personalIds = config.personalModelIds ?? [],
      modelOrder = config.modelOrder ?? []
    if (![builtinIds, personalIds, modelOrder].every((ids) => Array.isArray(ids) && ids.every(nativeId)))
      throw new Error('Invalid ZCode model membership')
    if (
      !record(config.api) ||
      !['anthropic-messages', 'openai-chat-completions', 'openai-responses'].includes(config.api.type) ||
      !nonempty(config.api.baseUrl)
    )
      throw new Error('Invalid ZCode provider API')
    let endpoint: URL
    try {
      endpoint = new URL(config.api.baseUrl)
    } catch {
      throw new Error('Invalid ZCode provider API URL')
    }
    const suffix = `${endpoint.search}${endpoint.hash}`,
      serialized = endpoint.toString()
    const baseUrl = `${(suffix ? serialized.slice(0, -suffix.length) : serialized).replace(/\/+$/, '')}${suffix}`
    for (const modelId of nativeOrder(builtinIds, personalIds, modelOrder)) {
      let model: Record<string, any> = {}
      const apply = (rule: Record<string, any>, manual = false) => {
        model = overlayConfig(manual ? clearManualModel(model) : model, rule.config)
      }
      for (const key of BUILTIN_MODEL_GROUPS)
        for (const rule of rules[key]) {
          if (!record(rule) || !record(rule.config)) throw new Error('Invalid ZCode builtin model rule')
          if (key === 'builtinProviderModelRules') {
            if (rule.providerId !== providerId || rule.modelId !== modelId) continue
          } else if (key === 'templateModelRules') {
            if (rule.templateId !== provider.templateId || rule.modelId !== modelId) continue
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
          apply(rule)
        }
      for (const rule of personal.config.modelConfigRules.providerModelRules)
        if (rule.providerId === providerId && rule.modelId === modelId) apply(rule)
      for (const rule of personal.config.modelConfigRules.manualProviderModelRules)
        if (rule.providerId === providerId && rule.modelId === modelId) apply(rule, true)
      if (model.enabled !== undefined && typeof model.enabled !== 'boolean')
        throw new Error('Invalid ZCode model enabled rule')
      if (model.enabled !== true) continue
      const values = model.optionSpecs?.reasoningLevel?.values
      if (values != null && (!Array.isArray(values) || !values.every(nonempty)))
        throw new Error('Invalid ZCode model reasoning choices')
      // Native enabled has no numeric effort meaning; keep native default rather than inventing low/high.
      const mapped = Array.isArray(values)
        ? values.flatMap((level) =>
            level === 'disabled'
              ? ['none' as Effort]
              : level === 'enabled'
                ? ['default' as Effort]
                : EFFORTS.includes(level as Effort)
                  ? [level as Effort]
                  : [],
          )
        : []
      const id = `${providerId}/${modelId}`
      if (choices.has(id)) throw new Error('Ambiguous ZCode provider/model ID')
      choices.set(id, {
        providerId,
        modelId,
        nativeReasoningDefault: Array.isArray(values) ? values.at(-1) : undefined,
        providerConfig: config,
        choice: {
          id,
          label: `${modelId}（${providerId} · 本机目录）`,
          efforts: [...new Set(mapped.length ? mapped : ['default' as Effort])],
        },
      })
    }
  }
  return [...choices.values()]
}
/** Public projection contains only original model/provider identifiers and proven reasoning choices. */
export function parseZCodeBuiltin(value: unknown, personal?: unknown): ModelChoice[] {
  return resolveZCodeModels(value, personal === undefined ? emptyPersonal() : parsePersonal(personal)).map(
    (entry) => entry.choice,
  )
}
// Exact canonical IDs from ZCode 0.16.9's official-glm-model-id.ts. The native
// account metadata returns lowercase aliases, while execution keeps these IDs.
// Unknown spellings/suffixes remain exact; this is not general case folding.
const officialGlmIds = new Map(
  [
    'GLM-5.3',
    'GLM-5.3-Flash',
    'GLM-5V-Turbo',
    'GLM-5.2',
    'GLM-5.1',
    'GLM-5.1-Highspeed',
    'GLM-5',
    'GLM-5-Turbo',
    'GLM-4.7',
    'GLM-4.7-FlashX',
    'GLM-4.7-Flash',
    'GLM-4.6',
    'GLM-4.5-Air',
    'GLM-4.5',
    'GLM-4.6V',
    'GLM-4.6V-Flash',
    'GLM-4.6V-FlashX',
    'GLM-4.1V-Thinking-FlashX',
    'GLM-4.1V-Thinking-Flash',
    'GLM-4-FlashX-250414',
    'GLM-4-Flash-250414',
    'GLM-4V-Flash',
  ].map((id) => [id.toLowerCase(), id]),
)
function usesOfficialGlmAliases(entry: ResolvedZCodeModel): boolean {
  const { access, api } = entry.providerConfig
  if (
    access.type !== 'zhipu-account' ||
    access.mode !== 'individual-coding-plan' ||
    api.type !== 'anthropic-messages'
  )
    return false
  const baseUrl = api.baseUrl.replace(/\/+$/, '')
  return (
    (entry.providerId === 'account:bigmodel-individual-coding-plan' &&
      access.accountType === 'bigmodel' &&
      baseUrl === 'https://open.bigmodel.cn/api/anthropic') ||
    (entry.providerId === 'account:zai-individual-coding-plan' &&
      access.accountType === 'zai' &&
      baseUrl === 'https://api.z.ai/api/anthropic')
  )
}
export async function discoverZCode(
  executable: string,
  _capture: (argv: string[], env?: Record<string, string>) => Promise<string>,
  _stateDirectory: string,
  authDirectory?: string,
  builtinConfig?: string,
  options: ZCodeDiscoveryOptions = {},
): Promise<ModelChoice[]> {
  options.signal?.throwIfAborted()
  const personal = readZCodePersonal(authDirectory, options)
  const candidates = resolveZCodeModels(
    readZCodeConfig(builtinPath(executable, builtinConfig), false),
    personal,
  )
  const bound = await readZCodeAccountApiKeys(
    authDirectory ?? zcodeAuthDirectory(),
    candidates.flatMap((entry) => {
      const access = entry.providerConfig.access
      return access?.type === 'zhipu-account' &&
        access.mode === 'individual-coding-plan' &&
        ['bigmodel', 'zai'].includes(access.accountType)
        ? [entry.providerId]
        : []
    }),
    options,
  )
  const groups = new Map<string, ResolvedZCodeModel[]>()
  for (const entry of candidates) {
    const { access, api } = entry.providerConfig
    // Native OAuth login binds a concrete Worker API key to the current account.
    // Only that exact binding enters the same native route; static entitled flags,
    // old identities, desktop OAuth tokens and refresh tokens do not substitute.
    const apiKey =
      access?.type === 'zhipu-account'
        ? bound.get(entry.providerId)
        : ['api-key', 'zhipu-coding-plan-api-key'].includes(access?.type)
          ? access.apiKey
          : undefined
    if (!nonempty(apiKey)) continue
    // Custom headers may alter both credential and scope. Until this query can
    // mirror the native route exactly, keep that route out of the public list.
    if (record(api.headers) && Object.keys(api.headers).length) continue
    const group = groups.get(entry.providerId) ?? []
    group.push(entry)
    groups.set(entry.providerId, group)
  }
  const results = await Promise.all(
    [...groups.values()].map(async (entries) => {
      const { access, api } = entries[0]!.providerConfig
      const secret =
        access.type === 'zhipu-account' ? bound.get(entries[0]!.providerId)! : (access.apiKey as string)
      const scope = await probeAccountModels(
        {
          provider: entries[0]!.providerId,
          credential: { type: 'api', key: secret },
          baseUrl: api.baseUrl,
          apiType: api.type,
          // Native createAnthropic adds x-api-key, while ZCode's factory also
          // supplies withAnthropicAuthorizationHeader for the same bound key.
          ...(api.type === 'anthropic-messages' ? { anthropicAuth: 'api-key-and-bearer' as const } : {}),
          verifiedModelIds: [],
        },
        { ...options.probeOptions, signal: options.signal ?? options.probeOptions?.signal },
      )
      if (scope.state !== 'supported') return []
      const officialAliases = usesOfficialGlmAliases(entries[0]!)
      return entries.flatMap(({ modelId, choice }) => {
        const supported = scope.models.find(
          (entry) =>
            entry.id === modelId ||
            (officialAliases && officialGlmIds.get(entry.id.toLowerCase()) === modelId),
        )
        if (!supported || choice.id.includes(secret) || choice.label.includes(secret)) return []
        return [
          {
            ...choice,
            cost:
              access.type !== 'api-key' && supported.cost === 'free' ? ('unknown' as const) : supported.cost,
          },
        ]
      })
    }),
  )
  options.signal?.throwIfAborted()
  return results.flat()
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
    private expectedModel?: string,
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
      if (this.expectedModel && `${p.providerId}/${p.modelId}` !== this.expectedModel)
        throw new Error('ZCode 实际模型与所选模型不匹配，任务已拒绝')
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
