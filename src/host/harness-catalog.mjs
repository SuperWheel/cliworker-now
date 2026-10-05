// Native ACP catalog only. This program never sends session/prompt.
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

process.umask(0o077)
const [executable, overlay, cwd] = process.argv.slice(2)
if (!executable || !overlay || !cwd || process.argv.length !== 5) throw new Error('Invalid catalog arguments')
const child = spawn(executable, ['--profile', 'acp', '--patch', overlay], {
  cwd,
  env: process.env,
  detached: false,
  stdio: ['pipe', 'pipe', 'pipe'],
})
const decoder = new StringDecoder('utf8'),
  waiting = new Map()
let pending = '',
  bytes = 0,
  sequence = 0,
  closed = false,
  failure
let stage = 'initialize'
const done = new Promise((resolve) =>
  child.once('close', (code, signal) => {
    closed = true
    for (const { reject } of waiting.values()) reject(new Error('ACP exited before catalog reply'))
    waiting.clear()
    resolve({ code, signal })
  }),
)
function abort(message) {
  failure ??= new Error(message)
  for (const { reject } of waiting.values()) reject(failure)
  waiting.clear()
  child.kill('SIGTERM')
}
child.on('error', () => abort('Unable to start Harness catalog'))
child.stdin.on('error', () => abort('Harness catalog input closed'))
const timeout = setTimeout(() => abort('Harness catalog timeout'), 12000)
const hardTimeout = setTimeout(() => child.kill('SIGKILL'), 14000)
const interrupt = () => abort('Harness catalog interrupted')
process.on('SIGTERM', interrupt)
process.on('SIGINT', interrupt)
function receive(chunk, stderr = false) {
  bytes += chunk.length
  if (bytes > 4194304) return abort('Harness catalog output exceeds limit')
  if (stderr) return
  pending += decoder.write(chunk)
  if (Buffer.byteLength(pending) > 2097152) return abort('Harness catalog event exceeds limit')
  let end
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end).trim()
    pending = pending.slice(end + 1)
    if (!line) continue
    try {
      const message = JSON.parse(line)
      if (message.jsonrpc !== '2.0') throw new Error('Invalid ACP message')
      if (message.method && message.id !== undefined) {
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Catalog is read only' },
          }) + '\n',
        )
      } else if (message.id !== undefined) {
        const waiter = waiting.get(message.id)
        if (!waiter) throw new Error('Unexpected ACP reply')
        waiting.delete(message.id)
        if (message.error) waiter.reject(new Error('Harness rejected catalog request'))
        else waiter.resolve(message.result)
      }
    } catch {
      abort('Invalid Harness ACP catalog event')
    }
  }
}
child.stdout.on('data', (x) => receive(x))
child.stderr.on('data', (x) => receive(x, true))
function rpc(method, params) {
  if (closed || failure) return Promise.reject(failure ?? new Error('ACP closed'))
  const id = ++sequence
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
const option = (options, id) => options?.find((x) => x.id === id)
function flatten(options) {
  if (!Array.isArray(options)) throw new Error('Missing model options')
  return options.flatMap((x) => (Array.isArray(x.options) ? flatten(x.options) : [x]))
}
try {
  const init = await rpc('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'cliworker-catalog', version: '1' },
  })
  if (init?.protocolVersion !== 1) throw new Error('Unsupported Harness ACP version')
  const session = await rpc('session/new', { cwd, mcpServers: [] })
  if (typeof session?.sessionId !== 'string' || !session.sessionId)
    throw new Error('Missing catalog session identity')
  stage = 'model directory'
  const choices = flatten(option(session.configOptions, 'model')?.options).filter((x) => {
    try {
      const id = JSON.parse(x.value)
      return Array.isArray(id) && id.length === 2 && id[0] === 'zai-coding-cn' && typeof id[1] === 'string'
    } catch {
      return false
    }
  })
  if (!choices.length || choices.length > 64) throw new Error('Invalid Harness provider catalog')
  const models = []
  for (const model of choices) {
    stage = 'model options'
    const selected = await rpc('session/set_config_option', {
      sessionId: session.sessionId,
      configId: 'model',
      value: model.value,
    })
    if (option(selected.configOptions, 'model')?.currentValue !== model.value)
      throw new Error('Harness changed model selection')
    const levels = option(selected.configOptions, 'reasoning_effort')?.options
    // Harness names disabled reasoning "off"; the shared UI names that level "none".
    const efforts = levels
      ? flatten(levels).map((x) => (x.value === '' ? 'default' : x.value === 'off' ? 'none' : x.value))
      : ['default']
    if (
      !efforts.length ||
      efforts.some(
        (x) => !['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(x),
      )
    )
      throw new Error('Harness returned unsupported reasoning level')
    models.push({
      id: model.value,
      label: `${model.name ?? JSON.parse(model.value)[1]}（智谱 Coding CN）`,
      efforts,
    })
  }
  await rpc('session/close', { sessionId: session.sessionId })
  child.stdin.end()
  const outcome = await done
  if (failure || outcome.code !== 0 || pending.trim())
    throw new Error('Harness catalog did not finish cleanly')
  process.stdout.write(JSON.stringify(models) + '\n')
} catch (error) {
  process.stderr.write(
    `Harness 原生模型目录查询失败（${stage}: ${error.message}）；请检查 CLI 版本和 provider 配置。\n`,
  )
  process.exitCode = 1
} finally {
  child.stdin.end()
  if (!closed) child.kill('SIGTERM')
  const force = setTimeout(() => {
    if (!closed) child.kill('SIGKILL')
  }, 1000)
  await done
  clearTimeout(force)
  clearTimeout(timeout)
  clearTimeout(hardTimeout)
  process.off('SIGTERM', interrupt)
  process.off('SIGINT', interrupt)
}
