import { useEffect, useState } from 'react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { Worker, WorkerSnapshot } from '../shared/types.ts'

export type Snapshot = WorkerSnapshot & { configuring?: boolean }
export type API = Pick<ClientRemote, '$stream' | 'cliworker'>
export const value = <T>(result: RemoteResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
const empty = (workers: Worker[] = []): Snapshot => ({ workers, timeline: [], revision: 0, truncated: false })

export function useWorkers(api: API, session: string, selected = '') {
  const key = JSON.stringify([session, selected])
  const [attempt, retry] = useState(0)
  const [state, setState] = useState(() => ({ key, session, snapshot: empty(), error: '', connecting: true }))
  useEffect(() => {
    let alive = true
    setState((old) => ({
      key,
      session,
      snapshot: old.key === key ? old.snapshot : empty(old.session === session ? old.snapshot.workers : []),
      error: '',
      connecting: true,
    }))
    const stream = api.$stream<string>({
      name: `CLI Worker ${session}`,
      open: (signal) => api.cliworker.watch(session, selected, signal),
      ended: () => new Error('连接已结束'),
    })
    void (async () => {
      try {
        for await (const item of stream) {
          const snapshot: Snapshot = JSON.parse(item.value)
          if (snapshot.selected && snapshot.selected.id !== selected) throw new Error('收到不匹配的任务记录')
          if (alive) setState({ key, session, snapshot, error: '', connecting: false })
          item.accept()
        }
        if (alive) throw new Error('连接已结束')
      } catch (error) {
        if (alive) setState((old) => ({ ...old, error: String(error), connecting: false }))
      }
    })()
    return () => {
      alive = false
      void stream.dispose().catch(() => undefined)
    }
  }, [api, session, selected, key, attempt])
  // React effects run after paint: never show the previous worker during that gap.
  const current =
    state.key === key
      ? state
      : {
          snapshot: empty(state.session === session ? state.snapshot.workers : []),
          error: '',
          connecting: true,
        }
  return { ...current, reconnect: () => retry((n) => n + 1) }
}
