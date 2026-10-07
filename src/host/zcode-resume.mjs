// ZCode ignores configured defaults on --resume. Apply the selected native model
// through metadata RPC, close the server completely, then run the original argv.
// The Host owns the surrounding Seatbelt and process range; never detach or shell.
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { open, lstat, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

process.umask(0o077)
const controller = new AbortController()
let active,
  activeDone,
  termination,
  stopped = false,
  resultSent = false
const failureText = 'ZCode 会话选型或协议验证失败，任务未成功执行，请检查原生配置'
const stoppedText = 'ZCode 任务已停止'
const output = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const string = (value) => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f]/u.test(value)
const checkActive = () => {
  controller.signal.throwIfAborted()
}

function start(argv, project, pipes) {
  checkActive()
  const child = spawn(argv[0], argv.slice(1), {
    cwd: project,
    env: process.env,
    detached: false,
    stdio: pipes,
  })
  active = child
  termination = undefined
  activeDone = new Promise((fulfill) => {
    child.once('error', () => fulfill({ code: null, signal: undefined }))
    child.once('close', (code, signal) => fulfill({ code, signal }))
  })
  child.stdin?.on('error', () => {})
  return { child, done: activeDone }
}

async function terminate() {
  if (termination) return termination
  const child = active,
    done = activeDone
  if (!child || !done) return
  termination = (async () => {
    child.stdin?.end()
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 1000)
    try {
      await done
    } finally {
      clearTimeout(force)
    }
    if (active === child) {
      active = undefined
      activeDone = undefined
    }
  })()
  return termination
}

for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    stopped = true
    controller.abort(new Error(stoppedText))
    void terminate()
  })

async function readRequest(path) {
  if (!isAbsolute(path ?? '') || !string(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE))
    throw new Error('Invalid private request')
  const parent = await realpath(dirname(path))
  const expected = await realpath(dirname(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE))
  if (parent !== expected || parent !== resolve(dirname(path)))
    throw new Error('Request escaped private state')
  const directory = await lstat(parent)
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077)
    throw new Error('Unsafe private request directory')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let value
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024 || before.mode & 0o077)
      throw new Error('Unsafe private request')
    const text = await file.readFile('utf8')
    const after = await file.stat()
    if (
      before.size !== Buffer.byteLength(text) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new Error('Request changed during read')
    value = JSON.parse(text)
  } finally {
    await file.close()
  }
  await unlink(path)
  if (
    !object(value) ||
    !isAbsolute(value.executable ?? '') ||
    !isAbsolute(value.project ?? '') ||
    !string(value.conversationId) ||
    !object(value.selection) ||
    !string(value.selection.providerId) ||
    !/^[A-Za-z0-9_.:-]+$/u.test(value.selection.providerId) ||
    !string(value.selection.modelId) ||
    !Array.isArray(value.argv) ||
    value.argv.some((arg) => typeof arg !== 'string')
  )
    throw new Error('Invalid resume request')
  const prefix = /\.[cm]?js$/u.test(value.executable)
    ? [process.execPath, value.executable]
    : [value.executable]
  if (prefix.some((arg, index) => value.argv[index] !== arg)) throw new Error('Native executable changed')
  const flags = new Map()
  const args = value.argv.slice(prefix.length)
  if (args.length % 2) throw new Error('Invalid native argv')
  for (let index = 0; index < args.length; index += 2) {
    if (
      !['--cwd', '--mode', '--output-format', '--disallowedTools', '--resume', '--prompt'].includes(
        args[index],
      ) ||
      flags.has(args[index])
    )
      throw new Error('Unexpected native option')
    flags.set(args[index], args[index + 1])
  }
  if (
    flags.size !== 6 ||
    flags.get('--cwd') !== value.project ||
    flags.get('--resume') !== value.conversationId ||
    !['plan', 'edit'].includes(flags.get('--mode')) ||
    flags.get('--output-format') !== 'stream-json' ||
    !string(flags.get('--disallowedTools')) ||
    !flags.get('--prompt')?.trim()
  )
    throw new Error('Native request identity or permission changed')
  if (
    value.selection.options !== undefined &&
    (!object(value.selection.options) || !string(value.selection.options.reasoningLevel))
  )
    throw new Error('Invalid native reasoning evidence')
  return {
    ...value,
    selection: {
      providerId: value.selection.providerId,
      modelId: value.selection.modelId,
      ...(value.selection.options
        ? { options: { reasoningLevel: value.selection.options.reasoningLevel } }
        : {}),
    },
    serverArgv: [
      ...prefix,
      'app-server',
      '--cwd',
      value.project,
      '--disallowedTools',
      flags.get('--disallowedTools'),
    ],
  }
}

function frames(child, consume, fail) {
  const decoder = new StringDecoder('utf8')
  let pending = '',
    bytes = 0,
    failed = false
  const receive = (chunk) => {
    if (failed) return
    try {
      bytes += chunk.length
      if (bytes > 16 * 1024 * 1024) throw new Error('Native output limit')
      pending += decoder.write(chunk)
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Native frame limit')
        if (line.trim()) consume(JSON.parse(line))
      }
      if (Buffer.byteLength(pending) > 1024 * 1024) throw new Error('Native pending frame limit')
    } catch (error) {
      failed = true
      fail(error)
    }
  }
  child.stdout.on('data', receive)
  // Native errors/settings may contain credential data. Do not forward stderr.
  child.stderr.on('data', (chunk) => {
    bytes += chunk.length
    if (bytes > 16 * 1024 * 1024 && !failed) {
      failed = true
      fail(new Error('Native stderr limit'))
    }
  })
  return () => {
    pending += decoder.end()
    if (!failed && pending.trim()) throw new Error('Truncated native frame')
  }
}

async function selectSession(request) {
  const { child, done } = start(request.serverArgv, request.project, ['pipe', 'pipe', 'pipe'])
  const pending = new Map()
  let sequence = 0,
    failed
  const rejectAll = (error) => {
    failed ??= error
    for (const waiting of pending.values()) waiting.reject(error)
    pending.clear()
  }
  const finishFrames = frames(
    child,
    (frame) => {
      if (!object(frame)) throw new Error('Invalid metadata frame')
      if (typeof frame.method === 'string') {
        if (frame.id !== undefined)
          child.stdin.write(
            JSON.stringify({
              id: frame.id,
              ...(frame.method === 'session/requestRuntimePreferences'
                ? {
                    result: {
                      nativeSearchEnhancementsEnabled: false,
                      memoryEnabled: false,
                      askUserQuestionAutoResolutionEnabled: false,
                    },
                  }
                : {
                    error: {
                      code: -32601,
                      message: 'Interactive requests are disabled during metadata selection',
                    },
                  }),
            }) + '\n',
          )
        return
      }
      const waiting = pending.get(frame.id)
      if (!waiting) return
      pending.delete(frame.id)
      if (frame.error || !('result' in frame)) waiting.reject(new Error('Metadata request rejected'))
      else waiting.resolve(frame.result)
    },
    (error) => {
      rejectAll(error)
      void terminate()
    },
  )
  void done.then(() => rejectAll(new Error('Metadata server exited')))
  const rpc = (method, params) =>
    new Promise((fulfill, reject) => {
      checkActive()
      if (failed) {
        reject(failed)
        return
      }
      const id = `cliworker-resume-${++sequence}`
      const abort = () => settle(reject, new Error(stoppedText))
      const timer = setTimeout(() => settle(reject, new Error('Metadata request timeout')), 15000)
      const settle = (callback, value) => {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', abort)
        pending.delete(id)
        callback(value)
      }
      pending.set(id, {
        resolve: (value) => settle(fulfill, value),
        reject: (error) => settle(reject, error),
      })
      controller.signal.addEventListener('abort', abort, { once: true })
      if (controller.signal.aborted) {
        abort()
        return
      }
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  try {
    const resumed = await rpc('session/resume', {
      sessionId: request.conversationId,
      mcpServers: [],
      toolAllowlist: [],
      offPeakToolEnabled: false,
      dynamicWorkflowEnabled: false,
    })
    if (resumed?.session?.sessionId !== request.conversationId) throw new Error('Resume identity mismatch')
    if (!request.selection.options) {
      const available = resumed.settings?.model?.available
      const selected = Array.isArray(available)
        ? available.find(
            (model) =>
              model.ref?.providerId === request.selection.providerId &&
              model.ref?.modelId === request.selection.modelId,
          )
        : undefined
      const nativeDefault = selected?.reasoning?.defaultLevel
      if (
        !string(nativeDefault) ||
        !Array.isArray(selected?.reasoning?.levels) ||
        !selected.reasoning.levels.some((level) => level.value === nativeDefault)
      )
        throw new Error('Missing native reasoning default')
      request.selection.options = { reasoningLevel: nativeDefault }
    }
    await rpc('session/setModel', {
      sessionId: request.conversationId,
      model: request.selection,
      persistAsWorkspaceLastUsed: false,
    })
    const snapshot = await rpc('session/read', { sessionId: request.conversationId, messageLimit: 1 })
    const current = snapshot?.settings?.model?.current
    if (
      snapshot?.session?.sessionId !== request.conversationId ||
      current?.providerId !== request.selection.providerId ||
      current?.modelId !== request.selection.modelId ||
      current?.options?.reasoningLevel !== request.selection.options.reasoningLevel
    )
      throw new Error('Native selected model or effort mismatch')
    const closed = await rpc('session/close', { sessionId: request.conversationId })
    if (closed?.closed !== true) throw new Error('Session did not close')
    child.stdin.end()
    const timeout = setTimeout(() => {
      rejectAll(new Error('Metadata server did not exit'))
      void terminate()
    }, 5000)
    let outcome
    try {
      outcome = await done
    } finally {
      clearTimeout(timeout)
    }
    finishFrames()
    if (outcome.code !== 0 || outcome.signal || stopped)
      throw new Error('Metadata server did not exit cleanly')
    if (active === child) {
      active = undefined
      activeDone = undefined
      termination = undefined
    }
  } finally {
    rejectAll(new Error('Metadata selection ended'))
    await terminate()
  }
  checkActive()
}

async function runHeadless(request) {
  const { child, done } = start(request.argv, request.project, ['ignore', 'pipe', 'pipe'])
  let failed, terminal
  const finishFrames = frames(
    child,
    (frame) => {
      if (!object(frame) || typeof frame.type !== 'string' || terminal)
        throw new Error('Invalid native task frame')
      if (frame.sessionId !== undefined && frame.sessionId !== request.conversationId)
        throw new Error('Native task session changed')
      const payload = object(frame.payload) ? frame.payload : {}
      if (
        frame.type === 'session.updated' &&
        ((payload.providerId !== undefined && payload.providerId !== request.selection.providerId) ||
          (payload.modelId !== undefined && payload.modelId !== request.selection.modelId))
      )
        throw new Error('Observed model differs from selected model')
      if (frame.type === 'result') {
        terminal = frame
        return
      }
      output(
        frame.type === 'error' || frame.type === 'turn.failed'
          ? { type: frame.type, sessionId: request.conversationId, payload: { message: failureText } }
          : frame,
      )
    },
    (error) => {
      failed ??= error
      void terminate()
    },
  )
  const outcome = await done
  finishFrames()
  if (
    failed ||
    stopped ||
    outcome.code !== 0 ||
    outcome.signal ||
    !terminal ||
    terminal.sessionId !== request.conversationId ||
    typeof terminal.response !== 'string'
  )
    throw new Error('Native task did not finish correctly')
  output(terminal)
  resultSent = true
  if (active === child) {
    active = undefined
    activeDone = undefined
    termination = undefined
  }
}

let request
try {
  request = await readRequest(process.argv[2])
  checkActive()
  await selectSession(request)
  checkActive()
  await runHeadless(request)
} catch {
  await terminate()
  if (!resultSent) {
    const sessionId = request?.conversationId
    output({
      type: 'error',
      ...(sessionId ? { sessionId } : {}),
      payload: { message: stopped ? stoppedText : failureText },
    })
    if (sessionId) output({ type: 'result', sessionId, response: '' })
  }
  process.exitCode = stopped ? 143 : 1
}
