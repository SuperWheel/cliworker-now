import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { apply } from '../src/client/index.tsx'

// Presentation, native store state and Cordis wiring are simulated. Official
// SlotCore enforces real slot ownership and shared root-handle scope rules.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null, Tooltip: () => null }))
vi.mock('../src/client/panel.tsx', () => ({ Panel: () => null }))
vi.mock('../src/client/icons.tsx', () => ({ BrandIcon: () => null }))
vi.mock('../src/client/workers.ts', () => ({ useWorkers: () => ({ snapshot: { workers: [] } }) }))
vi.mock('dsh-cliworker-now/remote', () => ({ default: {} }))
afterEach(() => vi.unstubAllGlobals())

function fixture(hasOpenSection = true) {
  const core = new SlotCore()
  const noop = () => null
  core.register(
    {
      name: 'root',
      children: {
        'sidebar.settings': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
        'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      },
    } as any,
    noop,
  )
  let state = { open: false, activeId: '' }
  const actions = {
    close: () => {
      state = { ...state, open: false }
    },
    ...(hasOpenSection
      ? {
          openSection: (id: string) => {
            state = { open: true, activeId: id }
          },
        }
      : {}),
  }
  const nativeInstance = { actions, getSnapshot: () => state }
  // Synthetic native shell handle: registration must share this exact object;
  // production code must let the renderer bind actions rather than call create.
  const nativeHandle = {
    spec: { init: () => state, actions },
    create: vi.fn(() => nativeInstance),
  }
  const nativeSettings = () =>
    core.register(
      {
        name: 'sidebar.settings',
        store: nativeHandle,
        children: { 'settings.section': { kind: 'list', scope: 'root' } },
      } as any,
      noop,
    )
  const disposers: (() => void)[] = []
  const effect = (run: () => unknown) => {
    const dispose = run()
    if (typeof dispose === 'function') disposers.push(dispose as () => void)
    return dispose
  }
  const ctx: any = {
    effect,
    inject: (_names: string[], callback: (scope: unknown) => void) => callback(ctx),
    slots: {
      inject: (name: string, callback: () => () => void) => {
        let current: (() => void) | undefined
        const update = () => {
          current?.()
          current = core.specDynamic(name) ? callback() : undefined
        }
        const off = core.subscribeDeclaration(name, update)
        update()
        return () => {
          off()
          current?.()
          current = undefined
        }
      },
      register: core.register.bind(core),
      entriesOfSlot: core.entriesOfSlot.bind(core),
    },
    remote: { $mount: () => () => {}, cliworker: {} },
    sidebarRightTabs: { register: () => () => {} },
  }
  vi.stubGlobal('document', {
    createElement: () => ({ textContent: '', remove: vi.fn() }),
    head: { append: vi.fn() },
  })
  return {
    core,
    ctx,
    nativeSettings,
    nativeHandle,
    nativeInstance,
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

it.each(['native-first', 'plugin-first'])(
  'shares the native root store without claiming settings slots: %s',
  async (order) => {
    const f = fixture()
    if (order === 'native-first') f.nativeSettings()
    expect(() => apply(f.ctx)).not.toThrow()
    if (order === 'plugin-first') expect(f.nativeSettings).not.toThrow()
    expect(f.core.entries('sidebar.right.pane.tab')).toHaveLength(1)
    expect(f.core.entries('conversation.session.header.utilities')).toHaveLength(1)
    const panel = f.core.entries('sidebar.right.pane.tab')[0]!
    const openNative = panel.inject!().openNativeSettings as () => void
    expect(openNative).toThrow('Harness 原生设置入口暂不可用')
    const bridge = f.core.entries('shell.overlay')[0]!
    expect(bridge.store).toBe(f.nativeHandle)
    expect(f.nativeHandle.create).not.toHaveBeenCalled()
    expect(f.core.specDynamic('settings.section')).toEqual({ kind: 'list', scope: 'root' })
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        createElement(bridge.component as any, bridge.inject!(f.nativeInstance.actions as never)),
      )
    })
    openNative()
    expect(f.nativeInstance.getSnapshot()).toEqual({ open: true, activeId: 'models' })
    expect(f.nativeHandle.create).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
    expect(openNative).toThrow('Harness 原生设置入口暂不可用')
    f.dispose()
    expect(f.core.entries('sidebar.right.pane.tab')).toHaveLength(0)
    expect(f.core.entries('conversation.session.header.utilities')).toHaveLength(0)
    expect(f.core.entries('shell.overlay')).toHaveLength(0)
    expect(f.core.specDynamic('settings.section')).toEqual({ kind: 'list', scope: 'root' })
    expect(f.core.entries('sidebar.settings')).toHaveLength(1)
    f.nativeInstance.actions.close()
    expect(f.nativeInstance.getSnapshot().open).toBe(false)
  },
)

it('keeps the plugin available when native settings has no compatible root-store action', () => {
  const f = fixture(false)
  f.nativeSettings()
  expect(() => apply(f.ctx)).not.toThrow()
  expect(f.core.entries('shell.overlay')).toHaveLength(0)
  expect(f.core.entries('conversation.session.header.utilities')).toHaveLength(1)
  const panel = f.core.entries('sidebar.right.pane.tab')[0]!
  expect(panel.inject!().openNativeSettings).toThrow('Harness 原生设置入口暂不可用')
  expect(f.nativeHandle.create).not.toHaveBeenCalled()
  f.dispose()
})

it('revokes native navigation immediately when its owner unloads while keeping plugin conversations registered', async () => {
  const f = fixture()
  const closeNative = f.nativeSettings()
  apply(f.ctx)
  const bridge = f.core.entries('shell.overlay')[0]!
  const panel = f.core.entries('sidebar.right.pane.tab')[0]!
  const openNative = panel.inject!().openNativeSettings as () => void
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(
      createElement(bridge.component as any, bridge.inject!(f.nativeInstance.actions as never)),
    )
  })
  closeNative()
  expect(f.core.entries('shell.overlay')).toHaveLength(0)
  expect(openNative).toThrow('Harness 原生设置入口暂不可用')
  expect(f.core.entries('sidebar.right.pane.tab')).toHaveLength(1)
  await act(async () => renderer.unmount())
  f.dispose()
})
