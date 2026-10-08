// Pi 1.0.2 / 1.0.4 native UI compatibility entry. No initial prompt, injected keystrokes,
// model request, or subscription validation: open its own provider login menu.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectPiInstallation } from './pi-installation.mjs'

process.umask(0o077)
try {
  const executable = process.argv[2]
  const action = process.argv[3] ?? 'login'
  if (!['login', 'logout'].includes(action)) throw new Error('Invalid account action')
  if (!executable) throw new Error('Missing Pi entry')
  const { dist } = inspectPiInstallation(executable)
  const {
    createAgentSessionServices,
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    SessionManager,
    InteractiveMode,
    ModelRuntime,
  } = await import(pathToFileURL(join(dist, 'index.js')).href)
  if (
    [
      createAgentSessionServices,
      createAgentSessionFromServices,
      createAgentSessionRuntime,
      SessionManager?.inMemory,
      InteractiveMode,
    ].some((entry) => typeof entry !== 'function') ||
    ['init', action === 'logout' ? 'showOAuthSelector' : 'handleLoginCommand', 'run'].some(
      (method) => typeof InteractiveMode.prototype[method] !== 'function',
    )
  )
    throw new Error('Unsupported Pi login SDK capabilities')
  const cwd = process.cwd(),
    agentDir = process.env.PI_CODING_AGENT_DIR
  const runtime = await createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        ...(action === 'logout'
          ? {
              modelRuntime: await ModelRuntime.create({
                authPath: process.argv[4],
                modelsPath: null,
                modelsStorePath: join(agentDir, 'models-store.json'),
                refreshOnCreate: false,
                allowModelNetwork: false,
              }),
            }
          : {}),
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      })
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        noTools: 'all',
        tools: [],
      })
      return { ...created, services, diagnostics: services.diagnostics }
    },
    { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
  )
  const ui = new InteractiveMode(runtime)
  await ui.init()
  if (action === 'logout') await ui.showOAuthSelector('logout')
  else await ui.handleLoginCommand()
  await ui.run()
} catch {
  // Native errors can contain authentication data. Keep this boundary generic.
  process.stderr.write('无法打开 Pi 原生账号界面，请检查 Pi Coding Agent 安装与受支持的原生接口。\n')
  process.exitCode = 1
}
