import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverAgyAccountModels } from '../src/host/agy-models.ts'
import { resolveModel } from '../src/shared/models.ts'

// Synthetic native files and replies only. No actual account or subprocess.
let home: string
const signal = () => new AbortController().signal
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cwn-agy-model-synthetic-'))
  await mkdir(join(home, '.gemini/antigravity-cli'), { recursive: true })
})
afterEach(async () => { await rm(home, { recursive: true, force: true }) })
const login = () => writeFile(join(home, '.gemini/jetski-standalone-oauth-token'), JSON.stringify({
  auth_method: 'consumer', token: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' },
}))

it('keeps native logged-in model IDs and only their reported effort variants', async () => {
  await login()
  const capture = vi.fn(async () => [
    'gemini-synthetic-high\tGemini Synthetic (High)',
    'gemini-synthetic-low\tGemini Synthetic (Low)',
    'claude-synthetic\tClaude Synthetic (Thinking)',
  ].join('\n'))
  const models = await discoverAgyAccountModels(capture, signal(), home)
  expect(models.map(m => [m.id, m.efforts])).toEqual([
    ['gemini-synthetic', ['low', 'high']], ['claude-synthetic', ['default']],
  ])
  expect(resolveModel({ cli: 'antigravity', model: 'gemini-synthetic', effort: 'high' }, models).model)
    .toBe('gemini-synthetic-high')
  expect(() => resolveModel({ cli: 'antigravity', model: 'gemini-synthetic', effort: 'medium' }, models)).toThrow()
  expect(capture).toHaveBeenCalledOnce()
})

it('does not discover public models when only another CLI has credentials or after native logout', async () => {
  await mkdir(join(home, '.codex'))
  await writeFile(join(home, '.codex/auth.json'), '{"OPENAI_API_KEY":"synthetic-other-cli"}')
  const capture = vi.fn(async () => 'public-model\tPublic Model')
  await expect(discoverAgyAccountModels(capture, signal(), home)).rejects.toThrow('请先登录')
  expect(capture).not.toHaveBeenCalled()
  await login()
  await discoverAgyAccountModels(capture, signal(), home)
  await rm(join(home, '.gemini/jetski-standalone-oauth-token'))
  await expect(discoverAgyAccountModels(capture, signal(), home)).rejects.toThrow('请先登录')
  expect(capture).toHaveBeenCalledOnce()
})

it('refreshes native permissions instead of reviving the previous model list on failure', async () => {
  await login()
  const capture = vi.fn().mockResolvedValueOnce('first\tFirst').mockResolvedValueOnce('second\tSecond')
    .mockRejectedValueOnce(new Error('synthetic account denied')).mockResolvedValueOnce('')
  expect((await discoverAgyAccountModels(capture, signal(), home))[0]?.id).toBe('first')
  expect((await discoverAgyAccountModels(capture, signal(), home))[0]?.id).toBe('second')
  await expect(discoverAgyAccountModels(capture, signal(), home)).rejects.toThrow('denied')
  await expect(discoverAgyAccountModels(capture, signal(), home)).rejects.toThrow('暂无可用模型')
})

it.each([{ modelProvider: 'gemini' }, { customModels: ['synthetic-external'] }, { customModelsConfig: 'external.json' }])(
  'does not treat an alternative route as consumer-account permission: %j', async (settings) => {
    await login()
    await writeFile(join(home, '.gemini/antigravity-cli/settings.json'), JSON.stringify(settings))
    const capture = vi.fn()
    await expect(discoverAgyAccountModels(capture, signal(), home)).rejects.toThrow('自定义模型来源')
    expect(capture).not.toHaveBeenCalled()
  },
)

it('drops a reply when the model query has been cancelled', async () => {
  await login()
  const controller = new AbortController()
  await expect(discoverAgyAccountModels(async () => {
    controller.abort()
    return 'synthetic\tSynthetic'
  }, controller.signal, home)).rejects.toThrow()
})
