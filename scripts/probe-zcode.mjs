// Opt-in local ZCode feasibility probe. Does not install or update the plugin.
// Runtime output and databases are private, ignored .test-data artifacts.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

process.umask(0o077)
if (process.platform !== 'darwin') throw new Error('This probe currently requires the macOS sandbox')
const cli = realpathSync(
  process.env.CLIWORKER_ZCODE_ENTRY ?? '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
)
const adjacentBuiltin = join(dirname(cli), 'provider/zcode-builtin.json')
const builtin =
  process.env.CLIWORKER_ZCODE_BUILTIN_CONFIG ??
  (existsSync(adjacentBuiltin)
    ? adjacentBuiltin
    : '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json')
if (
  process.argv.slice(2).length > 1 ||
  process.argv.slice(2).some((arg) => !['--smoke', '--login', '--login-bigmodel'].includes(arg))
)
  throw new Error('Use one mode: default offline discovery, --smoke, --login, or --login-bigmodel')
const smoke = process.argv.includes('--smoke')
const login = process.argv.includes('--login') || process.argv.includes('--login-bigmodel')
const selectedModel = process.env.CLIWORKER_ZCODE_MODEL
const selectedProvider = process.env.CLIWORKER_ZCODE_PROVIDER
const selectedEffort = process.env.CLIWORKER_ZCODE_EFFORT
if (smoke && (!selectedModel || !selectedProvider || !selectedEffort))
  throw new Error('Real smoke requires explicitly selected provider, model, and a verified reasoning level')
const parent = resolve('.test-data/zcode-probe')
mkdirSync(parent, { recursive: true, mode: 0o700 })
const root = realpathSync(mkdtempSync(join(parent, 'run-')))
const authBase = process.env.CLIWORKER_ZCODE_AUTH_BASE
  ? realpathSync(process.env.CLIWORKER_ZCODE_AUTH_BASE)
  : homedir()
const isolatedAuth =
  authBase.startsWith(realpathSync(parent) + '/run-') &&
  readFileSync(join(authBase, 'sandbox.sb'), 'utf8').startsWith('(version 1)')
// macOS Unix-domain socket paths must be short (ZCode app-server creates one).
const socketDirectory = realpathSync(mkdtempSync('/private/tmp/zc-probe-'))
const workspace = join(root, 'workspace')
for (const p of [
  workspace,
  join(workspace, '.zcode'),
  join(root, 'logs'),
  join(root, 'storage'),
  join(root, 'tmp'),
]) {
  mkdirSync(p, { recursive: true, mode: 0o700 })
  chmodSync(p, 0o700)
}
const save = (name, data) =>
  writeFileSync(join(root, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', {
    mode: 0o600,
  })
save('personal.json', {
  schemaVersion: 1,
  config: {
    providerConfigRules: { providerRules: [] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    ...(smoke
      ? {
          defaultModelSelection: {
            providerId: selectedProvider,
            modelId: selectedModel,
            options: { reasoningLevel: selectedEffort },
          },
        }
      : {}),
  },
})
writeFileSync(
  join(workspace, '.zcode/config.json'),
  JSON.stringify({
    plugins: { enabled: false },
    hooks: { enabled: false },
    features: { mcp: false, subagent: false, memory: false, skill: false },
    memory: { use: false },
  }),
  { mode: 0o600 },
)
// Keep HOME unchanged. Each independent ZCode path is explicitly redirected.
const env = Object.fromEntries(
  ['PATH', 'HOME', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL'].flatMap((k) =>
    process.env[k] ? [[k, process.env[k]]] : [],
  ),
)
Object.assign(env, {
  TMPDIR: socketDirectory,
  ZCODE_DATA_BASE_DIR: root,
  ZCODE_STORAGE_DIR: join(root, 'storage'),
  ZCODE_SESSION_DB_PATH: join(root, 'storage/session.sqlite'),
  ZCODE_LOG_DIR: join(root, 'logs'),
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(root, 'personal.json'),
})
// Runtime may read its own installed files and auth/config, but cannot alter them.
// No model or telemetry network requests are permitted in the discovery phase.
const filesystemPolicy = `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(root)}) (subpath ${JSON.stringify(socketDirectory)})${isolatedAuth ? ` (subpath ${JSON.stringify(authBase)})` : ''} (literal "/dev/null"))\n`
save('sandbox.sb', filesystemPolicy + '(deny network*)\n(allow network* (local unix-socket))\n')
save(
  'sandbox-plan.sb',
  filesystemPolicy +
    `(deny file-write* (subpath ${JSON.stringify(workspace)}))\n` +
    (smoke ? '' : '(deny network*)\n(allow network* (local unix-socket))\n'),
)
if (smoke || login) {
  save('sandbox-network.sb', filesystemPolicy)
}
const records = []
const sandboxChecks = {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function members(pgid) {
  const p = spawnSync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' })
  if (p.status !== 0) throw new Error('Cannot verify process-group cleanup')
  return p.stdout
    .trim()
    .split('\n')
    .flatMap((line) => {
      const [pid, group, state] = line.trim().split(/\s+/)
      return Number(group) === pgid && !state?.startsWith('Z') ? [Number(pid)] : []
    })
}
function sendGroup(pid, signal) {
  if (!pid) return
  try {
    process.kill(-pid, signal)
  } catch (e) {
    if (e.code !== 'ESRCH') throw e
  }
}
async function cleanupGroup(pid) {
  if (!pid) return
  sendGroup(pid, 'SIGTERM')
  for (let i = 0; i < 20 && members(pid).length; i++) await sleep(100)
  if (members(pid).length) sendGroup(pid, 'SIGKILL')
  for (let i = 0; i < 20 && members(pid).length; i++) await sleep(100)
  if (members(pid).length) throw new Error('ZCode process group did not exit')
}
async function run(name, args, request, live = false, stopAfterResponse = false) {
  const policy = live ? (args.includes('plan') ? 'sandbox-plan.sb' : 'sandbox-network.sb') : 'sandbox.sb'
  const child = spawn('/usr/bin/sandbox-exec', ['-f', join(root, policy), process.execPath, cli, ...args], {
    // ZCode itself reads the existing native credential store. Never extract,
    // rewrite, copy, or print credentials; original paths remain write-denied.
    cwd: workspace,
    env: live ? { ...env, ZCODE_DATA_BASE_DIR: authBase } : env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = '',
    stderr = '',
    pending = '',
    bytes = 0,
    timeout = false,
    limit = false,
    rpcResult
  const signal = (sig) => sendGroup(child.pid, sig)
  const interrupt = () => {
    timeout = true
    signal('SIGTERM')
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const timeoutMs = live ? 120_000 : 25_000
  const timer = setTimeout(() => {
    timeout = true
    signal('SIGTERM')
  }, timeoutMs)
  const hardTimer = setTimeout(() => signal('SIGKILL'), timeoutMs + 7_000)
  child.stdin.on('error', () => {})
  const receive = (chunk, err) => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 2_097_152) {
      limit = true
      signal('SIGTERM')
      return
    }
    if (err) stderr += chunk
    else {
      stdout += chunk
      if (request) {
        pending += chunk
        let newline
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          try {
            const obj = JSON.parse(line)
            if (obj.id === request.id && !obj.method) {
              rpcResult = obj
              if (stopAfterResponse) signal('SIGTERM')
              else child.stdin.end()
            } else if (obj.id !== undefined && obj.method) {
              const reply =
                obj.method === 'session/requestRuntimePreferences'
                  ? {
                      id: obj.id,
                      result: {
                        nativeSearchEnhancementsEnabled: false,
                        memoryEnabled: false,
                        askUserQuestionAutoResolutionEnabled: false,
                      },
                    }
                  : {
                      id: obj.id,
                      error: { code: -32601, message: 'Unsupported in isolated discovery probe' },
                    }
              child.stdin.write(JSON.stringify(reply) + '\n')
            }
          } catch {}
        }
      }
    }
  }
  child.stdout.setEncoding('utf8').on('data', (c) => receive(c, false))
  child.stderr.setEncoding('utf8').on('data', (c) => receive(c, true))
  if (request) child.stdin.write(JSON.stringify(request) + '\n')
  else child.stdin.end()
  let exitCode, exitSignal
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, sig) => {
        exitCode = code
        exitSignal = sig
        resolve()
      })
    })
  } finally {
    clearTimeout(timer)
    clearTimeout(hardTimer)
    await cleanupGroup(child.pid)
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    save(`${name}.stdout`, stdout)
    save(`${name}.stderr`, stderr)
  }
  const expectedExit = stopAfterResponse ? exitCode === 143 || exitSignal === 'SIGTERM' : exitCode === 0
  const record = {
    name,
    exitCode,
    exitSignal,
    timeout,
    limit,
    cleanupConfirmed: true,
    success: expectedExit && !timeout && !limit && (!request || !!rpcResult?.result),
    ...(rpcResult
      ? { rpc: { id: rpcResult.id, error: rpcResult.error, resultKeys: Object.keys(rpcResult.result ?? {}) } }
      : {}),
    ...(name === 'help' ? { version: stdout.split('\n')[0] } : {}),
  }
  records.push(record)
  if (!live) console.log(JSON.stringify(record))
  return { record, stdout }
}
if (login) {
  console.log(`Isolated ZCode login profile: ${root}`)
  const args = process.argv.includes('--login-bigmodel') ? ['login', 'bigmodel', '--no-browser'] : ['tui']
  console.log('Complete native BigModel authorization; no model task will be submitted.')
  const child = spawn(
    '/usr/bin/sandbox-exec',
    ['-f', join(root, 'sandbox-network.sb'), process.execPath, cli, ...args, '--cwd', workspace],
    {
      cwd: workspace,
      env: { ...env, TERM: process.env.TERM ?? 'xterm-256color' },
      detached: true,
      stdio: 'inherit',
    },
  )
  const stop = () => sendGroup(child.pid, 'SIGTERM')
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const timer = setTimeout(stop, 300_000)
  const hardTimer = setTimeout(() => sendGroup(child.pid, 'SIGKILL'), 307_000)
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code))
  }).finally(async () => {
    clearTimeout(timer)
    clearTimeout(hardTimer)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await cleanupGroup(child.pid)
    save('login-report.json', {
      date: new Date().toISOString(),
      cli,
      credentialBase: root,
      cleanupConfirmed: true,
    })
  })
  process.exitCode = code ?? 1
} else
  try {
    const guard = join(parent, `guard-${root.split('/').at(-1)}`)
    writeFileSync(guard, 'unchanged', { mode: 0o600 })
    try {
      const code = 'require("node:fs").writeFileSync(process.argv[1], "changed")'
      const attempt = (path) =>
        spawnSync(
          '/usr/bin/sandbox-exec',
          ['-f', join(root, 'sandbox.sb'), process.execPath, '-e', code, path],
          { env, encoding: 'utf8' },
        )
      sandboxChecks.insideWritable = attempt(join(root, 'sandbox-write-check')).status === 0
      sandboxChecks.outsideWriteDenied =
        attempt(guard).status !== 0 && readFileSync(guard, 'utf8') === 'unchanged'
      {
        const planAttempt = spawnSync(
          '/usr/bin/sandbox-exec',
          [
            '-f',
            join(root, 'sandbox-plan.sb'),
            process.execPath,
            '-e',
            code,
            join(workspace, 'denied-write'),
          ],
          { env, encoding: 'utf8' },
        )
        sandboxChecks.planWorkspaceWriteDenied =
          planAttempt.status !== 0 && !existsSync(join(workspace, 'denied-write'))
        if (!sandboxChecks.planWorkspaceWriteDenied)
          throw new Error('Plan workspace write boundary check failed')
      }
      if (!sandboxChecks.insideWritable || !sandboxChecks.outsideWriteDenied)
        throw new Error('Sandbox write boundary check failed')
    } finally {
      unlinkSync(guard)
    }
    await run('help', ['--help'])
    await run('capabilities', ['app-server', '--cwd', workspace], {
      id: 1,
      method: 'runtime/capabilities',
      params: {},
    })
    await run(
      'idle-stop',
      ['app-server', '--cwd', workspace],
      { id: 3, method: 'runtime/capabilities', params: {} },
      false,
      true,
    )
    await run('session-catalog', ['app-server', '--cwd', workspace], {
      id: 2,
      method: 'session/create',
      params: {
        workspace: { workspaceKey: workspace, workspacePath: workspace },
        mode: 'plan',
        titleGenerationEnabled: false,
        mcpServers: [],
        toolAllowlist: [],
      },
    })
    if (smoke) {
      if (records.some((record) => !record.success))
        throw new Error('Offline prerequisites failed; refusing model task')
      const nonce = `ZCODE_PROBE_${Date.now()}`
      const args = ['--cwd', workspace, '--mode', 'plan', '--output-format', 'stream-json']
      const first = await run(
        'initial',
        [...args, '--prompt', `Reply exactly ${nonce}. Do not use tools or change files.`],
        undefined,
        true,
      )
      const lines = first.stdout.split('\n').flatMap((line) => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
      const result = lines.findLast((line) => line.type === 'result')
      first.record.resultReceived = !!result
      first.record.matched = result?.response?.trim() === nonce
      first.record.sessionId = result?.sessionId
      first.record.projectionStatus = result?.projection?.status
      first.record.success &&= !!first.record.matched && typeof result?.sessionId === 'string'
      console.log(JSON.stringify(first.record))
      if (first.record.success) {
        const next = await run(
          'followup',
          [
            ...args,
            '--resume',
            result.sessionId,
            '--prompt',
            'Repeat the exact marker from the previous turn. Do not use tools.',
          ],
          undefined,
          true,
        )
        const followup = next.stdout
          .split('\n')
          .flatMap((line) => {
            try {
              return [JSON.parse(line)]
            } catch {
              return []
            }
          })
          .findLast((line) => line.type === 'result')
        next.record.sameSession = followup?.sessionId === result.sessionId
        next.record.matched = followup?.response?.trim() === nonce
        next.record.success &&= next.record.sameSession && next.record.matched
        console.log(JSON.stringify(next.record))
      }
    }
  } finally {
    save('report.json', {
      date: new Date().toISOString(),
      root,
      cli,
      cliSha256: createHash('sha256').update(readFileSync(cli)).digest('hex'),
      phase: smoke ? 'native-account-smoke' : 'offline-discovery',
      networkPermitted: smoke ? 'only-during-explicit-smoke' : 'local-unix-sockets-only',
      selection: smoke
        ? { providerId: selectedProvider, modelId: selectedModel, reasoningLevel: selectedEffort }
        : undefined,
      promptTasksSent: records.filter((r) => ['initial', 'followup'].includes(r.name)).length,
      sandboxChecks,
      records,
    })
    console.log(`Evidence: ${join(root, 'report.json')}`)
  }
if (records.some((r) => !r.success)) process.exitCode = 1
