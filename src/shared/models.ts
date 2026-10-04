import { cliOf, EFFORTS, type ModelChoice, type Preference, type Effort } from './types.ts'

/** Only remove an exact, known effort suffix for Antigravity display. Execution keeps the raw ID. */
export function modelName(preference: Preference): string {
  return cliOf(preference) === 'antigravity' && preference.model.endsWith(`-${preference.effort}`)
    ? preference.model.slice(0, -preference.effort.length - 1)
    : preference.model
}

/** Group only variants explicitly advertised by the CLI, never infer missing levels. */
export function groupAgyModels(raw: ModelChoice[]): ModelChoice[] {
  const groups = new Map<string, ModelChoice>()
  for (const model of raw) {
    const effort = EFFORTS.find(
      (e) => e !== 'default' && model.id.endsWith(`-${e}`) && model.label.toLowerCase().endsWith(`(${e})`),
    )
    const id = effort ? model.id.slice(0, -effort.length - 1) : model.id
    const level: Effort = effort ?? 'default'
    const group = groups.get(id) ?? {
      id,
      label: effort ? model.label.replace(/\s*\([^()]+\)$/, '') : model.label,
      efforts: [],
      variants: {},
    }
    if (!group.efforts!.includes(level)) group.efforts!.push(level)
    group.variants![level] = model.id
    groups.set(id, group)
  }
  return [...groups.values()].map((m) => ({ ...m, efforts: EFFORTS.filter((e) => m.efforts!.includes(e)) }))
}

/** Accept old raw IDs and new grouped choices; return the exact executable preference. */
export function resolveModel(preference: Preference, models: ModelChoice[]): Preference {
  const model = models.find(
    (m) => m.id === preference.model || Object.values(m.variants ?? {}).includes(preference.model),
  )
  if (!model || !model.efforts?.includes(preference.effort))
    throw new Error('模型或思考强度已不可用，请重新选择')
  return { ...preference, model: model.variants?.[preference.effort] ?? model.id }
}
