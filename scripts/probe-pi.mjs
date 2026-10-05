// Pi discovery defaults to offline; real tasks require the explicit smoke flag and model.
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
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

process.umask(0o077)
if (process.platform !== 'darwin') throw new Error('macOS sandbox required')
const smoke = process.argv.length === 3 && process.argv[2] === '--smoke-harness-zai'
if (process.argv.length > 2 && !smoke) throw new Error('Use offline discovery or --smoke-harness-zai')
if (
  smoke &&
  (process.env.CLIWORKER_PI_PROVIDER !== 'zai-coding-cn' ||
    process.env.CLIWORKER_PI_MODEL !== 'glm-5.3-flash' ||
    process.env.CLIWORKER_PI_EFFORT !== 'low')
)
  throw new Error('Smoke requires explicit zai-coding-cn/glm-5.3-flash/low selection')
const cli = realpathSync(
  process.env.CLIWORKER_PI_ENTRY ??
    '/private/tmp/cliworker-pi-1.0.2/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
)
const parent = resolve('.test-data/pi-omp-probe')
mkdirSync(parent, { recursive: true, mode: 0o700 })
const root = realpathSync(mkdtempSync(join(parent, 'pi-')))
const workspace = join(root, 'workspace')
for (const dir of [root, workspace, join(root, 'agent'), join(root, 'tmp')]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}
const save = (name, value) =>
  writeFileSync(join(root, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  })
save(
  'sandbox.sb',
  `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))\n(deny network*)\n(allow network* (local unix-socket))\n`,
)
const networkPolicy = `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))\n`
save('sandbox-network.sb', networkPolicy)
save('sandbox-readonly.sb', networkPolicy + `(deny file-write* (subpath ${JSON.stringify(workspace)}))\n`)
const env = Object.fromEntries(
  ['PATH', 'HOME', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL'].flatMap((k) =>
    process.env[k] ? [[k, process.env[k]]] : [],
  ),
)
Object.assign(env, {
  PI_CODING_AGENT_DIR: join(root, 'agent'),
  TMPDIR: join(root, 'tmp'),
  NO_COLOR: '1',
  PI_NO_PTY: '1',
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function members(pgid) {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('Cannot verify process cleanup')
  return result.stdout
    .trim()
    .split('\n')
    .flatMap((line) => {
      const [pid, group, state] = line.trim().split(/\s+/)
      return Number(group) === pgid && !state.startsWith('Z') ? [Number(pid)] : []
    })
}
function signal(pid, sig) {
  if (!pid) return
  try {
    process.kill(-pid, sig)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}
async function cleanup(pid) {
  if (!pid) return
  signal(pid, 'SIGTERM')
  for (let n = 0; n < 20 && members(pid).length; n++) await sleep(100)
  if (members(pid).length) signal(pid, 'SIGKILL')
  for (let n = 0; n < 20 && members(pid).length; n++) await sleep(100)
  if (members(pid).length) throw new Error('Pi process group remains alive')
}
const sandboxChecks = {}
const outside = join(parent, `boundary-${root.split('/').at(-1)}.txt`)
writeFileSync(outside, 'UNCHANGED', { mode: 0o600 })
try {
  const check = (policy, target) =>
    spawnSync(
      '/usr/bin/sandbox-exec',
      [
        '-f',
        join(root, policy),
        process.execPath,
        '-e',
        "require('node:fs').writeFileSync(process.argv[1], 'CHANGED')",
        target,
      ],
      { env, timeout: 5000, encoding: 'utf8' },
    )
  sandboxChecks.privateWritable = check('sandbox.sb', join(root, 'inside.txt')).status === 0
  sandboxChecks.outsideDenied =
    check('sandbox.sb', outside).status !== 0 && readFileSync(outside, 'utf8') === 'UNCHANGED'
  sandboxChecks.workspaceDenied =
    check('sandbox-readonly.sb', join(workspace, 'readonly.txt')).status !== 0 &&
    !existsSync(join(workspace, 'readonly.txt'))
  if (!Object.values(sandboxChecks).every(Boolean)) throw new Error('Sandbox boundary verification failed')
} finally {
  unlinkSync(outside)
}
const records = []
let modelTasksSent = 0
const isolationFlags = [
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
]
async function run(name, args, commands = []) {
  let stdout = '',
    stderr = '',
    buffer = '',
    bytes = 0,
    timeout = false,
    limited = false
  const events = [],
    replies = new Map()
  const child = spawn(
    '/usr/bin/sandbox-exec',
    ['-f', join(root, 'sandbox.sb'), process.execPath, cli, ...args],
    { cwd: workspace, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const terminate = () => signal(child.pid, 'SIGTERM')
  const deadline = setTimeout(() => {
    timeout = true
    terminate()
  }, 30000)
  const hardDeadline = setTimeout(() => signal(child.pid, 'SIGKILL'), 37000)
  process.once('SIGINT', terminate)
  process.once('SIGTERM', terminate)
  child.stdin.on('error', () => {})
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const receive = (chunk, errorStream) => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 2 * 1024 * 1024) {
      limited = true
      terminate()
      return
    }
    if (errorStream) {
      stderr += chunk
      return
    }
    stdout += chunk
    buffer += chunk
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
      try {
        const event = JSON.parse(line)
        events.push(event)
        if (event.type === 'response' && event.id) replies.set(event.id, event)
        if (commands.length && commands.every((command) => replies.has(command.id))) child.stdin.end()
      } catch {}
    }
  }
  child.stdout.on('data', (chunk) => receive(chunk, false))
  child.stderr.on('data', (chunk) => receive(chunk, true))
  if (commands.length) for (const command of commands) child.stdin.write(JSON.stringify(command) + '\n')
  else child.stdin.end()
  let result
  try {
    result = await new Promise((res, reject) => {
      child.once('error', reject)
      child.once('close', (code, sig) => res({ code, signal: sig }))
    })
  } finally {
    clearTimeout(deadline)
    clearTimeout(hardDeadline)
    process.removeListener('SIGINT', terminate)
    process.removeListener('SIGTERM', terminate)
    await cleanup(child.pid)
  }
  save(`${name}.stdout.txt`, stdout)
  save(`${name}.stderr.txt`, stderr)
  const record = {
    name,
    ...result,
    timeout,
    limited,
    processGroupExited: true,
    eventTypes: [...new Set(events.map((event) => event.type))],
    success:
      result.code === 0 &&
      !timeout &&
      !limited &&
      commands.every((command) => replies.get(command.id)?.success === true),
  }
  if (commands.length) record.responses = [...replies.values()]
  else record.output = stdout.slice(0, 16000)
  records.push(record)
  return record
}
await run('version', ['--version'])
await run('help', ['--help'])
await run('models', ['--list-models', 'glm-5.3'])
await run(
  'rpc-discovery',
  [
    '--mode',
    'rpc',
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
  ],
  [
    { id: 'state', type: 'get_state' },
    { id: 'models', type: 'get_available_models' },
    { id: 'abort', type: 'abort' },
  ],
)

function loadAuthorizedHarnessKey() {
  // User authorized this exact provider reference. Secret stays only in memory
  // and the selected child environment; never print or persist its value.
  const source = `from pathlib import Path\nimport yaml,sys\nconfig=yaml.safe_load((Path.home()/'.dsh/profiles/desktop/cordis.patch.yml').read_text())\nmatches=[x['config']['providers']['zai-coding-cn'] for x in config if isinstance(x,dict) and 'zai-coding-cn' in x.get('config',{}).get('providers',{})]\nassert len(matches)==1 and matches[0]['apiKeyEnv']=='ZAI_CODING_CN_API_KEY'\nx=yaml.safe_load((Path.home()/'.dsh/.credentials.yaml').read_text())\nsecret=x['refs']['ZAI_CODING_CN_API_KEY']\nassert isinstance(secret,str) and secret\nsys.stdout.write(secret)`
  const result = spawnSync('python3', ['-c', source], { encoding: 'utf8', maxBuffer: 32768 })
  if (result.status !== 0 || !result.stdout)
    throw new Error('Cannot resolve authorized Harness provider reference')
  return result.stdout
}
async function task(name, prompt, { session, write = false, readonly = false, cancel = false } = {}) {
  const args = [
    '--mode',
    'rpc',
    ...isolationFlags,
    '--provider',
    'zai-coding-cn',
    '--model',
    'glm-5.3-flash',
    '--thinking',
    'low',
    ...(write ? ['--tools', 'write'] : ['--no-tools']),
    ...(session ? ['--session', session] : []),
  ]
  const child = spawn(
    '/usr/bin/sandbox-exec',
    [
      '-f',
      join(root, readonly ? 'sandbox-readonly.sb' : 'sandbox-network.sb'),
      process.execPath,
      cli,
      ...args,
    ],
    {
      cwd: workspace,
      env: { ...env, ZAI_CODING_CN_API_KEY: loadAuthorizedHarnessKey() },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  let stdout = '',
    stderr = '',
    buffer = '',
    bytes = 0,
    timeout = false,
    limited = false,
    stopped = false,
    sent = false,
    state
  const events = [],
    responses = []
  const send = (value) => child.stdin.write(JSON.stringify(value) + '\n')
  const terminate = () => signal(child.pid, 'SIGTERM')
  const deadline = setTimeout(() => {
    timeout = true
    terminate()
  }, 120000)
  const hardDeadline = setTimeout(() => signal(child.pid, 'SIGKILL'), 127000)
  process.once('SIGINT', terminate)
  process.once('SIGTERM', terminate)
  child.stdin.on('error', () => {})
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const receive = (chunk, errorStream) => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 2 * 1024 * 1024) {
      limited = true
      terminate()
      return
    }
    if (errorStream) {
      stderr += chunk
      return
    }
    stdout += chunk
    buffer += chunk
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      events.push(event)
      if (event.type === 'response') {
        responses.push(event)
        if (event.id === 'initial') {
          state = event.data
          if (
            !event.success ||
            state?.model?.provider !== 'zai-coding-cn' ||
            state?.model?.id !== 'glm-5.3-flash' ||
            state?.thinkingLevel !== 'low'
          ) {
            child.stdin.end()
            continue
          }
          if (!sent) {
            sent = true
            modelTasksSent++
            send({ id: 'prompt', type: 'prompt', message: prompt })
          }
        }
        if (event.id === 'final') {
          state = event.data
          child.stdin.end()
        }
      }
      if (
        cancel &&
        event.type === 'message_update' &&
        event.assistantMessageEvent?.type === 'text_delta' &&
        !stopped
      ) {
        stopped = true
        terminate()
      }
      if (!cancel && event.type === 'agent_settled') send({ id: 'final', type: 'get_state' })
    }
  }
  child.stdout.on('data', (chunk) => receive(chunk, false))
  child.stderr.on('data', (chunk) => receive(chunk, true))
  send({ id: 'initial', type: 'get_state' })
  let exit
  try {
    exit = await new Promise((res, reject) => {
      child.once('error', reject)
      child.once('close', (code, sig) => res({ code, signal: sig }))
    })
  } finally {
    clearTimeout(deadline)
    clearTimeout(hardDeadline)
    process.removeListener('SIGINT', terminate)
    process.removeListener('SIGTERM', terminate)
    await cleanup(child.pid)
  }
  save(`${name}.stdout.txt`, stdout)
  save(`${name}.stderr.txt`, stderr)
  const assistantMessages = events
    .filter((e) => e.type === 'message_end' && e.message?.role === 'assistant')
    .map((e) => e.message)
  const response = assistantMessages
    .flatMap((m) => m.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('')
  const toolResults = events.filter((e) => e.type === 'tool_execution_end')
  const failed = assistantMessages.some((m) => m.stopReason === 'error' || m.stopReason === 'aborted')
  const record = {
    name,
    ...exit,
    timeout,
    limited,
    processGroupExited: true,
    modelTaskSent: sent,
    state,
    response,
    eventTypes: [...new Set(events.map((e) => e.type))],
    stoppedOnTextDelta: stopped,
    toolResults,
    success:
      !timeout &&
      !limited &&
      sent &&
      (cancel
        ? stopped && (exit.signal === 'SIGTERM' || exit.code === 143)
        : exit.code === 0 &&
          state?.model?.provider === 'zai-coding-cn' &&
          state?.model?.id === 'glm-5.3-flash' &&
          state?.thinkingLevel === 'low' &&
          state?.isStreaming === false &&
          !failed &&
          events.some((e) => e.type === 'agent_settled') &&
          responses.some((e) => e.id === 'final' && e.success)),
  }
  records.push(record)
  return record
}
if (smoke && records.every((record) => record.success)) {
  const marker = 'CLIWORKER_PI_' + randomBytes(8).toString('hex')
  const first = await task('first', `Reply with exactly this marker and nothing else: ${marker}`)
  first.success &&= first.response.trim() === marker && Boolean(first.state?.sessionFile)
  if (first.success) {
    const resumed = await task('resume', 'Repeat only the exact marker from my previous message.', {
      session: first.state.sessionFile,
    })
    resumed.success &&=
      resumed.response.trim() === marker && resumed.state?.sessionId === first.state.sessionId
    if (resumed.success) {
      const target = join(workspace, 'artifact.json')
      const written = await task(
        'write',
        `Use the write tool to create ${target} containing exactly {"marker":"${marker}","value":23}. Do not merely describe it.`,
        { session: first.state.sessionFile, write: true },
      )
      let artifact
      try {
        artifact = JSON.parse(readFileSync(target, 'utf8'))
      } catch {}
      written.artifactMatches = artifact?.marker === marker && artifact?.value === 23
      if (written.artifactMatches)
        written.artifactSha256 = createHash('sha256').update(readFileSync(target)).digest('hex')
      written.success &&=
        written.artifactMatches && written.toolResults.some((e) => e.toolName === 'write' && !e.isError)
      if (written.success) {
        const deniedTarget = join(workspace, 'denied.json')
        const denied = await task(
          'denied-write',
          `Use write to create ${deniedTarget} with text DENIED_WRITE_PROBE. Attempt the actual write once, then report the tool result.`,
          { write: true, readonly: true },
        )
        denied.fileAbsent = !existsSync(deniedTarget)
        denied.success &&=
          denied.fileAbsent && denied.toolResults.some((e) => e.toolName === 'write' && e.isError)
        if (denied.success) {
          const stopped = await task(
            'cancel',
            'Write a long plain text list of 2000 numbered short sentences about arithmetic. Start immediately. Do not use tools.',
            { cancel: true },
          )
          stopped.success &&= !stopped.eventTypes.includes('agent_settled')
        }
      }
    }
  }
}
const report = {
  createdAt: new Date().toISOString(),
  phase: smoke ? 'live' : 'offline',
  cli,
  sha256: createHash('sha256').update(readFileSync(cli)).digest('hex'),
  root,
  modelTasksSent,
  sandboxChecks,
  records,
}
save('report.json', report)
console.log(
  JSON.stringify(
    {
      root,
      modelTasksSent,
      records: records.map(({ output, responses, state, response, toolResults, ...record }) => record),
    },
    null,
    2,
  ),
)
if (records.some((record) => !record.success)) process.exitCode = 1
