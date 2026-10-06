import { describe, expect, it } from 'vitest'
import { BUILTIN_ROLE_PRESETS } from '../src/shared/builtin-presets.ts'
import { rolePresetSchema } from '../src/host/roles.ts'

describe('portable imported novel roles', () => {
  it('ships all seven distinct source roles as valid editable, serializable records', () => {
    const sources = [
      'novel-audit-commercial-review',
      'novel-audit-logic-check',
      'novel-audit-style-review',
      'novel-revise',
      'novel-start-plot-node',
      'novel-start-plot-split',
      'novel-write',
    ]
    expect(BUILTIN_ROLE_PRESETS).toHaveLength(sources.length)
    expect(new Set(BUILTIN_ROLE_PRESETS.map((role) => role.id)).size).toBe(sources.length)
    expect(new Set(BUILTIN_ROLE_PRESETS.map((role) => role.name)).size).toBe(sources.length)
    expect(BUILTIN_ROLE_PRESETS.map((role) => role.source).sort()).toEqual(sources.sort())
    for (const preset of JSON.parse(JSON.stringify(BUILTIN_ROLE_PRESETS))) {
      expect(rolePresetSchema.parse(preset)).toEqual(preset)
      expect(preset.builtin).toBe(true)
      expect(preset.name).toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it('does not bundle the author’s private paths or assume optional source tooling exists', () => {
    for (const { prompt } of BUILTIN_ROLE_PRESETS) {
      expect(prompt).not.toMatch(/\/Users\/|\/home\/|agy-run\.sh|--output-dir|allowed-tools:/)
      expect(prompt).toContain('不要假定原技能的文件、脚本、检索服务或其他智能体已经安装')
      expect(prompt).toContain('不得宣称已运行未运行的检查')
      expect(prompt).toContain('不要自行切换模型、CLI 或另派子智能体')
    }
  })

  it('keeps the editorial, proposal, draft and authorized revision roles separate', () => {
    const roles = new Map(BUILTIN_ROLE_PRESETS.map((role) => [role.id, role.prompt]))
    for (const id of [
      'novel-audit-commercial-review',
      'novel-audit-logic-check',
      'novel-audit-style-review',
    ]) {
      expect(roles.get(id)).toMatch(/只报告[\s\S]*不修改正文/)
    }
    for (const id of ['novel-start-plot-node', 'novel-start-plot-split']) {
      expect(roles.get(id)).toContain('提案')
      expect(roles.get(id)).toContain('等待作者确认')
    }
    expect(roles.get('novel-write')).toContain('不修改既有待审、修订、锁定或已发布正文')
    expect(roles.get('novel-revise')).toContain('confirmed 不等于授权')
    expect(roles.get('novel-revise')).toContain('C 级保护')
    expect(roles.get('novel-revise')).toContain('D 级额外发现')
  })
})
