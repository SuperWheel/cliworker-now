import { expect, it, vi } from 'vitest'
import { clipsNativeJobMenu, installNativeJobOverlay } from '../src/client/native-job-overlay.ts'

const bounds = (left: number, right: number, top = 0, bottom = 900) => ({
  left,
  right,
  top,
  bottom,
  width: right - left,
  height: bottom - top,
})

// Synthetic geometry matches the native rc.2 tree measured in the isolated
// Harness UI. The real menu click/hit-test is verified separately in that UI.
function fixture() {
  let menuOpen = true
  let workerVisible = true
  let workerMounted = true
  const frames = new Map<number, FrameRequestCallback>()
  const listeners = new Map<string, () => void>()
  let frameId = 0
  const styles: unknown[] = []
  let mutation!: () => void
  const disconnect = vi.fn()
  class Element {
    attributes = new Map<string, string>()
    css = { overflowX: 'visible', overflowY: 'visible', display: 'block', visibility: 'visible' }
    parentElement: Element | null = null
    constructor(
      public box: ReturnType<typeof bounds>,
      public title = false,
    ) {}
    getAttribute(key: string) {
      return this.attributes.get(key) ?? null
    }
    setAttribute(key: string, value: string) {
      this.attributes.set(key, value)
    }
    removeAttribute(key: string) {
      this.attributes.delete(key)
    }
    getBoundingClientRect() {
      return this.box
    }
    closest(selector: string): Element | null {
      if (selector.startsWith('[data-slot')) return this.title ? this : this.parentElement?.closest(selector) ?? null
      if (selector === '[hidden], [aria-hidden="true"]')
        return this.attributes.has('hidden') || this.attributes.get('aria-hidden') === 'true'
          ? this
          : this.parentElement?.closest(selector) ?? null
      return null
    }
    querySelector() {
      return menuOpen ? {} : null
    }
  }
  const body = new Element(bounds(0, 1461))
  const frame = new Element(bounds(0, 1461))
  const center = new Element(bounds(280, 804))
  const root = new Element(bounds(280, 804))
  const title = new Element(bounds(300, 776, 10, 40), true)
  const jobRoot = new Element(bounds(480, 631, 11, 39))
  const menu = new Element(bounds(480, 980, 44, 128))
  const worker = new Element(bounds(804, 1461))
  frame.parentElement = body
  center.parentElement = frame
  root.parentElement = center
  title.parentElement = root
  jobRoot.parentElement = title
  menu.parentElement = jobRoot
  worker.parentElement = frame
  for (const element of [frame, center, root])
    element.css = { ...element.css, overflowX: 'hidden', overflowY: 'hidden' }
  const view = {
    HTMLElement: Element,
    MutationObserver: class {
      constructor(callback: () => void) {
        mutation = callback
      }
      observe() {}
      disconnect = disconnect
    },
    getComputedStyle: (element: Element) => ({
      ...element.css,
      ...(element.attributes.has('data-cwn-job-overlay-overflow')
        ? { overflowX: 'visible', overflowY: 'visible' }
        : {}),
    }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback)
      return frameId
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    addEventListener: (kind: string, listener: () => void) => listeners.set(kind, listener),
    removeEventListener: (kind: string) => listeners.delete(kind),
  }
  const doc = {
    body,
    defaultView: view,
    head: { append: (style: unknown) => styles.push(style) },
    createElement: () => {
      const style = { dataset: {}, textContent: '', remove: () => styles.splice(styles.indexOf(style), 1) }
      return style
    },
    querySelectorAll: (selector: string) => {
      if (selector.includes('.cwn')) {
        worker.css.display = workerVisible ? 'block' : 'none'
        return workerMounted ? [worker] : []
      }
      return menuOpen ? [menu] : []
    },
  } as unknown as Document
  const flush = () => {
    for (const [id, callback] of frames) {
      frames.delete(id)
      callback(0)
    }
  }
  return {
    doc,
    root,
    center,
    title,
    frame,
    menu,
    styles,
    frames,
    listeners,
    disconnect,
    menuOpen: (value: boolean) => {
      menuOpen = value
      mutation()
      flush()
    },
    workerVisible: (value: boolean) => {
      workerVisible = value
      mutation()
      flush()
    },
    removeWorker: () => {
      workerMounted = false
      mutation()
      flush()
    },
    resize: () => {
      listeners.get('resize')?.()
      flush()
    },
    mutate: () => mutation(),
  }
}

it('releases only crossed clipping boundaries, keeping the viewport and nonclipping ancestors', () => {
  const f = fixture()
  const dispose = installNativeJobOverlay(f.doc)
  expect(f.root.getAttribute('data-cwn-job-overlay-overflow')).toBe('')
  expect(f.center.getAttribute('data-cwn-job-overlay-overflow')).toBe('')
  expect(f.frame.getAttribute('data-cwn-job-overlay-overflow')).toBeNull()
  expect(f.title.getAttribute('data-cwn-job-overlay-layer')).toBe('')
  // Host inline CSS and native nodes remain untouched.
  expect(f.root.css.overflowX).toBe('hidden')
  f.menuOpen(false)
  expect(f.root.getAttribute('data-cwn-job-overlay-overflow')).toBeNull()
  expect(f.center.getAttribute('data-cwn-job-overlay-overflow')).toBeNull()
  expect(f.title.getAttribute('data-cwn-job-overlay-layer')).toBeNull()
  dispose()
})

it('restores clipping when the Worker tab becomes hidden or leaves, even with Jobs still open', () => {
  const f = fixture()
  const dispose = installNativeJobOverlay(f.doc)
  f.workerVisible(false)
  expect(f.root.getAttribute('data-cwn-job-overlay-overflow')).toBeNull()
  expect(f.title.getAttribute('data-cwn-job-overlay-layer')).toBeNull()
  f.workerVisible(true)
  expect(f.title.getAttribute('data-cwn-job-overlay-layer')).toBe('')
  f.removeWorker()
  expect(f.root.getAttribute('data-cwn-job-overlay-overflow')).toBeNull()
  dispose()
})

it('restores no-longer-needed clipping after native resize without losing the open menu layer', () => {
  const f = fixture()
  const dispose = installNativeJobOverlay(f.doc)
  f.root.box = f.center.box = bounds(280, 1200)
  f.resize()
  expect(f.root.getAttribute('data-cwn-job-overlay-overflow')).toBeNull()
  expect(f.center.getAttribute('data-cwn-job-overlay-overflow')).toBeNull()
  expect(f.title.getAttribute('data-cwn-job-overlay-layer')).toBe('')
  dispose()
})

it('plugin disposal restores prior attributes and cancels pending observation and frame resources', () => {
  const f = fixture()
  f.title.setAttribute('data-cwn-job-overlay-layer', 'original')
  const dispose = installNativeJobOverlay(f.doc)
  f.mutate()
  expect(f.frames.size).toBe(1)
  dispose()
  expect(f.title.getAttribute('data-cwn-job-overlay-layer')).toBe('original')
  expect(f.root.getAttribute('data-cwn-job-overlay-overflow')).toBeNull()
  expect(f.styles).toHaveLength(0)
  expect(f.frames.size).toBe(0)
  expect(f.listeners.size).toBe(0)
  expect(f.disconnect).toHaveBeenCalledOnce()
})

it('does not release an ancestor which allows overflow or contains the complete menu', () => {
  const menu = bounds(40, 500, 20, 100)
  expect(clipsNativeJobMenu(menu, bounds(0, 800), { overflowX: 'hidden', overflowY: 'clip' })).toBe(false)
  expect(clipsNativeJobMenu(menu, bounds(0, 300), { overflowX: 'visible', overflowY: 'visible' })).toBe(false)
  expect(clipsNativeJobMenu(menu, bounds(0, 300), { overflowX: 'auto', overflowY: 'hidden' })).toBe(true)
})

it('keeps SSR and minimal renderer-registration contexts independent of browser observers', () => {
  expect(() => installNativeJobOverlay({} as Document)()).not.toThrow()
})
