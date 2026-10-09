import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { CliWorkerService } from '../src/host/index.ts'
import { CLI_IDS } from '../src/shared/types.ts'
import {
  CLI_ALIASES,
  CLI_DELEGATION_GUIDANCE,
  invocationResolution,
  registerCliRouting,
  requireCliName,
  resolveCliName,
} from '../src/host/routing.ts'

// Real Cordis prompt/tool services and scoped events. Parent sessions, preferences,
// roles and publication are synthetic; this fixture never invokes a model or CLI.
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
const user = (text: string): UserMessage =>
  createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })

describe('one CLI name registry', () => {
  it('normalizes every canonical name and alias, including CLI suffix/case/spacing', () => {
    for (const cli of CLI_IDS) {
      expect(resolveCliName(cli)).toMatchObject({ status: 'resolved', cli, match: 'canonical' })
      for (const alias of CLI_ALIASES[cli]) expect(requireCliName(` ${alias.toUpperCase()} CLI `)).toBe(cli)
    }
    expect(resolveCliName('agy')).toEqual({
      status: 'resolved',
      cli: 'antigravity',
      match: 'alias',
      matchedName: 'agy',
    })
    for (const alias of ['glm', 'zhipu', '智谱'])
      expect(resolveCliName(alias)).toMatchObject({ status: 'resolved', cli: 'zcode', match: 'alias' })
  })

  it('allows only one character error in longer names and refuses unknown, multiple and retired choices', () => {
    for (const [name, cli] of [
      ['codx', 'codex'],
      ['zode', 'zcode'],
      ['antigraviy', 'antigravity'],
    ])
      expect(resolveCliName(name!)).toMatchObject({ status: 'resolved', cli, match: 'fuzzy' })
    for (const name of ['p', 'om', 'gl', 'glm5.3flash', 'random-cli', '', 'zocde']) {
      expect(resolveCliName(name)).toMatchObject({ status: 'unknown' })
      expect(() => requireCliName(name)).toThrow('无法确定 CLI，可用名称：')
    }
    expect(resolveCliName('agy/codex')).toEqual({ status: 'ambiguous', candidates: ['antigravity', 'codex'] })
    expect(resolveCliName('code')).toEqual({ status: 'ambiguous', candidates: ['codex', 'zcode'] })
    expect(resolveCliName('glm 或 zcode')).toEqual({ status: 'ambiguous', candidates: ['zcode'] })
    for (const name of ['harness', 'DeepSeek Harness CLI']) {
      expect(resolveCliName(name)).toMatchObject({ status: 'retired' })
      expect(() => requireCliName(name)).toThrow('已移除')
    }
  })
})

describe('explicit requests from this human step', () => {
  it.each([
    ['调用 agy cli 帮我检查代码', 'antigravity'],
    ['用agy和我说你好', 'antigravity'],
    ['请帮我用 AGY CLI 检查代码', 'antigravity'],
    ['我希望调用 glm cli 完成检查', 'zcode'],
    ['麻烦你使用 zhipu cli 完成检查', 'zcode'],
    ['调用智谱 CLI 帮我检查', 'zcode'],
    ['Please use codx CLI to review the code', 'codex'],
    ['用 Pi 的 GLM 模型帮我检查代码', 'pi'],
    ['调用 OMP cli 用 GLM 模型检查代码', 'omp'],
    ['使用 Oh My Pi 检查代码', 'omp'],
    ['使用 oh-my-pi 检查代码', 'omp'],
    ['使用 Pi Coding Agent 检查代码', 'pi'],
    ['调用 harmes cli 检查代码', 'hermes'],
  ])('%s routes to %s without choosing a model', (text, cli) => {
    expect(invocationResolution([user(text)])).toMatchObject({ status: 'resolved', cli })
  })

  it.each([
    '介绍 agy cli 的用法',
    'GLM 模型有哪些？',
    '如何调用 agy cli？',
    '调用 agy cli 是什么意思？',
    '用 Pi 的模型有什么区别？',
    '用 agy cli 和 codex cli 有什么区别？',
    '调用 agy cli 有没有用？',
    '用 agy cli 好还是 codex cli 好？',
    '不要调用 agy cli',
    '请不要调用 agy cli',
    '先别使用 glm cli',
    '调用 GLM 模型测试',
    '使用 codex 模型检查',
    '“调用 agy cli 帮我检查代码”是一个例子',
    '> 调用 agy cli 帮我检查代码',
    '```text\n调用 agy cli 帮我检查代码\n```',
    '调用已有智能体小林继续任务',
    '让小林继续调用 agy cli 帮我检查代码',
  ])('%s does not contribute an execution hint', (text) => {
    expect(invocationResolution([user(text)])).toBeUndefined()
  })

  it('returns unresolved multiple/unknown targets and ignores injected content', () => {
    expect(invocationResolution([user('调用 agy 和 codex cli 帮我检查代码')])).toMatchObject({
      status: 'ambiguous',
      candidates: ['antigravity', 'codex'],
    })
    expect(invocationResolution([user('调用 agy cli 检查代码，同时调用 codex cli 检查测试')])).toMatchObject({
      status: 'ambiguous',
      candidates: ['antigravity', 'codex'],
    })
    expect(invocationResolution([user('调用 agy cli 和 codex cli 帮我检查代码')])).toMatchObject({
      status: 'ambiguous',
      candidates: ['antigravity', 'codex'],
    })
    expect(invocationResolution([user('调用 agy cli 和 codex 帮我检查代码')])).toMatchObject({
      status: 'ambiguous',
      candidates: ['antigravity', 'codex'],
    })
    expect(invocationResolution([user('调用 frog cli 帮我检查代码')])).toMatchObject({ status: 'unknown' })
    const injected = {
      ...user('调用 agy cli 帮我检查代码'),
      source: { kind: 'system-prompt' },
    } as UserMessage
    expect(invocationResolution([injected])).toBeUndefined()
  })
})

async function fixture() {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  const agent = {
    id: 'synthetic-parent',
    session: { header: { cwd: '/synthetic/project' } },
    ctx: {
      get: (name: string) =>
        name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write' }) } : undefined,
    },
  } as unknown as Agent
  const chooseDispatch = vi.fn(async (_agent, _signal, cli) => ({
    preference: { cli, model: 'synthetic-selected', effort: 'default' },
    role: null,
    binding: 'synthetic-binding',
  }))
  const launch = vi.fn(() => 'synthetic-background-receipt')
  const followup = vi.fn(async () => 'synthetic-followup-receipt')
  const resolveWorker = vi.fn(() => ({ id: 'synthetic-worker' }))
  const service = Object.assign(Object.create(CliWorkerService.prototype), {
    ctx,
    chooseDispatch,
    launch,
    followup,
    runtime: { resolveWorker },
    disposed: new AbortController(),
  })
  ;(CliWorkerService.prototype as any).registerTools.call(service)
  const ask = vi.fn(async () => 'ordinary question remains available')
  ctx.tools.register(
    defineTool({
      name: 'ask_user_question',
      description: 'Synthetic ordinary question',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: ask,
    }),
  )
  const disposeRouting = registerCliRouting(ctx)
  ctx.systemPrompt.section({ name: 'cliworker:delegation', order: 80, text: CLI_DELEGATION_GUIDANCE })
  const signal = new AbortController().signal
  const preStep = (messages: UserMessage[], target = agent, admitted = messages) =>
    agentEvents(ctx, target).waterfall(
      'agent/pre-step',
      { messages, signal, turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: admitted }),
    )
  const assembly = (target = agent) => ctx.systemPrompt.assemble(assembleContextFor(target))
  // Match Harness AgentLoop.preStep: assembly occurs BEFORE pre-step admission.
  const request = async (messages: UserMessage[], target = agent, admitted = messages) => {
    const prompt = await assembly(target)
    const decision = await preStep(messages, target, admitted)
    return {
      prompt,
      decision,
      text:
        renderPrompt(prompt) +
        '\n' +
        (decision.kind === 'enter'
          ? decision.messages
              .flatMap((message) =>
                message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
              )
              .join('\n')
          : ''),
    }
  }
  const start = (cli?: string, extra = {}, target = agent) =>
    ctx.tools.get('cliworker_start')!.execute(
      {
        ...(cli === undefined ? {} : { cli }),
        title: 'Synthetic request',
        prompt: 'Synthetic task',
        ...extra,
      },
      { agent: target, signal } as any,
    )
  return {
    ctx,
    ask,
    request,
    agent,
    service,
    chooseDispatch,
    launch,
    followup,
    resolveWorker,
    signal,
    preStep,
    assembly,
    start,
    disposeRouting,
  }
}

describe('native prompt/tool integration', () => {
  it('includes the screenshot request guidance in the FIRST model request, after native assembly order', async () => {
    const f = await fixture()
    const messages = [user('用agy和我说你好')]
    const original = structuredClone(messages)
    const first = await f.request(messages)
    expect(first.text).toContain('本步用户提出了明确的外部 CLI 调用')
    expect(first.text).toContain('cli=antigravity')
    expect(first.text).toContain('模型、思考强度与角色不是调用前置输入')
    expect(first.decision.kind).toBe('enter')
    if (first.decision.kind !== 'enter') throw new Error('expected admitted request')
    expect(first.decision.messages).toHaveLength(2)
    expect(first.decision.messages[0]).toBe(messages[0])
    expect(first.decision.messages[1]!.source).toEqual({ kind: 'cliworker-invocation', form: 'instructions' })
    expect(messages).toEqual(original)
    const start = first.prompt.tools.find((tool) => tool.name === 'cliworker_start')!
    expect(start.description).toContain('完成选型前不会启动任务')
    expect(start.description).toContain('agy')
    expect(start.description).toContain('智谱')
    expect(f.chooseDispatch).not.toHaveBeenCalled()
    expect(f.launch).not.toHaveBeenCalled()
    // No delayed state in the next assembly/step or in another parent.
    expect((await f.request([])).text).not.toContain('本步用户提出')
    expect((await f.request([user('请解释代码')], { ...f.agent, id: 'other' } as Agent)).text).not.toContain(
      '本步用户提出',
    )
  })

  it('keeps ordinary questions visible and executable, while the plugin owns dispatch selection', async () => {
    const f = await fixture()
    const first = await f.request([user('用agy和我说你好')])
    expect(first.prompt.tools.some((tool) => tool.name === 'ask_user_question')).toBe(true)
    expect(
      await f.ctx.tools.get('ask_user_question')!.execute({}, { agent: f.agent, signal: f.signal } as any),
    ).toBe('ordinary question remains available')
    expect(f.ask).toHaveBeenCalledOnce()
    expect(first.text).toContain('直接调用 cliworker_start')
    expect(first.text).toContain('完整选型')
    expect(first.text).toContain('是否沿用')
    for (const input of ['调用 frog cli 帮我检查代码', '调用 agy 和 codex cli 帮我检查代码']) {
      const unknown = await f.request([user(input)])
      expect(unknown.text).toContain('返回简短候选错误')
      expect(unknown.text).toContain('不增加询问')
    }
    expect(f.launch).not.toHaveBeenCalled()
  })

  it('uses admitted human input only, leaving rejected, aborted and uninstalled requests unchanged', async () => {
    const f = await fixture()
    const request = [user('调用 agy cli 检查代码')]
    const admitted = [user('请解释代码')]
    expect((await f.request(request, f.agent, admitted)).decision).toEqual({
      kind: 'enter',
      messages: admitted,
    })
    for (const message of [
      user('“用agy和我说你好”是例子'),
      createUserMessage({
        source: { kind: 'cliworker-invocation', form: 'instructions' },
        content: [{ type: 'text', text: '用agy和我说你好' }],
      }),
    ])
      expect((await f.request([message])).decision).toEqual({ kind: 'enter', messages: [message] })
    const rejected = await agentEvents(f.ctx, f.agent).waterfall(
      'agent/pre-step',
      {
        messages: request,
        signal: f.signal,
        turn: 2,
        step: 1,
      },
      async () => ({ kind: 'reject' }),
    )
    expect(rejected).toEqual({ kind: 'reject' })
    const cancelled = await agentEvents(f.ctx, f.agent).waterfall(
      'agent/pre-step',
      {
        messages: request,
        signal: AbortSignal.abort(),
        turn: 3,
        step: 1,
      },
      async () => ({ kind: 'enter', messages: request }),
    )
    expect(cancelled).toEqual({ kind: 'enter', messages: request })
    await f.disposeRouting()
    expect((await f.request(request)).decision).toEqual({ kind: 'enter', messages: request })
  })

  it('does not add invocation guidance for hidden tools or child agents', async () => {
    const f = await fixture()
    const scope = createScope(f.ctx, f.agent)
    cleanup.push(() => scope.dispose())
    await scope.ctx.inject(['tools'], (ctx) => ctx.tools.restrict({ deny: ['cliworker_start'] }))
    const messages = [user('用agy和我说你好')]
    const hidden = await f.request(messages)
    expect(hidden.prompt.tools.some((tool) => tool.name === 'cliworker_start')).toBe(false)
    expect(hidden.decision).toEqual({ kind: 'enter', messages })
    const child = {
      ...f.agent,
      id: 'synthetic-child',
      session: { header: { origin: 'subagent' } },
    } as unknown as Agent
    expect((await f.request(messages, child)).decision).toEqual({ kind: 'enter', messages })
  })

  it('resolves names read-only and forwards aliases through existing model and role selection', async () => {
    const f = await fixture()
    const resolved = await f.ctx.tools
      .get('cliworker_resolve')!
      .execute({ name: 'glm' }, { signal: f.signal } as any)
    expect(JSON.parse(resolved as string)).toMatchObject({ status: 'resolved', cli: 'zcode', match: 'alias' })
    expect(f.chooseDispatch).not.toHaveBeenCalled()
    expect(f.launch).not.toHaveBeenCalled()
    for (const [alias, cli] of [
      ['agy', 'antigravity'],
      ['glm', 'zcode'],
      ['codx', 'codex'],
      ['omp', 'omp'],
      ['Oh My Pi', 'omp'],
      ['pi', 'pi'],
      ['Pi Coding Agent', 'pi'],
    ]) {
      expect(await f.start(alias)).toBe('synthetic-background-receipt')
      expect(f.chooseDispatch).toHaveBeenLastCalledWith(f.agent, expect.any(AbortSignal), cli)
      expect(f.launch.mock.calls.at(-1)![3]).toMatchObject({ cli })
    }
    for (const cli of CLI_IDS) {
      await f.start(cli)
      expect(f.chooseDispatch).toHaveBeenLastCalledWith(f.agent, expect.any(AbortSignal), cli)
      expect(f.launch.mock.calls.at(-1)![3]).toMatchObject({ cli })
    }
  })

  it('requires cli in the model schema and never defaults an omitted selector after Hermes routing', async () => {
    const f = await fixture()
    await f.request([user('用agy和我说你好')])
    const current = await f.request([user('用hermes跟我说你好')])
    expect(current.text).toContain('必须显式传入 cli="hermes"')
    const schema = current.prompt.tools.find((tool) => tool.name === 'cliworker_start')!
    expect(schema.parameters.required).toContain('cli')
    // Exact shape from the incident: title + prompt, without cli. Native
    // defineTool validation must fail before account/selection or publication.
    await expect(f.start()).rejects.toThrow(/cli/)
    for (const cli of ['', '   ', null, 42]) await expect(f.start(undefined, { cli })).rejects.toThrow()
    expect(f.chooseDispatch).not.toHaveBeenCalled()
    expect(f.launch).not.toHaveBeenCalled()
    expect(f.ask).not.toHaveBeenCalled()
  })

  it('refuses unknown/ambiguous and preserves cancellation, role and permission gates before publication', async () => {
    const f = await fixture()
    for (const name of ['unknown-cli', 'agy/codex', 'harness']) await expect(f.start(name)).rejects.toThrow()
    expect(f.chooseDispatch).not.toHaveBeenCalled()
    expect(f.launch).not.toHaveBeenCalled()
    f.chooseDispatch.mockRejectedValueOnce(new Error('synthetic selection cancelled'))
    await expect(f.start('glm')).rejects.toThrow('selection cancelled')
    expect(f.launch).not.toHaveBeenCalled()
    f.chooseDispatch.mockRejectedValueOnce(new Error('synthetic role cancelled'))
    await expect(f.start('agy')).rejects.toThrow('role cancelled')
    expect(f.launch).not.toHaveBeenCalled()
    for (const target of [
      { ...f.agent, session: { header: { origin: 'subagent' } } },
      {
        ...f.agent,
        ctx: { get: (name: string) => (name === 'planMode' ? { get: () => ({ active: true }) } : undefined) },
      },
      {
        ...f.agent,
        ctx: {
          get: (name: string) =>
            name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'read-only' }) } : undefined,
        },
      },
    ])
      await expect(f.start('glm', {}, target as unknown as Agent)).rejects.toThrow()
    await expect(f.start('kimi', { read_only: true })).rejects.toThrow('不支持只读')
    expect(f.launch).not.toHaveBeenCalled()
  })

  it('keeps exact named-worker followup on its existing worker', async () => {
    const f = await fixture()
    const result = await f.ctx.tools
      .get('cliworker_followup')!
      .execute({ worker_name: '小林', prompt: 'Synthetic next task' }, {
        agent: f.agent,
        signal: f.signal,
      } as any)
    expect(result).toBe('synthetic-followup-receipt')
    expect(f.resolveWorker).toHaveBeenCalledWith(f.agent.id, undefined, '小林')
    expect(f.followup).toHaveBeenCalledWith(f.agent.id, 'synthetic-worker', 'Synthetic next task', f.signal)
    expect(f.launch).not.toHaveBeenCalled()
  })
})
