// Native ACP initialize only: no session creation, auth request or prompt.
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

process.umask(0o077)
const [executable, cwd] = process.argv.slice(2)
if (!executable || !cwd || process.argv.length !== 4) throw new Error('Invalid catalog arguments')
const child = spawn(executable, ['agent', '--no-leader', 'stdio'], {
  cwd,
  env: process.env,
  detached: false,
  stdio: ['pipe', 'pipe', 'pipe'],
})
const decoder = new StringDecoder('utf8')
let pending = '',
  bytes = 0,
  closed = false,
  received = false,
  models,
  failure
let complete, reject
const reply = new Promise((resolve, fail) => {
  complete = resolve
  reject = fail
})
void reply.catch(() => {})
const done = new Promise((resolve) =>
  child.once('close', (code, signal) => {
    closed = true
    if (!received) reject(new Error('Grok closed before initialize reply'))
    resolve({ code, signal })
  }),
)
function abort(message) {
  failure ??= new Error(message)
  reject(failure)
  child.kill('SIGTERM')
}
child.on('error', () => abort('Unable to start Grok catalog'))
child.stdin.on('error', () => abort('Grok catalog input closed'))
const interrupt = () => abort('Grok catalog interrupted')
process.on('SIGTERM', interrupt)
process.on('SIGINT', interrupt)
const timeout = setTimeout(() => abort('Grok catalog timeout'), 10000)
const hardTimeout = setTimeout(() => child.kill('SIGKILL'), 12000)
function receive(chunk, stderr = false) {
  bytes += chunk.length
  if (bytes > 2097152) return abort('Grok catalog output exceeds limit')
  if (stderr) return
  pending += decoder.write(chunk)
  if (Buffer.byteLength(pending) > 1048576) return abort('Grok catalog event exceeds limit')
  let end
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end).trim()
    pending = pending.slice(end + 1)
    if (!line) continue
    try {
      const e = JSON.parse(line)
      if (e.jsonrpc !== '2.0') throw new Error('Invalid ACP reply')
      if (e.method && e.id !== undefined) {
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: e.id,
            error: { code: -32601, message: 'Catalog is read only' },
          }) + '\n',
        )
      } else if (e.id !== undefined) {
        if (received || e.id !== 1 || e.error || e.result?.protocolVersion !== 1)
          throw new Error('Invalid initialize response')
        received = true
        const state = e.result?._meta?.modelState
        if (!Array.isArray(state?.availableModels) || !state.availableModels.length)
          throw new Error('Missing Grok models')
        models = state.availableModels.map((model) => {
          if (typeof model.modelId !== 'string' || !model.modelId) throw new Error('Missing Grok model ID')
          const meta = model._meta
          const efforts =
            meta?.supportsReasoningEffort === false
              ? ['default']
              : Array.isArray(meta?.reasoningEfforts)
                ? meta.reasoningEfforts.map((x) => x.id)
                : []
          if (
            !efforts.length ||
            efforts.some(
              (x) =>
                !['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(x),
            )
          )
            throw new Error('Unsupported Grok reasoning directory')
          return {
            id: model.modelId,
            label: typeof model.name === 'string' ? model.name : model.modelId,
            efforts,
          }
        })
        complete()
      }
    } catch {
      abort('Invalid Grok ACP model directory')
    }
  }
}
child.stdout.on('data', (x) => receive(x))
child.stderr.on('data', (x) => receive(x, true))
try {
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'cliworker-catalog', version: '1' },
      },
    }) + '\n',
  )
  await reply
  child.stdin.end()
  // Grok stdio may remain idle after EOF. Stop the read-only agent explicitly.
  if (!closed) child.kill('SIGTERM')
  const outcome = await done
  if (failure || (![0, 143].includes(outcome.code) && outcome.signal !== 'SIGTERM') || pending.trim())
    throw new Error('Grok catalog did not close cleanly')
  process.stdout.write(JSON.stringify(models) + '\n')
} catch {
  process.stderr.write('Grok 原生模型目录查询失败；请检查 CLI 版本。\n')
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
