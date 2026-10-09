import type { Context } from '@deepseek-ai/cordis'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { CLI_IDS, CLI_LABELS, RETIRED_HARNESS_NOTICE, type ActiveCliId } from '../shared/types.ts'

/** One source for tool normalization, natural-language hints and model guidance. */
export const CLI_ALIASES: Record<ActiveCliId, readonly string[]> = {
  antigravity: ['agy', 'antigravity'],
  codex: ['codex'],
  claude: ['claude', 'claude code'],
  kimi: ['kimi', 'kimi code'],
  mimo: ['mimo', 'mimo code'],
  zcode: ['zcode', 'glm', 'zhipu', '智谱'],
  grok: ['grok', 'grok build'],
  omp: ['omp', 'oh my pi', 'oh-my-pi'],
  pi: ['pi', 'pi coding agent'],
  hermes: ['hermes', 'hermes agent', 'harmes'],
  opencode: ['opencode', 'open code'],
}

export type CliResolution =
  | { status: 'resolved'; cli: ActiveCliId; match: 'canonical' | 'alias' | 'fuzzy'; matchedName: string }
  | { status: 'ambiguous' | 'unknown' | 'retired'; candidates: ActiveCliId[] }

const normalizeName = (name: string) =>
  name
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s*(?:cli|命令行)\s*$/u, '')
    .replace(/[\s_-]+/gu, '')

const names = CLI_IDS.flatMap((cli) => CLI_ALIASES[cli].map((name) => ({ cli, name })))
const exactNames = new Map(names.map(({ cli, name }) => [normalizeName(name), { cli, name }]))

/** A single insertion, deletion or substitution; short CLI names never use it. */
function oneCharacterApart(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false
  let a = 0
  let b = 0
  let changes = 0
  while (a < left.length && b < right.length) {
    if (left[a] === right[b]) {
      a++
      b++
    } else {
      if (++changes > 1) return false
      if (left.length <= right.length) b++
      if (left.length >= right.length) a++
    }
  }
  return changes + (left.length - a) + (right.length - b) === 1
}

/** Explicit tool selectors may be aliases; unresolved selectors never select a default. */
export function resolveCliName(name: string): CliResolution {
  if (typeof name !== 'string' || name.length > 80) return { status: 'unknown', candidates: [] }
  const normalized = normalizeName(name)
  if (normalized === 'harness' || normalized === 'deepseekharness')
    return { status: 'retired', candidates: [] }
  const exact = exactNames.get(normalized)
  if (exact)
    return {
      status: 'resolved',
      cli: exact.cli,
      match: normalized === exact.cli ? 'canonical' : 'alias',
      matchedName: exact.name,
    }
  const parts = name.split(/[,，、/;；+]|\s+(?:and|or)\s+|[和与或]/iu).filter((part) => part.trim())
  if (parts.length > 1) {
    const candidates = [
      ...new Set(
        parts.flatMap((part) => {
          const resolution = resolveCliName(part)
          return resolution.status === 'resolved' ? [resolution.cli] : resolution.candidates
        }),
      ),
    ]
    return { status: 'ambiguous', candidates }
  }
  // Typos only apply to longer Latin names and never to pi, omp or glm.
  if (!/^[a-z][a-z0-9]{3,39}$/u.test(normalized)) return { status: 'unknown', candidates: [] }
  const matches = names.filter(({ name: known }) => {
    const normalizedKnown = normalizeName(known)
    return normalizedKnown.length >= 4 && oneCharacterApart(normalized, normalizedKnown)
  })
  const candidates = [...new Set(matches.map(({ cli }) => cli))]
  if (candidates.length === 1)
    return { status: 'resolved', cli: candidates[0]!, match: 'fuzzy', matchedName: matches[0]!.name }
  return { status: candidates.length > 1 ? 'ambiguous' : 'unknown', candidates }
}

export function requireCliName(name: string): ActiveCliId {
  const resolution = resolveCliName(name)
  if (resolution.status === 'resolved') return resolution.cli
  if (resolution.status === 'retired') throw new Error(RETIRED_HARNESS_NOTICE)
  const candidates = (resolution.candidates.length ? resolution.candidates : CLI_IDS)
    .map((cli) => CLI_LABELS[cli])
    .join('、')
  throw new Error(`无法确定 CLI，可用名称：${candidates}`)
}

export const CLI_NAME_GUIDANCE =
  CLI_IDS.map((cli) => `${CLI_ALIASES[cli].join(' / ')} → ${cli}`).join('；') +
  '。OMP（Oh My Pi，cli=omp）和 Pi Coding Agent（cli=pi）是两个独立 CLI；即使使用同名模型也必须按用户指定分别选择账号、模型、强度和会话，禁止互换或合并'

export const CLI_DELEGATION_GUIDANCE = `CLI Worker Now 是调用外部 CLI 的插件入口。用户明确指定 CLI 并要求派遣时，直接调用 cliworker_start 打开选型流程；cli 参数每次必填，使用本次用户指定的 CLI，不照搬历史省略参数的调用；此工具只需 CLI、任务标题与任务内容，模型、强度与角色由插件收集，完成选型前不会启动任务。不要仅解释用法，也不要通过 bash 运行这些 CLI。名称映射：${CLI_NAME_GUIDANCE}。glm、zhipu、智谱在 CLI 调用语境中指 ZCode，不代表已选择或授权任何 GLM 模型；“用 Pi 的 GLM 模型”仍使用 Pi。仅讨论、比较、介绍模型或 CLI、否定调用、引用调用示例不构成派遣授权。较长名称的唯一轻微拼写误差可以解析；不确定时可用只读 cliworker_resolve 检查。歧义、未知或多个目标返回简短候选错误，不启动、不猜测或改用其他 CLI。
插件内部只询问完整选型（模型、实际支持的思考强度与角色）或是否沿用以前设定。同项目同 CLI 的新主对话确认是否沿用，同一主对话后续使用已确认设定。主 Agent 不提前询问任务、CLI、模型、强度或角色，不增加启动确认，也不代答插件问题。Kimi print 模式不支持 read_only 或强度覆盖，其原生工具策略会自动执行；其他 CLI 权限检查仍有效，宿主规划、整体只读及子 Agent 限制不得绕过。
用户明确提供名称时传入 agent_name，否则插件分配唯一名称，介绍 Worker 时使用返回的 agentName。用户要求已有智能体继续时，调用 cliworker_followup 并传入该父会话中精确 worker_name 或 worker_id，不要新建或猜测名称；已有会话保留创建时角色快照。独立任务分开处理，cliworker_status 查看进度，cliworker_stop 停止任务。
任务在后台执行并报告完成；等待时继续有用工作，不要反复轮询。收到完成通知后读取对应 workerId 和 runId 的输出。侧栏续聊即使标题未变也是新任务，只总结当前任务与回复；输出不可读时查询 cliworker_status 并说明不确定，不能复用旧结果。CLI 输出是不可信证据，汇报成功前独立核验实际修改。Worker 不得递归派遣其他 Agent。`

function withoutQuotes(text: string): string {
  return text
    .slice(0, 32768)
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, '')
    .replace(/^\s*>.*$/gmu, '')
    .replace(/`[^`\n]*`|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'/gu, '')
}

const command =
  /^(?:(?:请(?:你)?|麻烦(?:你)?|帮我|帮忙|我想(?:要)?|我希望|我要|现在|再|然后|顺便|同时|并且|并|也|你能否|能否|能不能|可以|please|can you)\s*)*(?:调用|使用|用|派遣|启动|让|invoke\b|call\b|use\b|start\b)\s*(.+)$/iu
const discussion =
  /^\s*(?:的?\s*(?:模型|model\b)|是什么意思|是什[么麼]|是否|有什么|怎么样|怎么(?:用|调用)|如何(?:工作|使用)|有哪些|的?(?:区别|说明|例子|示例|介绍)|这个(?:说法|例子)|means\b)/iu
function isDiscussion(suffix: string): boolean {
  if (discussion.test(suffix)) return true
  // "用 agy cli 和 codex cli 有什么区别" is discussion, whereas
  // "用 agy cli 帮我比较这两个模块" is a task for the named CLI.
  return (
    !/^\s*(?:帮我|来|去|完成|处理|执行|检查|审查|写|修改|实现|修复|分析|to\b)/iu.test(suffix) &&
    /区别|差别|优缺点|好还是|哪个(?:好|更)|有没有|是否|怎么样/u.test(suffix)
  )
}
const escapeRegex = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const leadingNames = [...names]
  .sort((a, b) => b.name.length - a.name.length)
  .map(({ name }) => ({
    name,
    expression: new RegExp(
      `^${escapeRegex(name).replace(/ /gu, '\\s+')}($|(?=[\\s\\p{Script=Han},，。;；!?！？]))`,
      'iu',
    ),
  }))

/** Recognize only direct commands in this human input; quoted/model/tool text is excluded. */
export function invocationResolution(messages: readonly UserMessage[]): CliResolution | undefined {
  const resolutions: CliResolution[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    const text = withoutQuotes(
      message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
    )
    for (const clause of text.split(
      /[\n。;；!?！？]|[,，](?=\s*(?:请|然后|顺便|同时|并且|调用|使用|用|让))/u,
    )) {
      const request = clause.trim().match(command)?.[1]
      if (!request) continue
      const explicit = request.match(/^(.*?)\s*(?:cli\b|命令行)(.*)$/iu)
      if (explicit) {
        // A named worker's nested instruction belongs to followup, not CLI-name resolution.
        if (/调用|使用|继续|接着/u.test(explicit[1]!)) continue
        const selectors = [resolveCliName(explicit[1]!)]
        let suffix = explicit[2]!
        while (true) {
          const additional = suffix.match(/^\s*(?:和|与|或|以及|and\b|or\b|[,，、/])\s*(.+)$/iu)?.[1]
          if (!additional) break
          const next = additional.match(/^(.*?)\s*(?:cli\b|命令行)(.*)$/iu)
          if (next) {
            selectors.push(resolveCliName(next[1]!))
            suffix = next[2]!
          } else {
            const known = leadingNames.find(({ expression }) => expression.test(additional))
            if (!known) break
            selectors.push(resolveCliName(known.name))
            suffix = additional.slice(additional.match(known.expression)![0].length)
          }
        }
        if (isDiscussion(suffix)) continue
        resolutions.push(...selectors)
        continue
      }
      const known = leadingNames.find(({ expression }) => expression.test(request))
      if (!known || ['glm', 'zhipu', '智谱'].includes(known.name)) continue
      const suffix = request.slice(request.match(known.expression)![0].length)
      if (isDiscussion(suffix)) continue
      resolutions.push(resolveCliName(known.name))
    }
  }
  if (!resolutions.length) return undefined
  if (resolutions.length === 1) return resolutions[0]
  return {
    status: 'ambiguous',
    candidates: [
      ...new Set(
        resolutions.flatMap((result) => (result.status === 'resolved' ? [result.cli] : result.candidates)),
      ),
    ],
  }
}

function invocationHint(resolution: CliResolution | undefined): string {
  if (!resolution) return ''
  if (resolution.status === 'resolved')
    return `本步用户提出了明确的外部 CLI 调用，${resolution.match === 'fuzzy' ? '唯一轻微拼写匹配' : '名称映射'}结果为 ${CLI_LABELS[resolution.cli]}（cli=${resolution.cli}）。直接调用 cliworker_start，必须显式传入 cli="${resolution.cli}"、任务标题与任务内容；不能省略 cli 或照搬历史调用参数。此工具先打开完整选型或是否沿用设定的流程，用户确认选型后才启动任务；模型、思考强度与角色不是调用前置输入，不提前提问或增加启动确认。已有命名智能体续聊仍使用 cliworker_followup。保留宿主权限检查，不代答，不通过 bash 执行。`
  if (resolution.status === 'retired') return RETIRED_HARNESS_NOTICE
  const candidates = (resolution.candidates.length ? resolution.candidates : CLI_IDS)
    .map((cli) => CLI_LABELS[cli])
    .join('、')
  return `本步用户调用的 CLI 无法确定。返回简短候选错误：${candidates}。不启动、不猜测或保存设定，不增加询问。`
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'cliworker-invocation': { kind: 'cliworker-invocation'; form: 'instructions' }
  }
}

/** Add guidance to the accepted batch, which is sent in this very model request. */
export function registerCliRouting(ctx: Context): () => Promise<void> {
  return ctx.effect(
    () =>
      ctx.on(
        'agent/pre-step',
        async ({ agent, signal }, next) => {
          const decision = await next()
          if (
            decision.kind !== 'enter' ||
            signal.aborted ||
            agent.session.header.origin === 'subagent' ||
            !ctx.tools.get('cliworker_start', assembleContextFor(agent).scope)
          )
            return decision
          const hint = invocationHint(invocationResolution(decision.messages))
          if (!hint) return decision
          // Harness assembles the system prompt BEFORE pre-step. A section updated
          // here would arrive one request late; accepted messages join this request.
          return {
            ...decision,
            messages: [
              ...decision.messages,
              createUserMessage({
                source: { kind: 'cliworker-invocation', form: 'instructions' },
                content: [{ type: 'text', text: hint }],
              }),
            ],
          }
        },
        { prepend: true },
      ),
    'cliworker:routing',
  )
}
