// Subprocess protocol bridge. The Host owns the external sandbox, credentials,
// deadlines, directory/session locks, and descendant cleanup. No shell is used.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile, rename, realpath, unlink, rmdir, lstat, open, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import {
  queryNativeCandidates,
  snapshotNativeCandidates,
  accountSupportedChoices,
} from './pi-native-catalog.mjs'

process.umask(0o077)
const output = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const event = (value) => output({ type: 'event', event: value })
const safeErrors = new Set([
  '任务已停止',
  '所选模型或强度不在原生可用目录中',
  '无法读取 Pi/OMP 原生模型目录，请检查本机配置',
])
const errorMessage = (error) =>
  error instanceof Error && safeErrors.has(error.message)
    ? error.message
    : 'Pi/OMP 原生配置、模型或协议校验失败'
const inside = (root, path) => path.startsWith(root + sep)
const cnProvider = (cli) => (cli === 'pi' ? 'zai-coding-cn' : 'cliworker-zai-cn')
let selectedProvider, selectedModel
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Unsafe Pi/OMP state directory symlink')
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (info.dev !== opened.dev || info.ino !== opened.ino)
      throw new Error('Pi/OMP state directory changed while opening')
    await handle.chmod(0o700)
  } finally {
    await handle.close()
  }
  return realpath(path)
}
async function privateFile(path, read = false, limit = 1024 * 1024) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1) throw new Error('Unsafe Pi/OMP state file or hard link')
    if (read) {
      if (info.size > limit) throw new Error('Pi/OMP state JSON exceeds limit')
      const contents = await handle.readFile('utf8')
      const after = await handle.stat()
      if (Buffer.byteLength(contents) > limit || info.size !== after.size || info.mtimeMs !== after.mtimeMs)
        throw new Error('Pi/OMP state JSON changed while reading')
      return contents
    }
  } finally {
    await handle.close()
  }
}
async function writePrivateFile(path, contents) {
  await privateDirectory(dirname(path))
  const temporary = join(dirname(path), `.cliworker-${randomBytes(16).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 })
    // Replaces a planted file link itself; never truncates its external inode.
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
let child,
  stopped = false,
  failure,
  closeTimer,
  forceTimer,
  startupTimer,
  config,
  session,
  finalized = false
const metadataController = new AbortController()
const stop = (reason) => {
  failure ??= reason
  child?.stdin?.end()
  child?.kill('SIGTERM')
  forceTimer ??= setTimeout(() => child?.kill('SIGKILL'), 5000)
}
process.on('SIGTERM', () => {
  stopped = true
  metadataController.abort()
  stop('任务已停止')
})
process.on('SIGINT', () => {
  stopped = true
  metadataController.abort()
  stop('任务已停止')
})
const persist = async () => {
  if (!session || config.discover) return
  const path = await realpath(session.path)
  const nativeRoot = await privateDirectory(join(config.stateDirectory, 'agent'))
  if (!inside(nativeRoot, path) || path !== resolve(session.path))
    throw new Error('CLI session path escaped its private directory or used a symlink')
  await privateFile(path)
  const mapDirectory = join(config.stateDirectory, 'sessions')
  await privateDirectory(mapDirectory)
  const filename = join(mapDirectory, createHash('sha256').update(session.id).digest('hex') + '.json')
  await writePrivateFile(
    filename,
    JSON.stringify({
      cli: config.cli,
      project: config.project,
      id: session.id,
      path,
      model: config.preference.model,
    }),
  )
}
try {
  const requestPath = process.argv[2]
  config = JSON.parse(await privateFile(requestPath, true))
  await unlink(requestPath)
  await rmdir(dirname(requestPath))
  if (
    !['pi', 'omp'].includes(config.cli) ||
    typeof config.executable !== 'string' ||
    !isAbsolute(config.stateDirectory)
  )
    throw new Error('Invalid bridge request')
  config.stateDirectory = await privateDirectory(config.stateDirectory)
  const nativeRoot = await privateDirectory(join(config.stateDirectory, 'agent'))
  const temporaryDirectory = await privateDirectory(join(config.stateDirectory, 't'))
  await privateDirectory(join(nativeRoot, 'sessions'))
  if (!config.discover) await privateDirectory(join(config.stateDirectory, 'sessions'))
  const env = Object.fromEntries(
    [
      'PATH',
      'HOME',
      'LANG',
      'LC_ALL',
      'USER',
      'LOGNAME',
      'SHELL',
      'TMPDIR',
      'NODE_EXTRA_CA_CERTS',
      'SSL_CERT_FILE',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  )
  Object.assign(env, {
    PI_CODING_AGENT_DIR: nativeRoot,
    TMPDIR: temporaryDirectory,
    // Native source env was projected by Host. Runtime path overrides never enter here.
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => /_(?:API_KEY|TOKEN|SECRET)$/.test(key)),
    ),
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
    ELECTRON_RUN_AS_NODE: '1',
    NO_COLOR: '1',
  })
  const nativeEnvironment = JSON.parse(await privateFile(join(nativeRoot, 'native-env.json'), true))
  if (
    !nativeEnvironment ||
    typeof nativeEnvironment !== 'object' ||
    Array.isArray(nativeEnvironment) ||
    Object.entries(nativeEnvironment).some(
      ([key, value]) =>
        !/^[A-Z][A-Z0-9_]*$/.test(key) ||
        /^(?:PATH|HOME|SHELL|TMPDIR|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|OMP_PROFILE|PI_PROFILE|PI_CONFIG_DIR|PI_CODING_AGENT_DIR|LD_.*|DYLD_.*)$/.test(
          key,
        ) ||
        typeof value !== 'string',
    )
  )
    throw new Error('Invalid native environment snapshot')
  Object.assign(env, nativeEnvironment)
  // The explicitly supplied Host reference wins only for its own CN route;
  // native env remains the source for every other provider.
  if (
    config.managedCredentials &&
    (config.discover ||
      ['zai-coding-cn', 'cliworker-zai-cn', 'zhipu-coding-plan'].includes(
        config.preference?.model?.split('/')[0],
      ))
  ) {
    if (process.env.ZAI_CODING_CN_API_KEY) env.ZAI_CODING_CN_API_KEY = process.env.ZAI_CODING_CN_API_KEY
  }
  if (config.managedCredentials && !config.discover) {
    const provider = config.preference?.model?.split('/')[0]
    if (provider !== cnProvider(config.cli) && !(config.cli === 'omp' && provider === 'zhipu-coding-plan')) {
      for (const key of ['ZAI_CODING_CN_API_KEY', 'ZHIPU_API_KEY']) {
        if (nativeEnvironment[key] !== undefined) env[key] = nativeEnvironment[key]
        else delete env[key]
      }
    }
  }
  const isolated =
    config.cli === 'pi'
      ? [
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-themes',
          '--no-context-files',
          '--no-approve',
        ]
      : [
          '--no-extensions',
          '--no-skills',
          '--no-rules',
          '--no-title',
          '--no-lsp',
          '--no-pty',
          '--approval-mode',
          'write',
          '--config',
          join(nativeRoot, 'config.yml'),
        ]
  if (config.cli === 'omp') {
    env.PI_CONFIG_DIR = relative(homedir(), config.stateDirectory)
    const native = JSON.parse(await readFile(join(nativeRoot, 'models.yml'), 'utf8'))
    // Legacy CN alias remains available alongside the installed native CN catalog.
    const model = {
      id: 'glm-5.3-flash',
      name: 'GLM-5.3-Flash',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 1000000,
      maxTokens: 131072,
      cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
      thinking: { mode: 'effort', efforts: ['low', 'high', 'max'], defaultLevel: 'low' },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        maxTokensField: 'max_tokens',
        thinkingFormat: 'zai',
        supportsStrictMode: true,
      },
    }
    if (env.ZAI_CODING_CN_API_KEY) {
      env.ZHIPU_API_KEY = env.ZAI_CODING_CN_API_KEY
      native.providers ??= {}
      native.providers['cliworker-zai-cn'] = {
        api: 'openai-completions',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        apiKey: 'ZAI_CODING_CN_API_KEY',
        models: [model],
      }
    }
    await writePrivateFile(join(nativeRoot, 'models.yml'), JSON.stringify(native))
    const nativeAuth = JSON.parse(await readFile(join(nativeRoot, 'native-auth.json'), 'utf8'))
    await writePrivateFile(
      join(nativeRoot, 'config.yml'),
      JSON.stringify({
        ...nativeAuth,
        startup: { setupWizard: false, checkUpdate: false, showSplash: false },
        disabledProviders: [
          'native',
          'claude',
          'claude-plugins',
          'codex',
          'cursor',
          'gemini',
          'opencode',
          'mcp-json',
          'vscode',
          'windsurf',
          'omp-plugins',
        ],
        mcp: { enableProjectConfig: false },
        retry: { modelFallback: false },
        memory: { backend: 'off' },
        tools: { approvalMode: 'write' },
      }),
    )
  }
  if (
    config.managedCredentials &&
    env.ZAI_CODING_CN_API_KEY &&
    (config.discover ||
      (config.cli === 'pi'
        ? config.preference?.model?.split('/')[0] === 'zai-coding-cn'
        : ['cliworker-zai-cn', 'zhipu-coding-plan'].includes(config.preference?.model?.split('/')[0])))
  ) {
    if (config.cli === 'pi') {
      const auth = JSON.parse(await privateFile(join(nativeRoot, 'auth.json'), true))
      delete auth['zai-coding-cn']
      await writePrivateFile(join(nativeRoot, 'auth.json'), JSON.stringify(auth))
      const models = JSON.parse(await privateFile(join(nativeRoot, 'models.json'), true))
      models.providers ??= {}
      models.providers['zai-coding-cn'] = {
        ...(models.providers['zai-coding-cn'] ?? {}),
        api: 'openai-completions',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        apiKey: 'ZAI_CODING_CN_API_KEY',
      }
      await writePrivateFile(join(nativeRoot, 'models.json'), JSON.stringify(models))
    } else {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(join(nativeRoot, 'agent.db'))
      try {
        db.prepare('DELETE FROM auth_credentials WHERE provider IN (?,?)').run(
          'cliworker-zai-cn',
          'zhipu-coding-plan',
        )
      } finally {
        db.close()
      }
      const models = JSON.parse(await privateFile(join(nativeRoot, 'models.yml'), true))
      // This is a native builtin; auth-only config overlays are not portable
      // across the bundled OMP registry. Remove a competing private override and
      // bind the explicitly supplied source through its native ZHIPU env instead.
      if (models.providers) delete models.providers['zhipu-coding-plan']
      await writePrivateFile(join(nativeRoot, 'models.yml'), JSON.stringify(models))
    }
  }
  let resume
  let catalog
  if (config.metadataPhase === 'native-candidates') {
    const candidates = await queryNativeCandidates(
      config.cli,
      config.executable,
      nativeRoot,
      env,
      (process) => {
        child = process
        if (stopped) stop('任务已停止')
      },
      { signal: metadataController.signal },
    )
    if (stopped || failure) throw new Error('任务已停止')
    const snapshot = snapshotNativeCandidates(candidates, env)
    await writePrivateFile(join(nativeRoot, 'catalog-candidates.json'), JSON.stringify(snapshot))
    output({ phase: 'native-candidates', count: snapshot.length })
    finalized = true
  } else if (config.metadataPhase === 'account-scope') {
    const candidates = JSON.parse(
      await privateFile(join(nativeRoot, 'catalog-candidates.json'), true, 16 * 1024 * 1024),
    )
    if (!Array.isArray(candidates)) throw new Error('Invalid native candidate snapshot')
    catalog = await accountSupportedChoices(config.cli, nativeRoot, candidates, env, {
      signal: metadataController.signal,
    })
  } else {
    catalog = config.confirmedCatalog
    if (!Array.isArray(catalog)) throw new Error('Missing confirmed account model catalog')
  }
  if (stopped || failure) throw new Error('任务已停止')
  if (finalized) {
    // Candidate phase has no account networking or model execution.
  } else if (config.discover || config.metadataPhase === 'account-scope') {
    output(catalog)
    finalized = true
  } else {
    if (
      typeof config.preference?.model !== 'string' ||
      !/^[A-Za-z0-9_.:-]+\/[^\s\x00-\x1f]+$/.test(config.preference.model)
    )
      throw new Error('Invalid selected native provider/model')
    const slash = config.preference.model.indexOf('/')
    selectedProvider = config.preference.model.slice(0, slash)
    selectedModel = config.preference.model.slice(slash + 1)
    const selected = catalog.find((model) => model.id === config.preference.model)
    if (
      !selected ||
      (config.preference.effort !== 'default' && !selected.efforts.includes(config.preference.effort))
    )
      throw new Error('所选模型或强度不在原生可用目录中')
    if (
      !['plan', 'accept-edits'].includes(config.mode) ||
      typeof config.prompt !== 'string' ||
      !config.prompt.trim()
    )
      throw new Error('Invalid task mode or prompt')
    config.project = await realpath(config.project)
    if (config.conversationId) {
      await privateDirectory(join(config.stateDirectory, 'sessions'))
      const mapping = join(
        config.stateDirectory,
        'sessions',
        createHash('sha256').update(config.conversationId).digest('hex') + '.json',
      )
      const mapped = JSON.parse(await privateFile(mapping, true))
      if (
        mapped.cli !== config.cli ||
        mapped.project !== config.project ||
        mapped.id !== config.conversationId
      )
        throw new Error('Saved session identity does not match this request')
      resume = await realpath(mapped.path)
      if (!inside(nativeRoot, resume) || resume !== resolve(mapped.path))
        throw new Error('Saved session path escaped its private directory or used a symlink')
      await privateFile(resume)
    }
    const tools = config.cli === 'pi' ? ['read', 'grep', 'find', 'ls'] : ['read', 'grep', 'glob']
    if (config.mode === 'accept-edits') tools.push('write', 'edit')
    const nativeArgs = [
      '--mode',
      'rpc',
      ...isolated,
      '--provider',
      selectedProvider,
      '--model',
      selectedModel,
      ...(config.preference.effort === 'default'
        ? []
        : ['--thinking', config.preference.effort === 'none' ? 'off' : config.preference.effort]),
      '--tools',
      tools.join(','),
      ...(resume ? [config.cli === 'pi' ? '--session' : '--resume', resume] : []),
    ]
    const jsEntry = /\.[cm]?js$/.test(config.executable)
    if (stopped) throw new Error('任务已停止')
    child = spawn(
      jsEntry ? process.execPath : config.executable,
      jsEntry ? [config.executable, ...nativeArgs] : nativeArgs,
      {
        cwd: config.project,
        env,
        detached: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    let pending = '',
      bytes = 0,
      stderrBytes = 0,
      settled = false,
      finalState = false,
      sent = false,
      response = '',
      currentText = '',
      assistantStep = 0
    const toolSteps = new Map()
    const send = (value) => {
      if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n')
    }
    const validateState = (state, validateModel = true) => {
      if (
        !state ||
        typeof state.sessionId !== 'string' ||
        !state.sessionId ||
        typeof state.sessionFile !== 'string' ||
        !inside(nativeRoot, resolve(state.sessionFile))
      )
        throw new Error('CLI did not return a private session identity')
      if (
        validateModel &&
        (state.model?.provider !== selectedProvider ||
          state.model?.id !== selectedModel ||
          (config.preference.effort !== 'default' &&
            state.thinkingLevel !== (config.preference.effort === 'none' ? 'off' : config.preference.effort)))
      )
        throw new Error('CLI model or effort differs from the selected preference')
      if (
        (session && session.id !== state.sessionId) ||
        (config.conversationId && config.conversationId !== state.sessionId)
      )
        throw new Error('CLI changed the conversation identity')
      if (
        (resume && resume !== resolve(state.sessionFile)) ||
        (session && session.path !== resolve(state.sessionFile))
      )
        throw new Error('CLI changed the saved session file')
      session = { id: state.sessionId, path: resolve(state.sessionFile) }
    }
    const consume = (value) => {
      if (!value || typeof value !== 'object' || typeof value.type !== 'string')
        throw new Error('Invalid native RPC record')
      if (value.type === 'response') {
        if (!value.success) throw new Error('Native CLI rejected an RPC request')
        if (value.id === 'select-model') {
          if (config.preference.effort !== 'default')
            send({
              id: 'select-effort',
              type: 'set_thinking_level',
              level: config.preference.effort === 'none' ? 'off' : config.preference.effort,
            })
          else send({ id: 'selected', type: 'get_state' })
        } else if (value.id === 'select-effort') send({ id: 'selected', type: 'get_state' })
        else if (value.id === 'initial' || value.id === 'selected') {
          validateState(value.data, value.id === 'selected')
          if (value.data.isStreaming) throw new Error('Native session is already streaming')
          if (
            value.id === 'initial' &&
            (value.data.model?.provider !== selectedProvider || value.data.model?.id !== selectedModel)
          ) {
            send({
              id: 'select-model',
              type: 'set_model',
              provider: selectedProvider,
              modelId: selectedModel,
            })
            return
          }
          if (
            value.id === 'initial' &&
            config.preference.effort !== 'default' &&
            value.data.thinkingLevel !==
              (config.preference.effort === 'none' ? 'off' : config.preference.effort)
          ) {
            send({
              id: 'select-effort',
              type: 'set_thinking_level',
              level: config.preference.effort === 'none' ? 'off' : config.preference.effort,
            })
            return
          }
          validateState(value.data)
          clearTimeout(startupTimer)
          output({
            type: 'session',
            id: session.id,
            model: `${value.data.model.provider}/${value.data.model.id}`,
          })
          event({
            kind: 'status',
            text: `${config.cli === 'pi' ? 'Pi' : 'OMP'} 原生模型已确认`,
            observedModel: `${value.data.model.provider}/${value.data.model.id}`,
          })
          if (!stopped && !failure) {
            sent = true
            send({ id: 'prompt', type: 'prompt', message: config.prompt })
          }
        } else if (value.id === 'final') {
          validateState(value.data)
          if (value.data.isStreaming || value.data.isCompacting || (value.data.pendingMessageCount ?? 0) > 0)
            throw new Error('Native agent is still active after its terminal event')
          finalState = true
          child.stdin.end()
          closeTimer ??= setTimeout(() => stop('CLI did not exit after completion'), 5000)
        }
        return
      }
      if (config.discover) return
      if (value.type === 'extension_ui_request') {
        // Notifications carry no obligation. Interactive requests are denied.
        if (['confirm', 'select', 'input', 'editor'].includes(value.method)) {
          failure ??= 'CLI 需要额外原生交互授权'
          send({ type: 'extension_ui_response', id: value.id, cancelled: true, confirmed: false })
        }
        return
      }
      if (value.type === 'message_start' && value.message?.role === 'assistant') {
        currentText = ''
        assistantStep++
        return
      }
      if (value.type === 'message_update' && value.assistantMessageEvent?.type === 'text_delta') {
        const text = value.assistantMessageEvent.delta
        if (typeof text !== 'string') throw new Error('Invalid text delta')
        currentText += text
        response += text
        event({ kind: 'assistant', step: assistantStep, text })
        return
      }
      if (value.type === 'message_end' && value.message?.role === 'assistant') {
        if (['error', 'aborted'].includes(value.message.stopReason)) failure ??= '模型请求失败或被中止'
        if (value.message.model && value.message.model !== selectedModel)
          failure ??= '模型响应与所选型号不一致'
        if (value.message.provider && value.message.provider !== selectedProvider)
          failure ??= '模型响应与所选提供商不一致'
        if (!currentText) {
          const text = (value.message.content ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('')
          if (text) {
            response += text
            event({ kind: 'assistant', step: assistantStep, text })
          }
        }
        return
      }
      if (value.type === 'tool_execution_start') {
        const step = 100000 + toolSteps.size
        toolSteps.set(value.toolCallId, step)
        event({ kind: 'tool', step, text: String(value.toolName ?? '工具'), state: 'RUNNING' })
        return
      }
      if (value.type === 'tool_execution_end') {
        if (value.isError) failure ??= '至少一个 CLI 工具执行失败'
        const detail = (value.result?.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n')
          .slice(0, 32768)
        event({
          kind: 'tool',
          step: toolSteps.get(value.toolCallId),
          text: String(value.toolName ?? '工具'),
          state: value.isError ? 'FAILED' : 'COMPLETED',
          detail,
        })
        return
      }
      if (
        (config.cli === 'pi' && value.type === 'agent_settled') ||
        (config.cli === 'omp' && value.type === 'agent_end' && value.isTerminal !== false)
      ) {
        if (!sent) throw new Error('Unexpected native terminal event')
        settled = true
        send({ id: 'final', type: 'get_state' })
      }
    }
    child.stdin.on('error', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      try {
        bytes += Buffer.byteLength(chunk)
        if (bytes > 16 * 1024 * 1024) throw new Error('Native RPC output exceeds run limit')
        pending += chunk
        let end
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end)
          pending = pending.slice(end + 1)
          if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Native RPC line exceeds limit')
          if (line.trim()) consume(JSON.parse(line))
        }
        if (Buffer.byteLength(pending) > 1024 * 1024) throw new Error('Native RPC line exceeds limit')
      } catch (error) {
        stop(errorMessage(error))
      }
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes > 2 * 1024 * 1024) stop('Native stderr exceeds limit')
    })
    startupTimer = setTimeout(() => stop('Native RPC startup timed out'), 20000)
    send({ id: 'initial', type: 'get_state' })
    const outcome = await new Promise((resolve) => {
      child.once('error', () => {
        failure ??= '无法启动原生 CLI'
      })
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    clearTimeout(startupTimer)
    clearTimeout(closeTimer)
    clearTimeout(forceTimer)
    if (pending.trim()) failure ??= 'Truncated native RPC frame'
    if (outcome.code !== 0) failure ??= '原生 CLI 异常退出'
    if (!settled || !finalState || !sent) failure ??= '原生 CLI 未确认任务完成'
    try {
      await persist()
    } catch (error) {
      failure ??= errorMessage(error)
    }
    output({ type: 'result', status: failure || stopped ? 'ERROR' : 'SUCCESS', response, error: failure })
    finalized = true
    if (failure || stopped) process.exitCode = 1
  }
} catch (error) {
  clearTimeout(startupTimer)
  clearTimeout(closeTimer)
  clearTimeout(forceTimer)
  if (!finalized) output({ type: 'result', status: 'ERROR', response: '', error: errorMessage(error) })
  process.exitCode = 1
}
