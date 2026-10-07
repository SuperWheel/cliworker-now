import { modelName } from './models.ts'
import type { ModelChoice, Preference } from './types.ts'

/** Remove one declared route prefix; remaining slashes can belong to a native model ID. */
export function nativeModelName(id: string): string {
  const text = id.trim()
  if (text.startsWith('[')) {
    try {
      const parts: unknown = JSON.parse(text)
      if (Array.isArray(parts) && parts.length === 2 && parts.every((part) => typeof part === 'string'))
        return parts[1] as string
    } catch {
      /* Historical unknown formats remain readable without changing their ID. */
    }
  }
  const slash = text.indexOf('/')
  return slash > 0 && /^[A-Za-z0-9_.:-]+$/u.test(text.slice(0, slash)) ? text.slice(slash + 1) : text
}

function withoutAnnotations(name: string): string {
  let previous: string
  do {
    previous = name
    name = name.replace(/[（(][^()（）]*[)）]/gu, '')
  } while (previous !== name)
  return name
    .replace(/[（(].*$/u, '')
    .replace(/[)）]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** A presentation-only name. Never use the returned text as an execution/lookup ID. */
export function displayModelName(value: string | Preference | ModelChoice): string {
  // A raw ID has no provider annotation field. Parentheses can be part of its
  // legal native name, so strip annotations only from the catalog's label.
  if (typeof value === 'string') return nativeModelName(value) || '模型'
  if ('model' in value) return displayModelName(modelName(value))
  const label = withoutAnnotations(nativeModelName(value.label ?? '')).replace(/^Claude 官方模型别名\s+/u, '')
  return label || displayModelName(value.id)
}

const selectedRoute = (model: ModelChoice, selected?: string) =>
  !!selected && (model.id === selected || Object.values(model.variants ?? {}).includes(selected))
const freeRank = (model: ModelChoice) => (model.cost === 'free' ? 0 : 1)
const normalizedId = (model: ModelChoice) => nativeModelName(model.id).trim().toLowerCase()

/**
 * Present an already-filtered native catalog. Keep the complete raw catalog for
 * validation. A group selects one whole route, never a union of capabilities.
 */
export function visibleModelChoices(raw: readonly ModelChoice[], selectedFullId?: string): ModelChoice[] {
  const groups = new Map<string, { model: ModelChoice; order: number }>()
  raw.forEach((model, order) => {
    const key = normalizedId(model)
    const current = groups.get(key)
    if (!current) {
      groups.set(key, { model, order })
      return
    }
    if (
      selectedRoute(model, selectedFullId) ||
      (!selectedRoute(current.model, selectedFullId) && freeRank(model) < freeRank(current.model))
    )
      current.model = model
  })
  const visible = [...groups.values()]
    .sort((a, b) => freeRank(a.model) - freeRank(b.model) || a.order - b.order)
    .map(({ model }) => ({ ...model, label: displayModelName(model) }))
  const labelCounts = new Map<string, number>()
  for (const model of visible) {
    const key = model.label.toLowerCase()
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1)
  }
  // Distinct native versions may share a friendly name. Keep separate, clean,
  // reversible choices instead of coalescing them by that presentation string.
  for (const model of visible)
    if (labelCounts.get(model.label.toLowerCase())! > 1) model.label = displayModelName(model.id)
  const used = new Set<string>()
  for (const model of visible) {
    const base = model.label
    let suffix = 1
    while (used.has(model.label.toLowerCase())) model.label = `${base} · ${++suffix}`
    used.add(model.label.toLowerCase())
  }
  return visible
}
