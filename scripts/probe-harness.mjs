// Retired external Harness CLI probe, retained only as historical verification evidence.
throw new Error('External Harness CLI was removed in v0.6.0; use the Hermes integration instead')
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

process.umask(0o077)
if (process.platform !== 'darwin') throw new Error('Requires the macOS sandbox')
const smoke = process.argv.length === 3 && process.argv[2] === '--smoke'
const stopNative = process.argv.length === 3 && process.argv[2] === '--stop-native'
const catalog = process.argv.length === 3 && process.argv[2] === '--catalog'
const configured = smoke || stopNative || catalog
if (process.argv.length > 2 && !configured)
  throw new Error('Use offline discovery, --catalog, --smoke, or --stop-native')
const selection = {
  provider: process.env.CLIWORKER_HARNESS_PROVIDER,
  model: process.env.CLIWORKER_HARNESS_MODEL,
  reasoningEffort: process.env.CLIWORKER_HARNESS_EFFORT,
}
if (
  configured &&
  (selection.provider !== 'zai-coding-cn' ||
    selection.model !== 'glm-5.3-flash' ||
    selection.reasoningEffort !== 'low')
)
  throw new Error('Explicit authorized zai-coding-cn/glm-5.3-flash/low selection required')
const cli = realpathSync('node_modules/@deepseek-ai/dsh/lib/bin.js')
const parent = resolve('.test-data/harness-probe')
mkdirSync(parent, { recursive: true, mode: 0o700 })
const root = realpathSync(mkdtempSync(join(parent, 'run-')))
const workspace = join(root, 'workspace')
const profileHome = join(root, 'home')
const tmp = realpathSync(mkdtempSync('/private/tmp/dsh-probe-'))
for (const p of [workspace, profileHome]) mkdirSync(p, { mode: 0o700 })
const save = (name, data) =>
  writeFileSync(join(root, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', {
    mode: 0o600,
  })
const policy = `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(root)}) (subpath ${JSON.stringify(tmp)}) (literal "/dev/null"))\n`
save('sandbox.sb', policy + '(deny network*)\n(allow network* (local unix-socket))\n')
save('sandbox-network.sb', policy)
save('sandbox-readonly.sb', policy + `(deny file-write* (subpath ${JSON.stringify(workspace)}))\n`)
const env = Object.fromEntries(
  ['PATH', 'HOME', 'LANG', 'LC_ALL', 'USER', 'LOGNAME'].flatMap((k) =>
    process.env[k] ? [[k, process.env[k]]] : [],
  ),
)
Object.assign(env, {
  DSH_HOME: profileHome,
  DSH_TELEMETRY_DISABLED: 'true',
  DSH_PRIMARY_RUNTIME: '',
  DSH_PERMISSION_MODE: 'workspace-write',
  TMPDIR: tmp,
})
const credentialFile = join(homedir(), '.dsh/.credentials.yaml')
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const credentialBefore = configured ? hash(credentialFile) : null
if (configured)
  save('overlay.yml', [
    { id: 'credentials', config: { path: credentialFile, watch: false } },
    { id: 'llm-pi-ai', config: { providers: { 'zai-coding-cn': { apiKeyEnv: 'ZAI_CODING_CN_API_KEY' } } } },
    { id: 'agent-default-model', config: selection },
    { id: 'session-title-llm', disabled: true },
  ])
if (configured)
  save('overlay-acp.yml', [
    ...JSON.parse(readFileSync(join(root, 'overlay.yml'), 'utf8')),
    { id: 'acp', config: { provider: selection.provider, model: selection.model } },
  ])
const report = {
  date: new Date().toISOString(),
  cli,
  cliSha256: hash(cli),
  phase: stopNative
    ? 'native-sandbox-stop'
    : smoke
      ? 'real-smoke'
      : catalog
        ? 'configured-offline-catalog'
        : 'offline-discovery',
  selection: configured ? selection : undefined,
  promptTasksSent: 0,
  network: smoke || stopNative ? 'only-explicit-live-stages' : 'local-unix-sockets-only',
  records: [],
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
let interrupted = false
function snapshot() {
  const out = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=,comm='], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error('Cannot inspect process scope')
  return out.stdout.split('\n').flatMap((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/)
    return m ? [{ pid: +m[1], ppid: +m[2], pgid: +m[3], state: m[4], started: m[5], command: m[6] }] : []
  })
}
function kill(pid, sig, group = false) {
  if (!pid) return
  try {
    process.kill(group ? -pid : pid, sig)
  } catch (e) {
    if (e.code !== 'ESRCH') throw e
  }
}
function observe(pid, tracked) {
  const all = snapshot()
  const ids = new Set([
    pid,
    ...[...tracked.values()]
      .filter((p) => all.some((x) => x.pid === p.pid && x.started === p.started))
      .map((p) => p.pid),
  ])
  let changed = true
  while (changed) {
    changed = false
    for (const p of all)
      if (!ids.has(p.pid) && (ids.has(p.ppid) || p.pgid === pid)) {
        ids.add(p.pid)
        tracked.set(p.pid, p)
        changed = true
      }
  }
  return all.filter(
    (p) => !p.state.startsWith('Z') && (p.pgid === pid || tracked.get(p.pid)?.started === p.started),
  )
}
async function cleanup(pid, tracked) {
  if (!pid) return
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    kill(pid, sig, true)
    for (const p of observe(pid, tracked)) kill(p.pid, sig)
    for (let i = 0; i < 25 && observe(pid, tracked).length; i++) await pause(100)
    if (!observe(pid, tracked).length) return
  }
  throw new Error('Harness process scope still running')
}
async function run(
  name,
  args,
  {
    protocol = false,
    idleStop = false,
    expectedCode = 0,
    live = false,
    readonly = false,
    cancelBash = false,
    nativeSandbox = false,
    selectedCatalog = false,
    json = false,
  } = {},
) {
  if (interrupted) throw new Error('Probe interrupted; no further tasks allowed')
  if (nativeSandbox && (!stopNative || !live || !cancelBash))
    throw new Error('Native sandbox is allowed only for the explicit sleep cancellation stage')
  const child = spawn(
    nativeSandbox ? process.execPath : '/usr/bin/sandbox-exec',
    nativeSandbox
      ? [cli, ...args]
      : [
          '-f',
          join(root, live ? (readonly ? 'sandbox-readonly.sb' : 'sandbox-network.sb') : 'sandbox.sb'),
          process.execPath,
          cli,
          ...args,
        ],
    {
      cwd: workspace,
      env: { ...env, ...(readonly ? { DSH_PERMISSION_MODE: 'read-only' } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    },
  )
  const tracked = new Map()
  const events = [],
    replies = [],
    requests = []
  let stdout = '',
    stderr = '',
    pending = '',
    bytes = 0,
    timedOut = false,
    limited = false,
    invalidJson = false,
    stopRequested = false,
    sessionId,
    cancelTimer,
    descendantsAtStop = [],
    cleanupError
  const send = (id, method, params) => {
    requests.push(method)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  }
  const stop = () => {
    stopRequested = true
    kill(child.pid, 'SIGTERM', true)
  }
  const interrupt = () => {
    interrupted = true
    stop()
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const timeoutMs = live ? 120000 : 30000
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, timeoutMs)
  const hardTimer = setTimeout(() => kill(child.pid, 'SIGKILL', true), timeoutMs + 7000)
  const trackingTimer = setInterval(() => {
    try {
      observe(child.pid, tracked)
    } catch (e) {
      cleanupError = e.message
      stop()
    }
  }, 150)
  child.stdin.on('error', () => {})
  function lineReceived(line) {
    if (!line.trim()) return
    let value
    try {
      value = JSON.parse(line)
    } catch {
      invalidJson = true
      stop()
      return
    }
    events.push(value)
    if (
      cancelBash &&
      !cancelTimer &&
      value.type === 'tool_call' &&
      value.tool === 'bash' &&
      /\bsleep\s+30\b/.test(value.input?.command ?? '')
    ) {
      cancelTimer = setTimeout(() => {
        descendantsAtStop = observe(child.pid, tracked).filter((p) => p.pid !== child.pid)
        stop()
      }, 1000)
    }
    if (!protocol) return
    if (value.id !== undefined && value.method)
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: value.id,
          error: { code: -32601, message: 'Unsupported in offline probe' },
        }) + '\n',
      )
    else if (value.id !== undefined) {
      replies.push(value)
      if (value.error) {
        child.stdin.end()
        return
      }
      if (value.id === 1) {
        if (idleStop) stop()
        else send(2, 'session/new', { cwd: workspace, mcpServers: [] })
      } else if (value.id === 2) {
        sessionId = value.result?.sessionId
        if (typeof sessionId !== 'string') {
          invalidJson = true
          child.stdin.end()
        } else if (selectedCatalog)
          send(3, 'session/set_config_option', {
            sessionId,
            configId: 'reasoning_effort',
            value: selection.reasoningEffort,
          })
        else send(3, 'session/list', {})
      } else if (selectedCatalog && value.id === 3) send(4, 'session/list', {})
      else if (value.id === (selectedCatalog ? 4 : 3))
        send(selectedCatalog ? 5 : 4, 'session/close', { sessionId })
      else if (value.id === (selectedCatalog ? 5 : 4)) child.stdin.end()
    }
  }
  const receive = (chunk, error) => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 2097152) {
      limited = true
      stop()
      return
    }
    if (error) {
      stderr += chunk
      return
    }
    stdout += chunk
    if (!protocol && !json) return
    pending += chunk
    let end
    while ((end = pending.indexOf('\n')) >= 0) {
      lineReceived(pending.slice(0, end))
      pending = pending.slice(end + 1)
    }
  }
  child.stdout.setEncoding('utf8').on('data', (x) => receive(x, false))
  child.stderr.setEncoding('utf8').on('data', (x) => receive(x, true))
  if (protocol)
    send(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'cliworker-probe', version: '1' },
    })
  else child.stdin.end()
  let exitCode, exitSignal
  try {
    await new Promise((res, rej) => {
      child.once('error', rej)
      child.once('close', (code, sig) => {
        exitCode = code
        exitSignal = sig
        res()
      })
    })
    if (pending.trim()) lineReceived(pending)
  } finally {
    clearTimeout(timer)
    clearTimeout(hardTimer)
    clearTimeout(cancelTimer)
    clearInterval(trackingTimer)
    await cleanup(child.pid, tracked)
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    save(name + '.stdout', stdout)
    save(name + '.stderr', stderr)
  }
  const cancelledExit = stopRequested && (exitCode === 0 || exitCode === 143 || exitSignal === 'SIGTERM')
  const result = {
    name,
    sandboxMode: readonly ? 'read-only' : 'workspace-write',
    sandboxLayer: nativeSandbox ? 'harness-native-only' : 'outer-seatbelt-plus-harness-native',
    success:
      !timedOut &&
      !limited &&
      !invalidJson &&
      !cleanupError &&
      !interrupted &&
      (idleStop || cancelBash ? cancelledExit : exitCode === expectedCode) &&
      (!protocol ||
        (replies.length === (idleStop ? 1 : selectedCatalog ? 5 : 4) &&
          replies.every((x) => x.result !== undefined && !x.error))),
    exitCode,
    exitSignal,
    timedOut,
    limited,
    invalidJson,
    stopRequested,
    cleanupConfirmed: true,
    cleanupError,
    requests,
    sessionId,
    descendantCount: tracked.size,
    descendantsAtStop: descendantsAtStop.map(({ pid, ppid, pgid, command }) => ({
      pid,
      ppid,
      pgid,
      command,
    })),
    eventTypes: [...new Set(events.map((e) => e.type).filter(Boolean))],
  }
  if (protocol)
    result.configOptions = replies.find((e) => e.id === (selectedCatalog ? 3 : 2))?.result?.configOptions
  if (selectedCatalog)
    result.success &&=
      result.configOptions?.find((x) => x.id === 'model')?.currentValue ===
        JSON.stringify([selection.provider, selection.model]) &&
      result.configOptions?.find((x) => x.id === 'reasoning_effort')?.currentValue ===
        selection.reasoningEffort
  if (name === 'headless-usage-error')
    result.success &&= events.some(
      (e) => e.type === 'error' && e.message?.includes("unknown option '--invalid-cliworker-option'"),
    )
  if (live) {
    result.sessionId = events.find((e) => e.type === 'session')?.sessionId
    result.finalText = events.findLast((e) => e.type === 'final')?.text
    result.completed = events.some(
      (e) => e.type === 'status' && e.phase === 'turn_end' && e.reason?.kind === 'completed',
    )
    result.success &&= cancelBash
      ? descendantsAtStop.some((p) => /(^|\/)sleep$/.test(p.command)) && !result.completed
      : !!result.sessionId &&
        typeof result.finalText === 'string' &&
        result.completed &&
        !events.some((e) => e.type === 'error')
  }
  report.records.push(result)
  return { result, events }
}
function publish(result) {
  const { finalText, ...safe } = result
  console.log(JSON.stringify(safe))
}
function privateModes(path) {
  const s = lstatSync(path)
  if (s.isSymbolicLink()) return
  chmodSync(path, s.isDirectory() ? 0o700 : 0o600)
  if (s.isDirectory()) for (const f of readdirSync(path)) privateModes(join(path, f))
}
try {
  const guard = join(parent, 'guard-' + randomUUID())
  writeFileSync(guard, 'unchanged', { mode: 0o600 })
  try {
    const attempt = (target, policyName) =>
      spawnSync(
        '/usr/bin/sandbox-exec',
        [
          '-f',
          join(root, policyName),
          process.execPath,
          '-e',
          'require("node:fs").writeFileSync(process.argv[1],"changed")',
          target,
        ],
        { env, encoding: 'utf8', timeout: 5000 },
      ).status
    report.sandboxChecks = {
      insideWritable: attempt(join(root, 'write-check'), 'sandbox.sb') === 0,
      outsideWriteDenied: attempt(guard, 'sandbox.sb') !== 0 && readFileSync(guard, 'utf8') === 'unchanged',
      readOnlyWorkspaceDenied: attempt(join(workspace, 'denied-check'), 'sandbox-readonly.sb') !== 0,
    }
    if (Object.values(report.sandboxChecks).some((v) => !v)) throw new Error('Sandbox checks failed')
  } finally {
    unlinkSync(guard)
  }
  for (const [name, args, opts] of [
    ['version', ['--version'], {}],
    ['headless-help', ['--profile', 'headless', '--help'], {}],
    [
      'headless-usage-error',
      ['--profile', 'headless', '--json', '--invalid-cliworker-option'],
      { expectedCode: 1, json: true },
    ],
    ['acp-lifecycle', ['--profile', 'acp'], { protocol: true }],
    ['acp-idle-stop', ['--profile', 'acp'], { protocol: true, idleStop: true }],
  ])
    publish((await run(name, args, opts)).result)
  if (report.records.some((r) => !r.success)) throw new Error('Offline prerequisites failed')
  if (configured) {
    const catalogue = await run(
      'selected-model-catalog',
      ['--profile', 'acp', '--patch', join(root, 'overlay-acp.yml')],
      { protocol: true, selectedCatalog: true },
    )
    report.modelConfigOptions = catalogue.result.configOptions
    publish(catalogue.result)
    if (!catalogue.result.success) throw new Error('Configured ACP catalog failed')
  }
  if (smoke || stopNative) {
    const marker = 'HARNESS_' + randomUUID()
    const base = ['--profile', 'headless', '--patch', join(root, 'overlay.yml'), '--json']
    const task = async (name, prompt, opts = {}) => {
      report.promptTasksSent++
      return run(name, [...base, ...(opts.sessionId ? ['--session-id', opts.sessionId] : []), prompt], {
        live: true,
        json: true,
        ...opts,
      })
    }
    if (smoke) {
      const first = await task('initial', `Reply exactly ${marker}. Do not use tools.`)
      first.result.success &&= first.result.finalText?.trim() === marker
      publish(first.result)
      if (!first.result.success) throw new Error('Initial real response did not pass')
      const resumed = await task(
        'resume',
        'Repeat only the exact marker from the previous turn. Do not use tools.',
        { sessionId: first.result.sessionId },
      )
      resumed.result.sameSession = resumed.result.sessionId === first.result.sessionId
      resumed.result.success &&= resumed.result.sameSession && resumed.result.finalText?.trim() === marker
      publish(resumed.result)
      if (!resumed.result.success) throw new Error('Same-session resume did not pass')
      const target = join(workspace, 'artifact.json')
      const written = await task(
        'write',
        `Use write to create ${target} with exactly this JSON: ${JSON.stringify({ marker, value: 42 })}. Do not use bash. Reply DONE.`,
      )
      let actual
      try {
        actual = JSON.parse(readFileSync(target, 'utf8'))
      } catch {}
      const writeCall = written.events.find(
        (e) =>
          e.type === 'tool_call' &&
          e.tool === 'write' &&
          resolve(workspace, e.input?.file_path ?? '') === target,
      )
      written.result.artifactMatches =
        actual?.marker === marker && actual?.value === 42 && Object.keys(actual).length === 2
      written.result.writeCompleted =
        !!writeCall &&
        written.events.some(
          (e) => e.type === 'tool_result' && e.callId === writeCall.callId && e.status === 'completed',
        )
      written.result.success &&= written.result.artifactMatches && written.result.writeCompleted
      if (written.result.artifactMatches) written.result.artifactSha256 = hash(target)
      publish(written.result)
      if (!written.result.success) throw new Error('Actual Write artifact did not pass')
      const deniedTarget = join(workspace, 'denied.json')
      const denied = await task(
        'read-only-write',
        `Use write once to create ${deniedTarget} containing DENIAL_PROBE. If denied, do not retry or use another tool; report the refusal.`,
        { readonly: true },
      )
      const deniedCall = denied.events.find(
        (e) =>
          e.type === 'tool_call' &&
          e.tool === 'write' &&
          resolve(workspace, e.input?.file_path ?? '') === deniedTarget,
      )
      denied.result.fileAbsent = !existsSync(deniedTarget)
      denied.result.writeRejected =
        !!deniedCall &&
        denied.events.some(
          (e) => e.type === 'tool_result' && e.callId === deniedCall.callId && e.status === 'error',
        )
      denied.result.success &&= denied.result.fileAbsent && denied.result.writeRejected
      publish(denied.result)
      if (!denied.result.success) throw new Error('Read-only Write denial did not pass')
    }
    if (stopNative) {
      console.log(
        'Cancellation stage uses Harness native workspace-write sandbox; no nested Seatbelt and no danger-full-access.',
      )
      const stopped = await task(
        'active-bash-stop',
        'Use bash once to run exactly sleep 30. Do not use other tools. After it finishes reply DONE.',
        { cancelBash: true, nativeSandbox: true },
      )
      publish(stopped.result)
      if (!stopped.result.success) throw new Error('Running Bash descendant stop did not pass')
    }
  }
} catch (error) {
  report.error = error.message
  process.exitCode = 1
} finally {
  report.originalCredentialUnchanged = configured ? credentialBefore === hash(credentialFile) : undefined
  report.success =
    !report.error &&
    report.records.every((r) => r.success) &&
    (!configured || report.originalCredentialUnchanged)
  if (!report.success) process.exitCode = 1
  privateModes(root)
  privateModes(tmp)
  save('report.json', report)
  console.log(
    JSON.stringify({
      root,
      success: report.success,
      promptTasksSent: report.promptTasksSent,
      error: report.error,
    }),
  )
}
