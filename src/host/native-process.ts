import { nativeLaunchArgv, resolveNativeEntry } from './native-launch.mjs'
import type { ProcessBackend } from './process.ts'

/** One normalization boundary for tasks, metadata and interactive account menus. */
export function nativeProcessBackend(backend: ProcessBackend, platform = process.platform): ProcessBackend {
  const normalize = <T extends { argv: readonly string[]; env?: NodeJS.ProcessEnv }>(spec: T) => {
    const argv = nativeLaunchArgv(spec.argv, platform)
    return {
      ...spec,
      argv,
      ...(argv[0] === process.execPath ? { env: { ...spec.env, ELECTRON_RUN_AS_NODE: '1' } } : {}),
    }
  }
  return {
    async resolveExecutable(name) {
      return resolveNativeEntry(await backend.resolveExecutable(resolveNativeEntry(name, platform)), platform)
    },
    spawn(spec) {
      return backend.spawn(normalize(spec))
    },
    ...(backend.spawnTerminal
      ? {
          spawnTerminal: (spec: Parameters<NonNullable<ProcessBackend['spawnTerminal']>>[0]) =>
            backend.spawnTerminal!(normalize(spec)),
        }
      : {}),
  }
}
