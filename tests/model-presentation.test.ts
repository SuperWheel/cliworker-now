import { describe, expect, it } from 'vitest'
import { displayModelName, nativeModelName, visibleModelChoices } from '../src/shared/model-presentation.ts'
import { resolveModel } from '../src/shared/models.ts'
import type { ModelChoice, Preference } from '../src/shared/types.ts'

describe('pure model presentation (synthetic catalog metadata)', () => {
  it('shortens nested provider and organization display paths while preserving Hermes identity', () => {
    const preference: Preference = {
      cli: 'hermes',
      model: JSON.stringify(['nous', 'inclusionai/ling-3.1-flash']),
      effort: 'default',
    }
    const original = structuredClone(preference)
    expect(displayModelName(preference)).toBe('ling-3.1-flash')
    expect(displayModelName('openrouter/inclusionai/ling-3.1-flash')).toBe('ling-3.1-flash')
    expect(displayModelName({ id: preference.model, label: 'inclusionai/ling-3.1-flash（Nous）' })).toBe(
      'ling-3.1-flash',
    )
    expect(preference).toEqual(original)
    expect(nativeModelName(preference.model)).toBe('inclusionai/ling-3.1-flash')
  })

  it('keeps same leaf names from different organizations independently selectable with their capabilities', () => {
    const raw: ModelChoice[] = [
      { id: 'provider/organization-a/chat-model', label: 'organization-a/chat-model', efforts: ['default'] },
      { id: 'provider/organization-b/chat-model', label: 'organization-b/chat-model', efforts: ['high'] },
    ]
    const original = structuredClone(raw)
    const visible = visibleModelChoices(raw)
    expect(visible.map((model) => model.label)).toEqual(['chat-model', 'chat-model · 2'])
    expect(visible.map((model) => model.id)).toEqual(raw.map((model) => model.id))
    expect(visible.map((model) => model.efforts)).toEqual([['default'], ['high']])
    for (const model of visible)
      expect(resolveModel({ cli: 'hermes', model: model.id, effort: model.efforts![0]! }, raw).model).toBe(
        model.id,
      )
    expect(() => resolveModel({ model: visible[0]!.id, effort: 'high' }, raw)).toThrow('不可用')
    expect(raw).toEqual(original)
  })

  it('handles long nested untrusted annotations without repeatedly rescanning them', () => {
    const model: ModelChoice = {
      id: 'native/model-v1',
      label: `Model v1 ${'（('.repeat(20000)}Synthetic vendor metadata${')）'.repeat(20000)} (suffix)`,
    }
    expect(displayModelName(model)).toBe('Model v1')
    expect(model.id).toBe('native/model-v1')
  })
  it('cleans route prefixes and Chinese/English annotations without altering historical preferences', () => {
    const preference: Preference = {
      cli: 'zcode',
      model: 'account:bigmodel-individual-coding-plan/GLM-5.3-Flash',
      effort: 'low',
    }
    expect(displayModelName(preference)).toBe('GLM-5.3-Flash')
    expect(preference.model).toBe('account:bigmodel-individual-coding-plan/GLM-5.3-Flash')
    expect(displayModelName({ id: 'route/GLM-5.3', label: 'GLM-5.3（provider · 本机目录） (extra)' })).toBe(
      'GLM-5.3',
    )
    expect(displayModelName({ id: 'route/chat', label: 'route/Chat (provider (nested))' })).toBe('Chat')
    expect(
      displayModelName({ id: 'sonnet', label: 'Claude 官方模型别名 sonnet（账户可用性由 CLI 验证）' }),
    ).toBe('sonnet')
    expect(displayModelName({ id: 'route/chat', label: '(provider)' })).toBe('chat')
    expect(displayModelName({ id: 'route/model', label: 'model（unterminated' })).toBe('model')
    expect(displayModelName('route/model(v1)')).toBe('model(v1)')
  })

  it('keeps exact AGY effort grouping and reads Hermes tuple history without a catalog', () => {
    expect(displayModelName({ cli: 'antigravity', model: 'gemini-fixture-high', effort: 'high' })).toBe(
      'gemini-fixture',
    )
    expect(displayModelName({ cli: 'codex', model: 'model-high', effort: 'high' })).toBe('model-high')
    expect(
      displayModelName({
        cli: 'hermes',
        model: JSON.stringify(['native-provider', 'chat-model']),
        effort: 'default',
      }),
    ).toBe('chat-model')
    expect(nativeModelName('provider/org/model-v1')).toBe('org/model-v1')
    expect(nativeModelName(JSON.stringify(['provider', 'org/model-v1']))).toBe('org/model-v1')
  })

  it('deduplicates an exact model across routes and prioritizes explicit free evidence for new selection', () => {
    const raw: ModelChoice[] = [
      { id: 'paid/GLM-5.3', label: 'GLM-5.3（paid）', cost: 'paid', efforts: ['high'] },
      { id: 'unknown/other', label: 'Other (unknown)', efforts: ['default'] },
      { id: 'free/glm-5.3', label: 'GLM-5.3 (free)', cost: 'free', efforts: ['default'] },
      { id: 'free/another', label: 'Another', cost: 'free', efforts: ['low'] },
    ]
    const before = structuredClone(raw)
    const visible = visibleModelChoices(raw)
    expect(visible.map((model) => model.id)).toEqual(['free/glm-5.3', 'free/another', 'unknown/other'])
    expect(visible[0]!.label).toBe('GLM-5.3')
    expect(visible[0]!.efforts).toEqual(['default'])
    expect(raw).toEqual(before)
    expect(raw).toHaveLength(4)
  })

  it('pins the exact saved route and keeps its capabilities without unioning free alternatives', () => {
    const saved: ModelChoice = {
      id: 'paid/chat',
      label: 'Chat (paid)',
      cost: 'paid',
      efforts: ['high'],
      variants: { high: 'paid/chat-high' },
    }
    const raw: ModelChoice[] = [
      {
        id: 'free/chat',
        label: 'Chat (free)',
        cost: 'free',
        efforts: ['default'],
        variants: { default: 'free/chat-default' },
      },
      saved,
    ]
    const visible = visibleModelChoices(raw, 'paid/chat-high')
    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({
      id: 'paid/chat',
      efforts: ['high'],
      variants: { high: 'paid/chat-high' },
    })
    expect(visible[0]!.efforts).toBe(saved.efforts)
    expect(visible[0]!.variants).toBe(saved.variants)
    expect(resolveModel({ model: 'paid/chat-high', effort: 'high' }, raw).model).toBe('paid/chat-high')
    expect(() => resolveModel({ model: 'free/chat', effort: 'high' }, raw)).toThrow('不可用')
  })

  it('does not infer free from labels, missing cost or unknown subscription pricing', () => {
    const raw: ModelChoice[] = [
      { id: 'native/unknown-free-label', label: 'FREE Chat', cost: 'unknown', efforts: ['default'] },
      { id: 'native/no-cost', label: 'Zero Chat', efforts: ['default'] },
      { id: 'native/paid', label: 'Subscription Chat', cost: 'paid', efforts: ['default'] },
      { id: 'native/free', label: 'Confirmed Chat', cost: 'free', efforts: ['default'] },
    ]
    expect(visibleModelChoices(raw).map((model) => model.id)).toEqual([
      'native/free',
      ...raw.slice(0, 3).map((model) => model.id),
    ])
  })

  it('keeps distinct native versions despite matching labels and produces reversible clean options', () => {
    const raw: ModelChoice[] = [
      { id: 'native/GLM-5.3', label: 'GLM (provider)', efforts: ['default'] },
      { id: 'native/GLM-5.3-Flash', label: 'GLM (provider)', efforts: ['default'] },
      { id: 'native/GLM-5.3-202610', label: 'GLM (provider)', efforts: ['default'] },
    ]
    const visible = visibleModelChoices(raw)
    expect(visible.map((model) => model.label)).toEqual(['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.3-202610'])
    expect(visible.map((model) => model.id)).toEqual(raw.map((model) => model.id))
    const colliding = visibleModelChoices([
      { id: 'native/model (a)', label: 'Same (a)' },
      { id: 'native/model (b)', label: 'Same (b)' },
    ])
    expect(new Set(colliding.map((model) => model.label)).size).toBe(2)
    expect(colliding.map((model) => model.label).join(' ')).not.toContain('native')
    expect(colliding.map((model) => model.id)).toEqual(['native/model (a)', 'native/model (b)'])
  })

  it('keeps legal parentheses in native model identities while dropping separate provider annotations', () => {
    const raw: ModelChoice[] = [
      { id: 'native/model(v1)', label: 'Model v1（provider）', efforts: ['default'] },
      { id: 'native/model(v2)', label: 'Model v2（provider）', efforts: ['default'] },
    ]
    const visible = visibleModelChoices(raw)
    expect(visible.map((model) => model.label)).toEqual(['Model v1', 'Model v2'])
    expect(visible.map((model) => model.id)).toEqual(raw.map((model) => model.id))
    expect(resolveModel({ model: 'native/model(v1)', effort: 'default' }, raw).model).toBe('native/model(v1)')
  })
})
