import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountAction, AccountFrame } from '../shared/accounts.ts'
import { CLI_LABELS, type CliId } from '../shared/types.ts'
import { value, type API } from './workers.ts'
import { accountTerminalCSS } from './account-terminal-css.ts'

/** Only mounted after a human selects an account action. No prompt is auto-entered. */
export function AccountTerminal({
  api,
  sessionId,
  cli,
  action,
  onClose,
  onFinished,
}: {
  api: API
  sessionId: string
  cli: CliId
  action: AccountAction
  onClose: () => void
  onFinished: () => void
}) {
  const element = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onClose, onFinished })
  callbacks.current = { onClose, onFinished }
  const stop = useRef<() => Promise<void>>(async () => {})
  const [phase, setPhase] = useState<'loading' | 'running' | 'closed' | 'failed' | 'stopping'>('loading')
  const [instruction, setInstruction] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!element.current) return
    setPhase('loading')
    setInstruction('')
    setNotice('')
    let alive = true,
      id = '',
      ended = false,
      lastSeq = 0,
      queuedBytes = 0,
      resizeFrame = 0
    const startup = new AbortController()
    let stream: ReturnType<API['$stream']> | undefined
    let inputQueue = Promise.resolve()
    const terminal = new Terminal({
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: true,
      scrollback: 1000,
      disableStdin: true,
      // Do not turn CLI-controlled escape sequences into browser navigation.
      linkHandler: { activate: () => {} },
      allowProposedApi: false,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(element.current)
    const theme = () => {
      const css = getComputedStyle(document.body)
      terminal.options.theme = {
        background: css.getPropertyValue('--dsw-alias-bg-layer-2').trim() || '#ffffff',
        foreground: css.getPropertyValue('--dsw-alias-label-primary').trim() || '#222222',
        cursor: css.getPropertyValue('--dsw-alias-label-primary').trim() || '#222222',
      }
    }
    theme()
    const themeObserver = new MutationObserver(theme)
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-ds-dark-theme', 'style', 'class'],
    })
    const finish = (failed = false) => {
      terminal.options.disableStdin = true
      if (alive) setPhase(failed ? 'failed' : 'closed')
      if (!ended) {
        ended = true
        if (alive) callbacks.current.onFinished()
      }
    }
    const resize = () => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        if (!alive) return
        fit.fit()
        if (id && !ended)
          void api.cliworker.accountResize(sessionId, id, terminal.cols, terminal.rows).catch(() => undefined)
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element.current)
    resize()
    const input = terminal.onData((data) => {
      if (!id || ended || queuedBytes + data.length > 16_384) return
      queuedBytes += data.length
      inputQueue = inputQueue
        .then(async () => {
          if (alive && !ended) value(await api.cliworker.accountWrite(sessionId, id, data))
        })
        .catch(() => {
          if (alive) setNotice('输入未能送达，请关闭终端后重试')
        })
        .finally(() => {
          queuedBytes -= data.length
        })
    })
    let stopping: Promise<void> | undefined
    const stopSession = () => {
      startup.abort()
      terminal.options.disableStdin = true
      if (!id) return Promise.resolve()
      return (stopping ??= (async () => {
        value(await api.cliworker.accountStop(sessionId, id))
        if (!ended) finish()
      })().catch((error) => {
        stopping = undefined
        throw error
      }))
    }
    stop.current = stopSession
    void (async () => {
      try {
        const result = JSON.parse(
          value(await api.cliworker.accountStart(sessionId, cli, action, startup.signal)),
        ) as { id: string; instruction: string }
        id = result.id
        if (!alive || startup.signal.aborted) {
          await stopSession()
          return
        }
        setInstruction(result.instruction)
        setPhase('running')
        terminal.options.disableStdin = false
        terminal.focus()
        resize()
        const accountStream = api.$stream<string>({
          name: 'CLI 账号终端',
          open: (signal) => api.cliworker.accountWatch(sessionId, id, signal),
          ended: () => new Error('账号终端连接已结束'),
        })
        stream = accountStream
        for await (const item of accountStream) {
          const frame = JSON.parse(item.value) as AccountFrame
          if (alive && frame.seq > lastSeq) {
            lastSeq = frame.seq
            if (frame.data) terminal.write(frame.data)
            if (frame.message) setNotice(frame.message)
          }
          item.accept()
          if (frame.status === 'closed' || frame.status === 'failed') {
            finish(frame.status === 'failed')
            break
          }
        }
        if (!ended) {
          if (alive) setNotice('账号终端连接已结束')
          finish(true)
          await stopSession()
        }
        await accountStream.dispose()
      } catch {
        if (alive && !startup.signal.aborted) {
          setNotice('账号终端暂不可用，请确认此 CLI 没有运行任务且当前项目允许执行，再重试')
          finish(true)
        }
        if (id) await stopSession().catch(() => undefined)
      }
    })()
    const cleanup = stopSession
    return () => {
      alive = false
      startup.abort()
      observer.disconnect()
      themeObserver.disconnect()
      cancelAnimationFrame(resizeFrame)
      input.dispose()
      terminal.dispose()
      void cleanup().catch(() => undefined)
      void stream?.dispose().catch(() => undefined)
    }
  }, [api, sessionId, cli, action])

  const close = async () => {
    setPhase('stopping')
    try {
      await stop.current()
      callbacks.current.onClose()
    } catch {
      setPhase('failed')
      setNotice('终端尚未完成清理，请再次关闭')
    }
  }
  return (
    <section className="cwn-account-terminal">
      <style>{accountTerminalCSS}</style>
      <div className="cwn-account-terminal-head">
        <strong>{CLI_LABELS[cli]} 账号终端</strong>
        <Button variant="ghost" size="sm" onClick={() => void close()} disabled={phase === 'stopping'}>
          关闭终端
        </Button>
      </div>
      {(phase === 'loading' || phase === 'stopping') && (
        <div className="cwn-loading" role="status">
          <StateDot state="ongoing" size={14} />
          {phase === 'loading' ? '正在启动账号终端…' : '正在关闭终端…'}
        </div>
      )}
      {instruction && <p className="cwn-account-instruction">{instruction}</p>}
      <div
        className="cwn-account-terminal-view"
        ref={element}
        aria-label={`${CLI_LABELS[cli]} 原生账号终端`}
      />
      {notice && (
        <p className="cwn-account-instruction" role="status">
          {notice}
        </p>
      )}
      <p className="cwn-account-privacy">
        输入直接交给此 CLI，插件不保存账号终端记录。关闭设置会结束该终端。
      </p>
    </section>
  )
}
