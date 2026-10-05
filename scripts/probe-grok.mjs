// Grok Build probe: default offline discovery; no plugin/runtime installation.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

process.umask(0o077)
if (process.platform !== 'darwin') throw new Error('This probe requires the macOS sandbox')
const modes = process.argv.slice(2)
if (modes.length > 1 || modes.some((m) => m !== '--catalog'))
  throw new Error('Use no flag or --catalog. Real model execution is deliberately not implemented.')
const live = modes.length > 0
const cli = realpathSync(process.env.CLIWORKER_GROK_ENTRY ?? join(homedir(), '.grok/bin/grok'))
const parent = resolve('.test-data/grok-probe')
mkdirSync(parent, { recursive: true, mode: 0o700 })
chmodSync(parent, 0o700)
const root = realpathSync(mkdtempSync(join(parent, 'run-')))
const workspace = join(root, 'workspace')
const state = join(root, 'grok-home')
const tmp = realpathSync(mkdtempSync('/private/tmp/gr-probe-'))
for (const path of [root, workspace, state, tmp]) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}
const save = (name, data) =>
  writeFileSync(join(root, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', {
    mode: 0o600,
  })
writeFileSync(
  join(state, 'config.toml'),
  `[cli]\nauto_update = false\nuse_leader = false\n[features]\nsupport_permission = true\ntelemetry = false\nfeedback = false\ncodebase_indexing = false\n[telemetry]\ntrace_upload = false\nmixpanel_enabled = false\n[subagents]\nenabled = false\n[session]\nload_envrc = false\n[shell_environment_policy]\ninherit = "core"\nignore_default_excludes = false\n`,
  { mode: 0o600 },
)
// Native CLI reads its original auth file through a read-only symlink. Never copy,
// decode, print, or rewrite credentials. A refresh that needs original writes fails.
const auth = join(homedir(), '.grok/auth.json')
if (live && existsSync(auth)) symlinkSync(auth, join(state, 'auth.json'))
const env = Object.fromEntries(
  ['PATH', 'HOME', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL'].flatMap((k) =>
    process.env[k] ? [[k, process.env[k]]] : [],
  ),
)
Object.assign(env, {
  GROK_HOME: state,
  TMPDIR: tmp,
  GROK_MEMORY: '0',
  GROK_SUBAGENTS: '0',
  GROK_WORKFLOWS: '0',
  GROK_WEB_FETCH: '0',
  GROK_TELEMETRY_ENABLED: '0',
  GROK_TELEMETRY_TRACE_UPLOAD: '0',
  GROK_TELEMETRY_MIXPANEL_ENABLED: '0',
})
const q = (s) => JSON.stringify(s)
const basePolicy = `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${q(root)})(subpath ${q(tmp)})(literal "/dev/null"))`
save('offline.sb', basePolicy + '(deny network*)(allow network* (local unix-socket))')
save('live.sb', basePolicy)
save('plan.sb', basePolicy + `(deny file-write* (subpath ${q(workspace)}))`)
const report = {
  createdAt: new Date().toISOString(),
  cli,
  cliSha256: createHash('sha256').update(readFileSync(cli)).digest('hex'),
  phase: live ? 'catalog' : 'offline',
  realExecution: 'skipped-by-user-no-subscription',
  modelTasksSent: 0,
  authFilePresent: existsSync(auth),
  records: [],
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
function members(pgid) {
  const ps = spawnSync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' })
  if (ps.status !== 0) throw new Error('Cannot verify process scope')
  return ps.stdout
    .trim()
    .split('\n')
    .map((r) => r.trim().split(/\s+/))
    .filter(([, group, status]) => Number(group) === pgid && !status.startsWith('Z'))
    .map(([pid]) => Number(pid))
}
function signal(pgid, sig) {
  try {
    process.kill(-pgid, sig)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}
async function cleanup(pgid) {
  if (members(pgid).length) signal(pgid, 'SIGTERM')
  for (let n = 0; n < 20 && members(pgid).length; n++) await delay(100)
  if (members(pgid).length) signal(pgid, 'SIGKILL')
  for (let n = 0; n < 20 && members(pgid).length; n++) await delay(100)
  if (members(pgid).length) throw new Error('Process group did not exit')
}
async function run(
  name,
  args,
  { network = false, plan = false, rpc = null, nextRpc = null, timeoutMs = network ? 90000 : 20000 } = {},
) {
  const entry = {
    name,
    args,
    network,
    plan,
    exitCode: null,
    signal: null,
    timedOut: false,
    outputLimitExceeded: false,
    malformedRpcLines: 0,
    processGroupEmpty: false,
    eventCount: 0,
    success: false,
  }
  report.records.push(entry)
  const proc = spawn(
    '/usr/bin/sandbox-exec',
    ['-f', join(root, plan ? 'plan.sb' : network ? 'live.sb' : 'offline.sb'), cli, ...args],
    { cwd: workspace, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const onInterrupt = () => signal(proc.pid, 'SIGTERM')
  process.on('SIGTERM', onInterrupt)
  process.on('SIGINT', onInterrupt)
  let stdout = '',
    stderr = '',
    pending = '',
    bytes = 0
  const events = []
  const write = (data) => {
    if (!proc.stdin.destroyed) proc.stdin.write(JSON.stringify(data) + '\n')
  }
  const timer = setTimeout(() => {
    entry.timedOut = true
    signal(proc.pid, 'SIGTERM')
  }, timeoutMs)
  const hardTimer = setTimeout(() => signal(proc.pid, 'SIGKILL'), timeoutMs + 5000)
  const onLine = (line) => {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      if (rpc && line.trim()) entry.malformedRpcLines++
      return
    }
    events.push(event)
    entry.eventCount++
    if (event.method && event.id !== undefined)
      write({
        jsonrpc: '2.0',
        id: event.id,
        error: { code: -32601, message: 'Unsupported reverse request in isolated probe' },
      })
    if (rpc && event.id === rpc.id && !event.method) {
      entry.rpc = event
      if (nextRpc && event.result) write(nextRpc)
      else signal(proc.pid, 'SIGTERM')
    }
    if (nextRpc && event.id === nextRpc.id && !event.method) {
      entry.nextRpc = event
      signal(proc.pid, 'SIGTERM')
    }
  }
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  function consume(chunk, out) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 2 * 1024 * 1024) {
      entry.outputLimitExceeded = true
      signal(proc.pid, 'SIGTERM')
      return
    }
    if (out) {
      stdout += chunk
      pending += chunk
      let i
      while ((i = pending.indexOf('\n')) >= 0) {
        onLine(pending.slice(0, i))
        pending = pending.slice(i + 1)
      }
    } else stderr += chunk
  }
  proc.stdout.on('data', (c) => consume(c, true))
  proc.stderr.on('data', (c) => consume(c, false))
  proc.stdin.on('error', () => {})
  if (rpc) write(rpc)
  else proc.stdin.end()
  try {
    await new Promise((res, rej) => {
      proc.on('error', rej)
      proc.on('close', (code, sig) => {
        entry.exitCode = code
        entry.signal = sig
        res()
      })
    })
    if (pending.trim()) onLine(pending)
  } finally {
    clearTimeout(timer)
    clearTimeout(hardTimer)
    await cleanup(proc.pid)
    entry.processGroupEmpty = true
    process.off('SIGTERM', onInterrupt)
    process.off('SIGINT', onInterrupt)
    save(name + '.stdout', stdout)
    save(name + '.stderr', stderr)
  }
  entry.success =
    !entry.timedOut &&
    !entry.outputLimitExceeded &&
    entry.processGroupEmpty &&
    (rpc
      ? !!entry.rpc?.result &&
        (!nextRpc || !!entry.nextRpc?.result) &&
        entry.malformedRpcLines === 0 &&
        (entry.exitCode === 143 || entry.signal === 'SIGTERM')
      : entry.exitCode === 0)
  return { entry, stdout, stderr, events }
}
function sandboxChecks() {
  const outside = join(parent, 'sentinel-' + randomUUID())
  writeFileSync(outside, 'original', { mode: 0o600 })
  const attempt = (path, policy) =>
    spawnSync(
      '/usr/bin/sandbox-exec',
      [
        '-f',
        join(root, policy),
        process.execPath,
        '-e',
        'require("node:fs").writeFileSync(process.argv[1],"changed")',
        path,
      ],
      { env, encoding: 'utf8' },
    ).status === 0
  report.sandbox = {
    privateWrite: attempt(join(root, 'write-check'), 'offline.sb'),
    outsideWriteDenied: !attempt(outside, 'offline.sb') && readFileSync(outside, 'utf8') === 'original',
    planWriteDenied: !attempt(join(workspace, 'plan-write-check'), 'plan.sb'),
  }
  if (Object.values(report.sandbox).some((v) => !v)) throw new Error('Sandbox boundary check failed')
}
try {
  sandboxChecks()
  await run('version', ['--version'])
  await run('help', ['--help'])
  const catalog = await run('models', ['models'], { network: live })
  report.catalog = {
    networkAllowed: live,
    nativeReportsUnauthenticated: /You are not authenticated/.test(catalog.stdout + catalog.stderr),
    ids: [...catalog.stdout.matchAll(/^\s*\*\s+(\S+)/gm)].map((m) => m[1]),
    accountEntitlementVerified: false,
  }
  const init = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientInfo: { name: 'cliworker-grok-probe', version: '0.1.0' },
      clientCapabilities: {},
    },
  }
  const initialized = await run('acp-initialize', ['agent', '--no-leader', 'stdio'], {
    rpc: init,
  })
  report.modelState = initialized.entry.rpc?.result?._meta?.modelState ?? null
  await run('acp-session-list', ['agent', '--no-leader', 'stdio'], {
    rpc: init,
    nextRpc: { jsonrpc: '2.0', id: 2, method: 'session/list', params: { cwd: workspace } },
  })
} catch (error) {
  report.error = error.message
  process.exitCode = 1
}
report.success = !report.error && report.records.every((r) => r.success)
if (!report.success) process.exitCode = 1
// Some CLI-created documentation files use explicit modes. Normalize only this
// private profile; never traverse the symlink to native credentials.
function privatize(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) return
  chmodSync(path, stat.isDirectory() ? 0o700 : 0o600)
  if (stat.isDirectory()) for (const name of readdirSync(path)) privatize(join(path, name))
}
privatize(root)
privatize(tmp)
save('report.json', report)
console.log(
  JSON.stringify(
    {
      root,
      success: report.success,
      phase: report.phase,
      realExecution: report.realExecution,
      modelTasksSent: 0,
      catalog: report.catalog,
      modelState: report.modelState,
      sandbox: report.sandbox,
      records: report.records.map(({ rpc, nextRpc, ...rest }) => rest),
      error: report.error,
    },
    null,
    2,
  ),
)
