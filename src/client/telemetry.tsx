import { IconDatabaseOutlineRegular, IconGaugeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { compactTokens, type Telemetry, type TokenUsage } from '../shared/telemetry.ts'
import type { Worker } from '../shared/types.ts'

export function UsageIndicator({ usage, reply = false }: { usage?: TokenUsage; reply?: boolean }) {
  const scope = {
    response: '本次回复',
    run: '本轮任务',
    session: 'CLI 会话累计',
    reported: 'CLI 报告值（不与其他轮次重复相加）',
  }
  const hint = usage
    ? [
        scope[usage.scope],
        `总计 ${usage.total} tokens`,
        usage.input !== undefined && `输入 ${usage.input}`,
        usage.output !== undefined && `输出 ${usage.output}`,
        usage.cacheRead !== undefined && `缓存读取 ${usage.cacheRead}`,
      ]
        .filter(Boolean)
        .join('；')
    : 'CLI 未提供此回复的 Token 用量'
  return (
    <span className="cwn-stat cwn-usage" title={hint} aria-label={hint}>
      <IconDatabaseOutlineRegular size={14} />
      <span>
        {reply ? '用量 ' : ''}
        {usage ? `${compactTokens(usage.total)} tok` : '— tok'}
      </span>
    </span>
  )
}
export function ComposerTelemetry({
  worker,
  telemetry,
  statusLabel,
}: {
  worker: Worker
  telemetry?: Telemetry
  statusLabel: string
}) {
  const used = telemetry?.contextUsed,
    capacity = telemetry?.contextCapacity
  const percent =
    used !== undefined && capacity !== undefined && capacity > 0
      ? Math.min(100, Math.round((used / capacity) * 100))
      : undefined
  const hint =
    percent !== undefined
      ? `上下文已用 ${percent}%；${used} / ${capacity} tokens`
      : 'CLI 未提供当前上下文占用或容量，无法计算百分比；累计 Token 用量不等于上下文占用'
  return (
    <div className="cwn-compose-state cwn-telemetry">
      <span className="cwn-stat cwn-run-stat" title={statusLabel}>
        <IconGaugeOutlineRegular size={14} />
        <span>{statusLabel}</span>
      </span>
      <UsageIndicator usage={telemetry?.usage} />
      <span className="cwn-stat cwn-context" title={hint} aria-label={hint}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="5.5" className="cwn-context-track" />
          {percent !== undefined && (
            <circle
              cx="7"
              cy="7"
              r="5.5"
              className="cwn-context-fill"
              strokeDasharray={`${percent * 0.345575} 34.5575`}
              transform="rotate(-90 7 7)"
            />
          )}
        </svg>
        <span>{percent === undefined ? '—' : `${percent}%`}</span>
      </span>
    </div>
  )
}
