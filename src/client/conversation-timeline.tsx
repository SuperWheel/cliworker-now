import { Fragment, useEffect, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { CLI_LABELS, cliOf, type TimelineItem, type Worker } from '../shared/types.ts'
import { CopyText } from './copy-text.tsx'
import { Glyph } from './icons.tsx'
const labels: Record<string, string> = {
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
  running: '运行中',
  queued: '排队中',
  stopping: '正在停止',
}
const markdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }
const runOf = (item: TimelineItem) => item.id.split(':')[0]
function ProcessRow({ item }: { item: TimelineItem }) {
  return item.kind === 'tool' || item.kind === 'diagnostic' ? (
    <details className="cwn-tool">
      <summary>
        <Glyph name="tool" />
        <span className="cwn-tool-title">{item.text}</span>
        <small title={item.runStatus ? `CLI 最后状态：${item.state}；未收到最终工具状态` : undefined}>
          {item.runStatus ? (item.runStatus === 'interrupted' ? '本轮已中断' : '本轮已结束') : item.state}
        </small>
      </summary>
      <pre>{item.detail}</pre>
    </details>
  ) : (
    <div className="cwn-process-event">{labels[item.state ?? item.text] ?? item.text}</div>
  )
}
function Progress({ rows, item, worker }: { rows: TimelineItem[]; item: TimelineItem; worker?: Worker }) {
  const [now, setNow] = useState(Date.now)
  const isRunning =
    !item.runEndedAt &&
    worker?.runId === runOf(item) &&
    ['running', 'queued', 'stopping'].includes(worker.status)
  useEffect(() => {
    if (!isRunning) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [isRunning])
  const start = Date.parse(item.runStartedAt ?? '')
  const end = item.runEndedAt ? Date.parse(item.runEndedAt) : isRunning ? now : NaN
  const seconds =
    Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1000)) : undefined
  const label = labels[item.runOutcome ?? ''] ?? (isRunning ? labels[worker!.status] : '工作过程')
  return (
    <details className="cwn-progress">
      <summary>
        {label}
        {seconds !== undefined ? `，用时 ${seconds}秒` : ''}
        <span className="cwn-progress-chevron">
          <Glyph name="chevron" />
        </span>
      </summary>
      <div className="cwn-process-body">
        <p className="cwn-process-note">以下为 CLI 公开的工作记录；未公开的思考内容无法展示。</p>
        {rows
          .filter((row) => !['user', 'assistant'].includes(row.kind))
          .map((row) => (
            <ProcessRow key={row.id} item={row} />
          ))}
      </div>
    </details>
  )
}
export function ConversationTimeline({ items, worker }: { items: TimelineItem[]; worker?: Worker }) {
  const runs = new Map<string | undefined, TimelineItem[]>()
  for (const item of items) {
    const id = runOf(item)
    runs.set(id, [...(runs.get(id) ?? []), item])
  }
  const seen = new Set<string | undefined>()
  return (
    <>
      {items.map((item) => {
        const id = runOf(item)
        const first = item.kind !== 'user' && !seen.has(id)
        if (item.kind !== 'user') seen.add(id)
        return (
          <Fragment key={item.id}>
            {first && <Progress rows={runs.get(id)!} item={item} worker={worker} />}
            {(item.kind === 'user' || item.kind === 'assistant') && (
              <article className={`cwn-message ${item.kind}`}>
                <div className={item.kind === 'assistant' ? 'cwn-markdown' : 'cwn-text'}>
                  {item.kind === 'assistant' ? (
                    <MarkdownText text={item.text} labels={markdownLabels} />
                  ) : (
                    item.text
                  )}
                </div>
                <div className="cwn-message-label">
                  <span className="cwn-sr-only">
                    {item.kind === 'user' ? '你' : worker ? CLI_LABELS[cliOf(worker.preference)] : 'CLI'}
                  </span>
                  {item.kind === 'assistant' && item.text && (
                    <CopyText text={item.text} label="复制回复" iconOnly />
                  )}
                  <time>
                    {new Date(item.time).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    })}
                  </time>
                  {item.kind === 'user' && item.text && (
                    <CopyText text={item.text} label="复制消息" iconOnly />
                  )}
                </div>
              </article>
            )}
          </Fragment>
        )
      })}
    </>
  )
}
