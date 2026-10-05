// Pi 1.0.2 native UI compatibility entry. No initial prompt, injected keystrokes,
// model request, or subscription validation: open its own provider login menu.
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'

process.umask(0o077)
try {
  const executable = process.argv[2]
  if (!executable) throw new Error('Missing Pi entry')
  const dist = dirname(executable)
  const manifest = JSON.parse(await readFile(join(dist, '../package.json'), 'utf8'))
  if (manifest.name !== '@earendil-works/pi-coding-agent' || manifest.version !== '1.0.2')
    throw new Error('Unsupported Pi login UI version')
  const {
    createAgentSessionServices,
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    SessionManager,
    InteractiveMode,
  } = await import(pathToFileURL(join(dist, 'index.js')).href)
  const cwd = process.cwd(),
    agentDir = process.env.PI_CODING_AGENT_DIR
  const runtime = await createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
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
  if (typeof ui.handleLoginCommand !== 'function') throw new Error('Missing Pi login UI')
  await ui.init()
  await ui.handleLoginCommand()
  await ui.run()
} catch {
  // Native errors can contain authentication data. Keep this boundary generic.
  process.stderr.write('无法打开 Pi 原生登录界面，请检查 Pi 1.0.2 安装。\n')
  process.exitCode = 1
}
