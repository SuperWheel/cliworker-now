import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
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
  it('assembles current-step canonical hints and visible alias-aware tools without changing input or publishing', async () => {
    const f = await fixture()
    const messages = [user('调用 glm cli 帮我检查代码')]
    const original = structuredClone(messages)
    const entered = await f.preStep(messages)
    expect(entered).toEqual({ kind: 'enter', messages })
    expect(messages).toEqual(original)
    const result = await f.assembly()
    expect(renderPrompt(result)).toContain('cli=zcode')
    const start = result.tools.find((tool) => tool.name === 'cliworker_start')!
    expect(start.description).toContain('agy')
    expect(start.description).toContain('智谱')
    expect(result.tools.some((tool) => tool.name === 'cliworker_resolve')).toBe(true)
    expect(f.chooseDispatch).not.toHaveBeenCalled()
    expect(f.launch).not.toHaveBeenCalled()
    const other = { ...f.agent, id: 'synthetic-other-parent' } as Agent
    expect(renderPrompt(await f.assembly(other))).not.toContain('本步用户提出')
    await f.preStep([user('介绍 GLM 模型有哪些')])
    expect(renderPrompt(await f.assembly())).not.toContain('本步用户提出')
  })

  it('delegates only complete selection or reuse questions to the plugin without preliminary questions', async () => {
    const f = await fixture()
    await f.preStep([user('调用 agy cli 帮我检查代码')])
    const resolved = renderPrompt(await f.assembly())
    expect(resolved).toContain('直接调用 cliworker_start')
    expect(resolved).toContain('完整选型')
    expect(resolved).toContain('是否沿用')
    for (const obsolete of [
      '每个新 Worker 都须',
      '任务缺失先询问',
      '先澄清具体 CLI',
      '任务内容缺失时先确认任务',
    ])
      expect(resolved).not.toContain(obsolete)
    for (const input of ['调用 frog cli 帮我检查代码', '调用 agy 和 codex cli 帮我检查代码']) {
      await f.preStep([user(input)])
      const unknown = renderPrompt(await f.assembly())
      expect(unknown).toContain('返回简短候选错误')
      expect(unknown).toContain('不增加询问')
      expect(unknown).not.toContain('先澄清具体 CLI')
    }
    expect(() => requireCliName('agy/codex')).toThrow('无法确定 CLI，可用名称：Antigravity、Codex')
    expect(f.launch).not.toHaveBeenCalled()
  })

  it('uses only admitted human messages and clears rejected/cancelled/disposed steps', async () => {
    const f = await fixture()
    await f.preStep([user('调用 agy cli 检查代码')], f.agent, [user('请解释代码')])
    expect(renderPrompt(await f.assembly())).not.toContain('本步用户提出')
    await f.preStep([user('调用 agy cli 检查代码')])
    expect(renderPrompt(await f.assembly())).toContain('cli=antigravity')
    await agentEvents(f.ctx, f.agent).waterfall(
      'agent/pre-step',
      {
        messages: [user('调用 glm cli 检查代码')],
        signal: f.signal,
        turn: 2,
        step: 2,
      },
      async () => ({ kind: 'reject' }),
    )
    expect(renderPrompt(await f.assembly())).not.toContain('本步用户提出')
    const aborted = AbortSignal.abort()
    await agentEvents(f.ctx, f.agent).waterfall(
      'agent/pre-step',
      {
        messages: [user('调用 agy cli 检查代码')],
        signal: aborted,
        turn: 3,
        step: 3,
      },
      async () => ({ kind: 'enter', messages: [user('调用 agy cli 检查代码')] }),
    )
    expect(renderPrompt(await f.assembly())).not.toContain('本步用户提出')
    await f.preStep([user('调用 agy cli 检查代码')])
    agentEvents(f.ctx, f.agent).emit('agent/disposed', {})
    expect(renderPrompt(await f.assembly())).not.toContain('本步用户提出')
    await f.preStep([user('调用 agy cli 检查代码')])
    await f.disposeRouting()
    expect(
      (await f.assembly()).sections.some((section) => section.name === 'cliworker:current-invocation'),
    ).toBe(false)
  })

  it('does not advertise hidden tools or hint execution for child agents', async () => {
    const f = await fixture()
    await f.preStep([user('调用 agy cli 检查代码')])
    const scope = createScope(f.ctx, f.agent)
    cleanup.push(() => scope.dispose())
    await scope.ctx.inject(['tools'], (ctx) => {
      ctx.tools.restrict({ deny: ['cliworker_start'] })
    })
    const result = await f.assembly()
    expect(result.tools.some((tool) => tool.name === 'cliworker_start')).toBe(false)
    expect(renderPrompt(result)).not.toContain('本步用户提出')
    const child = {
      ...f.agent,
      id: 'synthetic-child',
      session: { header: { origin: 'subagent' } },
    } as unknown as Agent
    await f.preStep([user('调用 agy cli 检查代码')], child)
    expect(renderPrompt(await f.assembly(child))).not.toContain('本步用户提出')
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
    await f.start()
    expect(f.chooseDispatch).toHaveBeenLastCalledWith(f.agent, expect.any(AbortSignal), 'antigravity')
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
