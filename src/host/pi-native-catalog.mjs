// Native metadata only. No prompts, API keys, OAuth objects, headers or raw errors leave this boundary.
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export function projectNativeModel(model, cli) {
  if (
    !model ||
    typeof model.provider !== 'string' ||
    !/^[A-Za-z0-9_.:-]+$/.test(model.provider) ||
    typeof model.id !== 'string' ||
    !model.id ||
    /[\s\x00-\x1f]/.test(model.id)
  )
    throw new Error('Invalid native model identity')
  const efforts =
    cli === 'pi' && model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object'
      ? levels.filter((level) => model.thinkingLevelMap[level === 'none' ? 'off' : level] != null)
      : cli === 'omp' && (Array.isArray(model.thinking) || Array.isArray(model.thinking?.efforts))
        ? levels.filter((level) =>
            (Array.isArray(model.thinking) ? model.thinking : model.thinking.efforts).includes(
              level === 'none' ? 'off' : level,
            ),
          )
        : []
  return {
    id: `${model.provider}/${model.id}`,
    label: `${String(model.name ?? model.id)}（${model.provider}）`,
    efforts: efforts.length ? efforts : ['default'],
  }
}
export async function queryNativeCatalog(...args) {
  try {
    return await nativeCatalog(...args)
  } catch {
    throw new Error('无法读取 Pi/OMP 原生模型目录，请检查本机配置')
  }
}
async function nativeCatalog(cli, executable, directory, env = process.env, onChild = () => {}) {
  if (cli === 'pi') {
    const dist = dirname(executable)
    const manifest = JSON.parse(await readFile(join(dist, '../package.json'), 'utf8'))
    if (manifest.name !== '@earendil-works/pi-coding-agent' || manifest.version !== '1.0.2')
      throw new Error('Unsupported Pi catalog SDK version')
    const { ModelRuntime } = await import(pathToFileURL(join(dist, 'core/model-runtime.js')).href)
    const runtime = await ModelRuntime.create({
      authPath: join(directory, 'auth.json'),
      modelsPath: join(directory, 'models.json'),
      modelsStorePath: join(directory, 'models-store.json'),
      allowModelNetwork: false,
    })
    if (runtime.getError()) throw new Error('Invalid native Pi model config')
    return runtime.getAvailableSnapshot().map((model) => projectNativeModel(model, cli))
  }
  const args = ['models', '--json', '--no-extensions', '--config', join(directory, 'config.yml')]
  const js = /\.[cm]?js$/.test(executable)
  const child = spawn(js ? process.execPath : executable, js ? [executable, ...args] : args, {
    cwd: directory,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  onChild(child)
  let stdout = '',
    stderr = '',
    size = 0,
    errorSize = 0,
    timedOut = false
  child.stdout.on('data', (chunk) => {
    size += chunk.length
    if (size > 16 * 1024 * 1024) child.kill('SIGTERM')
    else stdout += chunk
  })
  // Native diagnostics can contain endpoint credentials. Drain without forwarding.
  child.stderr.on('data', (chunk) => {
    errorSize += chunk.length
    if (errorSize > 2 * 1024 * 1024) child.kill('SIGTERM')
    else stderr += chunk
  })
  let force
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    force = setTimeout(() => child.kill('SIGKILL'), 5000)
  }, 20000)
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Unable to start native catalog')))
    child.once('close', (code) => resolve(code))
  }).finally(() => {
    clearTimeout(timer)
    clearTimeout(force)
  })
  if (
    timedOut ||
    outcome !== 0 ||
    size > 16 * 1024 * 1024 ||
    errorSize > 2 * 1024 * 1024 ||
    /models\.yml validation failed/i.test(stderr)
  )
    throw new Error('Native OMP catalog query failed')
  const value = JSON.parse(stdout)
  const models = Array.isArray(value) ? value : value.models
  if (!Array.isArray(models)) throw new Error('Invalid native OMP catalog')
  return models.map((model) => projectNativeModel(model, cli))
}
