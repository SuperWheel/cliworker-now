import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useRef } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import remoteContribution from 'dsh-cliworker-now/remote'
import { active } from '../shared/types.ts'
import { Panel } from './panel.tsx'
import { useWorkers, type API } from './workers.ts'
import { styles, nativeChatStyles, modelPickerStyles } from './styles.ts'
import { BrandIcon } from './icons.tsx'

const ID = 'dsh-cliworker-now'

export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'remote']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.remote.$mount(remoteContribution), 'cliworker:remote')
  ctx.inject(['remote.cliworker'], (scope) => {
    const remote = scope.remote,
      worker = remote.cliworker
    const api: API = { $stream: (options) => remote.$stream(options), cliworker: worker }
    scope.effect(() => {
      const style = document.createElement('style')
      style.textContent = styles + nativeChatStyles + modelPickerStyles
      document.head.append(style)
      return () => style.remove()
    })
    scope.effect(() =>
      scope.sidebarRightTabs.register({
        id: ID,
        kind: 'cliworker',
        title: () => 'CLI Worker',
        guide: [
          {
            id: 'cliworker',
            order: 25,
            title: () => 'CLI Worker',
            description: () => '查看各 CLI 子 Agent 的实时工作',
            icon: () => <BrandIcon />,
          },
        ],
      }),
    )
    scope.effect(() =>
      scope.slots.inject('sidebar.right.pane.tab', () =>
        scope.slots.register({ name: 'sidebar.right.pane.tab', key: ID, inject: () => ({ api }) }, Panel),
      ),
    )
    function Header({ sessionId }: PropsRuntime<'conversation.session.header.actions'>) {
      const { snapshot } = useWorkers(api, sessionId)
      const seen = useRef(new Set<string>())
      useEffect(() => {
        seen.current.clear()
      }, [sessionId])
      const open = () => {
        if (scope.sidebarRight.mounted.getSnapshot() === sessionId) scope.sidebarRight.openTab('cliworker')
      }
      useEffect(() => {
        const ids = snapshot.workers.filter((w) => active(w.status)).map((w) => w.runId)
        if (snapshot.configuring) ids.push('configuring')
        if (ids.some((id) => !seen.current.has(id))) {
          ids.forEach((id) => seen.current.add(id))
          open()
        }
      }, [snapshot])
      const count = snapshot.workers.filter((w) => active(w.status)).length
      return (
        <Button
          variant="outline"
          size="sm"
          title="打开 CLI Worker"
          className="cwn-entry"
          icon={<BrandIcon size={16} />}
          onClick={open}
        >
          CLI{count ? ` · ${count}` : ''}
        </Button>
      )
    }
    scope.effect(() =>
      scope.slots.inject('conversation.session.header.actions', () =>
        scope.slots.register({ name: 'conversation.session.header.actions', id: ID, order: 25 }, Header),
      ),
    )
  })
}
