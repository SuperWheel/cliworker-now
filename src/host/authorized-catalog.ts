import { catalogFor, validatePreference, type Catalog } from './adapters.ts'
import { readCliAccountBinding } from './cli-account-binding.ts'
import { resolveModel } from '../shared/models.ts'
import { cliOf, type CliId, type Preference } from '../shared/types.ts'
import type { ProcessBackend, RuntimeConfig } from './process.ts'

export const ACCOUNT_CHANGED = '账号已变更，请重新选择或新建任务'

/** Private authorization state: never spread this object into a Remote response. */
export async function authorizedCatalog(
  cli: CliId,
  backend: ProcessBackend,
  config: RuntimeConfig,
  project: string,
  signal: AbortSignal,
  expected?: string,
): Promise<{ catalog: Catalog; binding: string }> {
  const binding = await readCliAccountBinding(cli, backend, config, project, signal)
  if (expected && binding !== expected) throw new Error(ACCOUNT_CHANGED)
  const catalog = await catalogFor(cli, backend, config, project, signal)
  signal.throwIfAborted()
  if (binding !== (await readCliAccountBinding(cli, backend, config, project, signal)))
    throw new Error(ACCOUNT_CHANGED)
  if (catalog.cli !== cli) throw new Error('CLI 模型目录身份不匹配')
  if (!catalog.models.length) throw new Error('暂无可确认的可用模型，请登录或刷新')
  return { catalog, binding }
}

export async function authorizeSelection(
  preference: Preference,
  backend: ProcessBackend,
  config: RuntimeConfig,
  project: string,
  signal: AbortSignal,
  expected?: string,
) {
  const result = await authorizedCatalog(cliOf(preference), backend, config, project, signal, expected)
  validatePreference(preference, result.catalog)
  return { ...result, preference: resolveModel(preference, result.catalog.models) }
}
