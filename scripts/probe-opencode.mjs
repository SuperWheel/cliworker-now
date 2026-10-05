// Isolated OpenCode feasibility probe. No model prompt in the default mode.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
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
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

process.umask(0o077)
if (process.platform !== 'darwin') throw new Error('This probe requires the macOS sandbox')
if (
  process.argv.length > 3 ||
  (process.argv[2] && !['--smoke', '--server-smoke', '--lifecycle'].includes(process.argv[2]))
)
  throw new Error('Use default offline discovery or --smoke with an explicitly selected model')
const serverSmoke = process.argv.includes('--server-smoke')
const lifecycle = process.argv.includes('--lifecycle')
const smoke = process.argv.includes('--smoke') || serverSmoke || lifecycle
const selectedModel = process.env.CLIWORKER_OPENCODE_MODEL
const credentialRef = process.env.CLIWORKER_OPENCODE_CREDENTIAL_REF
const selectedProvider = selectedModel?.split('/')[0]
if (credentialRef && selectedModel !== 'zhipuai-coding-plan/glm-5.3-flash')
  throw new Error('The approved credential ref is scoped to the explicitly selected native Coding Plan model')
if (smoke && !selectedModel?.includes('/'))
  throw new Error('Live smoke requires an explicitly selected provider/model; no provider fallback')
if (
  smoke &&
  selectedProvider !== 'opencode' &&
  !(selectedModel === 'zhipuai-coding-plan/glm-5.3-flash' && credentialRef === 'ZAI_CODING_CN_API_KEY')
)
  throw new Error(
    'This probe only supports the explicitly approved native providers and exact credential ref',
  )
const secretValues = []
const cli = realpathSync(process.env.CLIWORKER_OPENCODE_ENTRY ?? '/opt/homebrew/bin/opencode')
const parent = resolve('.test-data/opencode-probe')
mkdirSync(parent, { recursive: true, mode: 0o700 })
const root = realpathSync(mkdtempSync(join(parent, 'run-')))
const workspace = join(root, 'workspace')
for (const dir of [workspace, 'config', 'data', 'state', 'cache', 'tmp'].map((p) =>
  p.startsWith('/') ? p : join(root, p),
)) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}
const save = (name, data) =>
  writeFileSync(
    join(root, name),
    secretValues.reduce(
      (text, secret) => text.replaceAll(secret, '[REDACTED]'),
      typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n',
    ),
    {
      mode: 0o600,
    },
  )
const config = {
  autoupdate: false,
  share: 'disabled',
  snapshot: false,
  plugin: [],
  mcp: {},
  lsp: false,
  formatter: false,
  permission: { '*': 'deny' },
  ...(smoke
    ? { model: selectedModel, small_model: selectedModel, enabled_providers: [selectedProvider] }
    : {}),
}
save('opencode.json', config)
const env = Object.fromEntries(
  ['PATH', 'HOME', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL'].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
)
Object.assign(env, {
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'),
  TMPDIR: join(root, 'tmp'),
  OPENCODE_CONFIG: join(root, 'opencode.json'),
  OPENCODE_DB: join(root, 'data', 'opencode.db'),
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_PRUNE: '1',
  OPENCODE_DISABLE_SHARE: '1',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_PURE: '1',
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
  OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1',
  NO_COLOR: '1',
})
const modelsPath = join(homedir(), '.cache/opencode/models.json')
if (existsSync(modelsPath)) env.OPENCODE_MODELS_PATH = modelsPath
if (smoke && credentialRef) {
  // Only the one user-approved native ref is read. Python stdout stays in memory.
  // Never serialize the credential store, clone it, or print the subprocess result.
  const extracted = spawnSync(
    'python3',
    [
      '-c',
      'import os,sys,yaml\np=os.path.expanduser("~/.dsh/.credentials.yaml")\nd=yaml.safe_load(open(p))\ns=d["refs"]["ZAI_CODING_CN_API_KEY"]\nassert isinstance(s,str) and s.strip()\nsys.stdout.write(s)',
    ],
    { encoding: 'utf8', maxBuffer: 65536 },
  )
  if (extracted.status !== 0 || !extracted.stdout?.trim())
    throw new Error('Could not read the explicitly approved credential ref')
  secretValues.push(extracted.stdout)
  env.ZHIPU_API_KEY = extracted.stdout
}
const policy = `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))\n(deny network*)\n(allow network* (local unix-socket))\n(allow network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote ip "localhost:*"))\n`
save('sandbox.sb', policy)
save('sandbox-network.sb', policy.replace(/\(deny network\*\)/, ''))
const report = {
  at: new Date().toISOString(),
  root,
  cli,
  sha256: createHash('sha256').update(readFileSync(cli)).digest('hex'),
  phase: smoke ? 'real-smoke' : 'offline',
  selectedModel: smoke ? selectedModel : undefined,
  completeLiveAcceptance: false,
  promptsSent: 0,
  checks: {},
  records: [],
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function members(pgid) {
  const p = spawnSync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' })
  if (p.status !== 0) throw new Error('Cannot inspect process groups')
  return p.stdout
    .trim()
    .split('\n')
    .flatMap((line) => {
      const [pid, group, state] = line.trim().split(/\s+/)
      return Number(group) === pgid && !state?.startsWith('Z') ? [Number(pid)] : []
    })
}
function signal(pid, sig) {
  try {
    if (pid) process.kill(-pid, sig)
  } catch (e) {
    if (e.code === 'ESRCH') return
    if (e.code !== 'EPERM') throw e
    // A Darwin group signal can report EPERM during group teardown. Target only
    // independently observed remaining members; cleanup still verifies all exit.
    for (const member of members(pid)) {
      try {
        process.kill(member, sig)
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
  }
}
async function cleanup(pid) {
  signal(pid, 'SIGTERM')
  for (let i = 0; i < 20 && members(pid).length; i++) await sleep(100)
  if (members(pid).length) signal(pid, 'SIGKILL')
  for (let i = 0; i < 20 && members(pid).length; i++) await sleep(100)
  if (members(pid).length) throw new Error('OpenCode process group did not exit')
}
function launch(name, args, extraEnv = {}, options = {}) {
  const child = spawn(
    '/usr/bin/sandbox-exec',
    ['-f', join(root, options.live ? 'sandbox-network.sb' : 'sandbox.sb'), cli, ...args],
    {
      cwd: workspace,
      env: { ...env, ...extraEnv },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = '',
    stderr = '',
    bytes = 0,
    timedOut = false,
    outputLimit = false
  const stop = () => signal(child.pid, 'SIGTERM')
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const timeoutMs = options.live ? 120_000 : 25_000
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, timeoutMs)
  const hardTimer = setTimeout(() => signal(child.pid, 'SIGKILL'), timeoutMs + 7_000)
  const receive = (chunk, error) => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 2_097_152) {
      outputLimit = true
      stop()
      return
    }
    if (error) stderr += chunk
    else stdout += chunk
  }
  child.stdout.setEncoding('utf8').on('data', (chunk) => receive(chunk, false))
  child.stderr.setEncoding('utf8').on('data', (chunk) => receive(chunk, true))
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, sig) => resolve({ exitCode: code, signal: sig }))
  })
    .then(async (result) => {
      await cleanup(child.pid)
      save(`${name}.stdout`, stdout)
      save(`${name}.stderr`, stderr)
      const record = {
        name,
        args,
        ...result,
        timedOut,
        outputLimit,
        processGroupExited: true,
        outputBytes: bytes,
      }
      report.records.push(record)
      return { ...record, stdout, stderr }
    })
    .finally(() => {
      clearTimeout(timer)
      clearTimeout(hardTimer)
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    })
  return { child, stop, completion, output: () => stdout + '\n' + stderr }
}
async function run(name, args, extraEnv = {}, options = {}) {
  const result = await launch(name, args, extraEnv, options).completion
  console.log(JSON.stringify(report.records.at(-1)))
  if (result.exitCode !== 0 || result.timedOut || result.outputLimit) {
    if (options.live) {
      const errorEvent = result.stdout.split(/\r?\n/).flatMap((line) => {
        try {
          const event = JSON.parse(line)
          return event.type === 'error' ? [event] : []
        } catch {
          return []
        }
      })[0]
      if (errorEvent)
        report.checks[name] = {
          accepted: false,
          sessionID: errorEvent.sessionID,
          error: {
            name: errorEvent.error?.name,
            statusCode: errorEvent.error?.data?.statusCode,
            message: errorEvent.error?.data?.message,
            isRetryable: errorEvent.error?.data?.isRetryable,
          },
        }
    }
    throw new Error(`${name} failed; see private evidence`)
  }
  return result
}
function completedTurn(events) {
  const finishes = events.filter((event) => event.type === 'step_finish')
  return (
    finishes.at(-1)?.part?.reason === 'stop' &&
    !events.some(
      (event) =>
        event.type === 'error' || (event.type === 'tool_use' && event.part?.state?.status === 'error'),
    )
  )
}
async function liveEventTest(kind) {
  const password = randomBytes(24).toString('hex')
  const server = launch(
    `${kind}-server`,
    ['serve', '--hostname', '127.0.0.1', '--port', '0'],
    {
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: kind === 'permission' ? { '*': 'deny', edit: 'ask' } : { '*': 'deny' },
      }),
    },
    { live: true },
  )
  const events = []
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 110_000)
  let completed = false,
    stream,
    sessionID,
    asked = false,
    rejected = false,
    toolError = false,
    deltaSeen = false,
    failure
  try {
    let url
    for (let i = 0; i < 120 && !url; i++) {
      url = server.output().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
      if (!url) await sleep(100)
    }
    if (!url) throw new Error('Live server address unavailable')
    const headers = {
      Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
      'Content-Type': 'application/json',
    }
    const request = async (path, method = 'GET', body) => {
      const response = await fetch(url + path, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`${kind} HTTP ${response.status} for ${path}`)
      if (response.status === 204) return undefined
      const reader = response.body.getReader(),
        chunks = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 1_048_576) {
          await reader.cancel()
          throw new Error('Live HTTP output exceeded bound')
        }
        chunks.push(value)
      }
      const text = Buffer.concat(chunks).toString('utf8')
      return JSON.parse(text)
    }
    const session = await request('/session', 'POST', {
      title: `CLI Worker ${kind} probe`,
      model: { providerID: selectedProvider, id: selectedModel.split('/')[1] },
      agent: 'build',
    })
    sessionID = session.id
    if (typeof sessionID !== 'string') throw new Error('Live server did not return a session ID')
    const response = await fetch(url + '/event', { headers, signal: controller.signal })
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream'))
      throw new Error('No native SSE event stream')
    const reader = response.body.getReader(),
      decoder = new TextDecoder()
    let pending = '',
      size = 0
    stream = (async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 2_097_152) {
          await reader.cancel()
          throw new Error('SSE output exceeded bound')
        }
        pending += decoder.decode(value, { stream: true })
        let newline
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).replace(/\r$/, '')
          pending = pending.slice(newline + 1)
          if (!line.startsWith('data: ')) continue
          const event = JSON.parse(line.slice(6))
          events.push(event)
          if (event.properties?.sessionID !== sessionID) continue
          if (event.type === 'session.error') throw new Error('Native model error during SSE test')
          if (
            kind === 'cancel' &&
            event.type === 'message.part.delta' &&
            event.properties.field === 'text' &&
            event.properties.delta?.length
          ) {
            deltaSeen = true
            completed = true
            server.stop()
            controller.abort()
            return
          }
          if (kind === 'permission') {
            if (event.type === 'permission.asked') {
              asked = true
              await request(`/permission/${event.properties.id}/reply`, 'POST', {
                reply: 'reject',
                message: 'Rejected by isolated validation probe. Do not try another tool.',
              })
            }
            if (event.type === 'permission.replied' && event.properties.reply === 'reject') rejected = true
            if (
              event.type === 'message.part.updated' &&
              event.properties.part?.type === 'tool' &&
              event.properties.part.state?.status === 'error'
            )
              toolError = true
            if (
              (event.type === 'session.idle' ||
                (event.type === 'session.status' && event.properties.status?.type === 'idle')) &&
              asked &&
              rejected
            ) {
              completed = true
              controller.abort()
              return
            }
          }
        }
      }
    })()
    stream.catch(() => {})
    const prompt =
      kind === 'cancel'
        ? 'Without tools, immediately start writing a very long numbered list of 10000 short English sentences. Continue until all 10000 are written.'
        : 'Use the Write tool to create forbidden.json in the current directory containing {"must_not_exist":true}. If permission is denied, do not retry or use other tools; explain that it was denied.'
    report.promptsSent++
    await request(`/session/${sessionID}/prompt_async`, 'POST', {
      model: { providerID: selectedProvider, modelID: selectedModel.split('/')[1] },
      agent: 'build',
      parts: [{ type: 'text', text: prompt }],
    })
    await stream
    if (!completed) throw new Error('Native SSE stream ended before acceptance')
  } catch (error) {
    if (!completed) failure = error
  } finally {
    clearTimeout(timeout)
    controller.abort()
    try {
      server.stop()
    } catch (error) {
      failure ??= error
    }
    if (stream) await stream.catch(() => {})
    const stopped = await server.completion
    save(`${kind}-events.ndjson`, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
    const clean =
      !stopped.timedOut &&
      !stopped.outputLimit &&
      (stopped.signal === 'SIGTERM' || stopped.exitCode === 0 || stopped.exitCode === 143)
    report.checks[kind] = {
      sessionID,
      completed,
      deltaSeen,
      asked,
      rejected,
      toolError,
      forbiddenFileAbsent: !existsSync(join(workspace, 'forbidden.json')),
      eventTypes: [...new Set(events.map((e) => e.type))],
      cleanStop: clean,
      processGroupExited: stopped.processGroupExited,
    }
    if (!clean) failure ??= new Error('Live server stop did not meet acceptance')
  }
  if (failure) throw failure
  if (kind === 'cancel' && !deltaSeen) throw new Error('No real text delta observed before cancel')
  if (kind === 'permission' && !(asked && rejected && toolError && report.checks[kind].forbiddenFileAbsent))
    throw new Error('Permission rejection did not meet acceptance')
  console.log(JSON.stringify({ name: kind, ...report.checks[kind] }))
}
try {
  const sentinel = join(parent, `sentinel-${randomBytes(6).toString('hex')}`)
  writeFileSync(sentinel, 'unchanged', { mode: 0o600 })
  try {
    const test = spawnSync(
      '/usr/bin/sandbox-exec',
      [
        '-f',
        join(root, 'sandbox.sb'),
        process.execPath,
        '-e',
        'const fs=require("fs");fs.writeFileSync(process.argv[1],"inside");try{fs.writeFileSync(process.argv[2],"bad");process.exit(8)}catch{}',
        join(root, 'allowed'),
        sentinel,
      ],
      { encoding: 'utf8', timeout: 5_000 },
    )
    report.checks.writeBoundary = test.status === 0 && readFileSync(sentinel, 'utf8') === 'unchanged'
    if (!report.checks.writeBoundary) throw new Error('Sandbox boundary check failed')
  } finally {
    unlinkSync(sentinel)
  }
  await run('version', ['--version'])
  await run('help', ['--help'])
  await run('run-help', ['run', '--help'])
  await run('serve-help', ['serve', '--help'])
  await run('auth-help', ['auth', '--help'])
  await run('auth-list', ['auth', 'list'])
  await run('models', ['models', smoke ? selectedProvider : 'opencode'])
  if (smoke && !readFileSync(join(root, 'models.stdout'), 'utf8').split(/\r?\n/).includes(selectedModel))
    throw new Error('Selected model is absent from the actual native catalogue')
  const password = randomBytes(24).toString('hex')
  const server = launch(
    'server',
    ['serve', '--hostname', '127.0.0.1', '--port', '0'],
    {
      OPENCODE_SERVER_PASSWORD: password,
    },
    { live: serverSmoke },
  )
  try {
    let url
    for (let i = 0; i < 120 && !url; i++) {
      url = server.output().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
      if (!url) await sleep(100)
    }
    if (!url) throw new Error('Server address unavailable')
    const request = async (path, method = 'GET', body, timeoutMs = 5_000) => {
      const r = await fetch(url + path, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const reader = r.body.getReader()
      const chunks = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 4_194_304) {
          await reader.cancel()
          throw new Error('HTTP output exceeded bound')
        }
        chunks.push(value)
      }
      const text = Buffer.concat(chunks).toString('utf8')
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`)
      return JSON.parse(text)
    }
    report.checks.health = await request('/global/health')
    const schema = await request('/doc')
    save('openapi.json', schema)
    report.checks.openapi = {
      version: schema.openapi,
      paths: Object.keys(schema.paths ?? {}).filter((p) =>
        /session|permission|event|provider|config/.test(p),
      ),
    }
    const session = await request('/session', 'POST', { title: 'CLI Worker offline probe' })
    if (typeof session.id !== 'string') throw new Error('No real session ID returned')
    report.checks.session = {
      id: session.id,
      directory: session.directory,
      created: true,
      retrieved: (await request(`/session/${session.id}`)).id === session.id,
    }
    const providers = await request('/config/providers')
    save('providers.json', providers)
    report.checks.providers = {
      configured: providers.providers?.map((p) => ({ id: p.id, models: Object.keys(p.models ?? {}) })),
      default: providers.default,
    }
    report.checks.config = await request('/config')
    const unauthorized = await fetch(url + '/global/health', { signal: AbortSignal.timeout(5_000) })
    report.checks.unauthenticatedRejected = unauthorized.status === 401
    if (!report.checks.session.retrieved || !report.checks.unauthenticatedRejected)
      throw new Error('Server verification failed')
    if (serverSmoke) {
      const marker = `OPENCODE_SERVER_${randomBytes(10).toString('hex')}`
      const [providerID, modelID] = selectedModel.split('/')
      report.promptsSent++
      const response = await request(
        `/session/${session.id}/message`,
        'POST',
        {
          model: { providerID, modelID },
          agent: 'build',
          parts: [{ type: 'text', text: `Reply with exactly ${marker}. Do not use any tools.` }],
        },
        110_000,
      )
      save('server-first.json', response)
      const text = response.parts
        ?.filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('')
        .trim()
      report.checks.serverFirst = {
        marker,
        responseMatches: text === marker,
        error: response.info?.error
          ? {
              name: response.info.error.name,
              statusCode: response.info.error.data?.statusCode,
              message: response.info.error.data?.message,
              isRetryable: response.info.error.data?.isRetryable,
            }
          : undefined,
        modelID: response.info?.modelID,
        providerID: response.info?.providerID,
        sessionID: response.info?.sessionID,
      }
      if (!report.checks.serverFirst.responseMatches || response.info?.error)
        throw new Error('Native server first response did not meet acceptance')
    }
  } finally {
    server.stop()
    const stopped = await server.completion
    if (
      stopped.timedOut ||
      stopped.outputLimit ||
      !(stopped.signal === 'SIGTERM' || stopped.exitCode === 0 || stopped.exitCode === 143)
    )
      throw new Error('Server did not stop cleanly within its bound')
  }
  if (smoke && !serverSmoke && !lifecycle) {
    const marker = `OPENCODE_${randomBytes(10).toString('hex')}`
    const args = [
      'run',
      '--format',
      'json',
      '--model',
      selectedModel,
      '--agent',
      'build',
      '--title',
      'CLI Worker isolated real smoke',
    ]
    report.promptsSent++
    const first = await run(
      'first',
      [...args, `Reply with exactly ${marker}. Do not use any tools.`],
      {},
      { live: true },
    )
    const events = first.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    save('first-events.json', events)
    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => e.part?.text ?? e.text ?? '')
      .join('')
      .trim()
    const sessionID = events.find((e) => typeof e.sessionID === 'string')?.sessionID
    report.checks.first = {
      marker,
      sessionID,
      responseMatches: text === marker,
      eventTypes: [...new Set(events.map((e) => e.type))],
    }
    if (!report.checks.first.responseMatches || !sessionID || !completedTurn(events))
      throw new Error('First real response did not meet acceptance')
    report.promptsSent++
    const second = await run(
      'resume',
      [...args, '--session', sessionID, 'Repeat the exact marker from the previous turn. Do not use tools.'],
      {},
      { live: true },
    )
    const resumedEvents = second.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const resumedText = resumedEvents
      .filter((e) => e.type === 'text')
      .map((e) => e.part?.text ?? e.text ?? '')
      .join('')
      .trim()
    report.checks.resume = {
      sameSession:
        resumedEvents.some((e) => e.sessionID === sessionID) &&
        resumedEvents.every((e) => !e.sessionID || e.sessionID === sessionID),
      responseMatches: resumedText === marker,
    }
    if (
      !report.checks.resume.sameSession ||
      !report.checks.resume.responseMatches ||
      !completedTurn(resumedEvents)
    )
      throw new Error('Original-session resume did not meet acceptance')
    report.promptsSent++
    const file = await run(
      'file',
      [
        ...args,
        `Use the Write tool to create proof.json in the current directory containing exactly {"marker":"${marker}","verified":true}. Do not use shell commands or other files. Then reply DONE.`,
      ],
      { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { '*': 'deny', edit: 'allow' } }) },
      { live: true },
    )
    const fileEvents = file.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const artifact = join(workspace, 'proof.json')
    const actual = existsSync(artifact) ? JSON.parse(readFileSync(artifact, 'utf8')) : undefined
    report.checks.file = {
      matches: actual?.marker === marker && actual?.verified === true,
      toolEvents: fileEvents
        .filter((e) => e.type === 'tool_use')
        .map((e) => ({ tool: e.part?.tool, status: e.part?.state?.status })),
      sha256: existsSync(artifact) ? createHash('sha256').update(readFileSync(artifact)).digest('hex') : null,
    }
    if (
      !report.checks.file.matches ||
      !report.checks.file.toolEvents.some(
        (event) => event.tool === 'write' && event.status === 'completed',
      ) ||
      !completedTurn(fileEvents)
    )
      throw new Error('Actual file acceptance failed')
  }
  if (lifecycle) {
    await liveEventTest('cancel')
    await liveEventTest('permission')
  }
  report.success = true
} catch (error) {
  report.success = false
  report.error = error.message
  process.exitCode = 1
} finally {
  save('report.json', report)
  console.log(JSON.stringify({ root, success: report.success, error: report.error, checks: report.checks }))
}
