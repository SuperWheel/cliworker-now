import { IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { compactTokens, type Telemetry, type TokenUsage } from '../shared/telemetry.ts'
import type { Worker } from '../shared/types.ts'
import { StatPopover } from './stat-popover.tsx'

export function UsageIndicator({ usage, reply = false }: { usage?: TokenUsage; reply?: boolean }) {
  const scope = {
    response: '本次回复',
    run: '本轮任务',
    session: 'CLI 会话累计',
    reported: 'CLI 报告值（不跨轮重复相加）',
  }
  const total = usage ? `${compactTokens(usage.total)} tok` : '— tok'
  return (
    <StatPopover
      label={reply ? `用量 ${total}` : total}
      className={`cwn-stat cwn-usage${reply ? ' cwn-reply-usage' : ''}`}
      trigger={
        <>
          <IconDatabaseOutlineRegular size={14} />
          <span>
            {reply ? '用量 ' : ''}
            {total}
          </span>
        </>
      }
    >
      <div className="cwn-stat-title">
        <span>
          <IconDatabaseOutlineRegular size={14} />
          Token 用量
        </span>
        <span>{usage ? `${usage.total.toLocaleString('en-US')} tok` : '—'}</span>
      </div>
      <div className="cwn-stat-rule" />
      {usage ? (
        <dl className="cwn-stat-details">
          <dt>统计范围</dt>
          <dd>{scope[usage.scope]}</dd>
          {usage.input !== undefined && (
            <>
              <dt>输入</dt>
              <dd>{usage.input.toLocaleString('en-US')} tok</dd>
            </>
          )}
          {usage.cacheRead !== undefined && (
            <>
              <dt>缓存读取</dt>
              <dd>{usage.cacheRead.toLocaleString('en-US')} tok</dd>
            </>
          )}
          {usage.output !== undefined && (
            <>
              <dt>输出</dt>
              <dd>{usage.output.toLocaleString('en-US')} tok</dd>
            </>
          )}
        </dl>
      ) : (
        <p>CLI 尚未提供可核验的用量。</p>
      )}
    </StatPopover>
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
  const label = percent === undefined ? '上下文占用暂不可用' : `上下文已用 ${percent}%`
  return (
    <div className="cwn-compose-state cwn-telemetry">
      <span className="cwn-stat cwn-run-stat">
        <span className={`cwn-dot ${worker.status}`} />
        <span>{statusLabel}</span>
      </span>
      <UsageIndicator usage={telemetry?.usage} />
      <StatPopover
        label={label}
        tooltip={label}
        context
        className="cwn-stat cwn-context"
        trigger={
          <>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="7" cy="7" r="5.5" className="cwn-context-track" />
              {percent !== undefined && (
                <circle
                  cx="7"
                  cy="7"
                  r="5.5"
                  className="cwn-context-fill"
                  strokeDasharray={`${(percent * Math.PI * 11) / 100} ${Math.PI * 11}`}
                  transform="rotate(-90 7 7)"
                />
              )}
            </svg>
            <span>{percent === undefined ? '—' : `${percent}%`}</span>
          </>
        }
      >
        <div className="cwn-context-header">
          <span>{label}</span>
          {used !== undefined && capacity !== undefined && (
            <strong>
              {telemetry?.contextEstimated ? '~' : ''}
              {compactTokens(used)} / {compactTokens(capacity)}
            </strong>
          )}
        </div>
        {percent !== undefined && (
          <div className="cwn-context-bar">
            <span style={{ width: `${percent}%` }} />
          </div>
        )}
        <p className="cwn-context-source">
          {telemetry?.contextSource ??
            (percent === undefined ? 'CLI 尚未提供上下文占用与容量。' : 'CLI 报告的上下文占用')}
        </p>
        {used !== undefined && capacity !== undefined && (
          <dl className="cwn-stat-details">
            <dt>{telemetry?.contextEstimated ? '估算占用' : '已用'}</dt>
            <dd>{used.toLocaleString('en-US')} tok</dd>
            <dt>上下文容量</dt>
            <dd>{capacity.toLocaleString('en-US')} tok</dd>
          </dl>
        )}
      </StatPopover>
    </div>
  )
}
