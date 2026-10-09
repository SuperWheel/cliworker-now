import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useRef } from 'react'
import type { PropsRuntime, SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import remoteContribution from 'dsh-cliworker-now/remote'
import { active } from '../shared/types.ts'
import { Panel } from './panel.tsx'
import { useWorkers, type API } from './workers.ts'
import {
  styles,
  nativeChatStyles,
  modelPickerStyles,
  telemetryStyles,
  nativeInteractionStyles,
  hoverFeedbackStyles,
  conversationInteractionStyles,
  settingsStyles,
  rolePresetStyles,
} from './styles.ts'
import { BrandIcon } from './icons.tsx'
import { installNativeJobOverlay } from './native-job-overlay.ts'
import { workerManagementStyles } from './management-styles.ts'
import { renameCopyStyles } from './rename-copy-styles.ts'

const ID = 'dsh-cliworker-now'

export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'remote']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.remote.$mount(remoteContribution), 'cliworker:remote')
  ctx.inject(['remote.cliworker'], (scope) => {
    const remote = scope.remote,
      worker = remote.cliworker
    const api: API = { $stream: (options) => remote.$stream(options), cliworker: worker }
    let nativeSettingsOpen: (() => void) | undefined
    function NativeSettingsBridge({ open }: { open?: () => void }) {
      useEffect(() => {
        nativeSettingsOpen = open
        return () => {
          if (nativeSettingsOpen === open) nativeSettingsOpen = undefined
        }
      }, [open])
      return null
    }
    scope.effect(() =>
      scope.slots.inject('settings.section', () =>
        scope.slots.inject('shell.overlay', () => {
          // Harness 0.2.0-rc.2 compatibility: share the shell's existing root
          // handle. The renderer owns instance creation, binding and disposal;
          // we neither create its store nor redeclare its settings slots.
          // Use SlotCore's dynamic inspection signature; sidebar.settings is
          // owned by an optional native package, not declared by this plugin.
          const ledger: Pick<SlotCore, 'entriesOfSlot'> = scope.slots
          const handle = ledger.entriesOfSlot('sidebar.settings')[0]?.store
          if (
            !handle ||
            typeof handle === 'function' ||
            typeof handle.spec?.actions?.openSection !== 'function'
          )
            return () => {}
          const dispose = scope.slots.register(
            {
              name: 'shell.overlay',
              id: `${ID}.native-settings`,
              store: handle,
              inject: (actions) => ({
                open:
                  typeof actions.openSection === 'function' ? () => actions.openSection('models') : undefined,
              }),
            },
            NativeSettingsBridge,
          )
          return () => {
            nativeSettingsOpen = undefined
            dispose()
          }
        }),
      ),
    )
    scope.effect(() => {
      const style = document.createElement('style')
      style.textContent =
        styles +
        nativeChatStyles +
        modelPickerStyles +
        telemetryStyles +
        nativeInteractionStyles +
        hoverFeedbackStyles +
        conversationInteractionStyles +
        settingsStyles +
        rolePresetStyles +
        workerManagementStyles +
        renameCopyStyles
      document.head.append(style)
      return () => style.remove()
    })
    scope.effect(() => installNativeJobOverlay(document))
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
        scope.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: ID,
            inject: () => ({
              api,
              openNativeSettings: () => {
                if (!nativeSettingsOpen) throw new Error('Harness 原生设置入口暂不可用')
                nativeSettingsOpen()
              },
            }),
          },
          Panel,
        ),
      ),
    )
    function Header({ sessionId }: PropsRuntime<'conversation.session.header.utilities'>) {
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
      return (
        <Tooltip label="打开 CLI Worker" side="bottom" portal>
          <Button
            variant="ghost"
            size="sm"
            aria-label="打开 CLI Worker"
            className="cwn-entry"
            icon={<BrandIcon size={16} />}
            onClick={open}
          />
        </Tooltip>
      )
    }
    scope.effect(() =>
      scope.slots.inject('conversation.session.header.utilities', () =>
        scope.slots.register({ name: 'conversation.session.header.utilities', id: ID, order: -20 }, Header),
      ),
    )
  })
}
