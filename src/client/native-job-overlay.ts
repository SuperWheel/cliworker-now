/**
 * Harness 0.2.0-rc.2 renders JobListAction's menu inside the conversation
 * header, rather than a body portal. Its title container and clipping columns
 * can hide the menu behind a docked Worker. Keep the native DOM and ownership;
 * release only the ancestors which actually clip this open menu.
 */
const OVERFLOW = 'data-cwn-job-overlay-overflow'
const LAYER = 'data-cwn-job-overlay-layer'
const MENU =
  '[data-slot="conversation.session.header.actions"] ul[aria-label="后台任务"], ' +
  '[data-slot="conversation.session.header.actions"] ul[aria-label="Background jobs"]'

const overlayStyles = `
[${OVERFLOW}]{overflow:visible!important}
[${LAYER}]{position:relative!important;z-index:101!important}
`

type Bounds = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>
type Clip = Pick<CSSStyleDeclaration, 'overflowX' | 'overflowY'>

/** A clipping ancestor needs release only when the native menu crosses it. */
export function clipsNativeJobMenu(menu: Bounds, ancestor: Bounds, clip: Clip): boolean {
  const clips = (value: string) => value !== 'visible'
  return (
    (clips(clip.overflowX) && (menu.left < ancestor.left - 0.5 || menu.right > ancestor.right + 0.5)) ||
    (clips(clip.overflowY) && (menu.top < ancestor.top - 0.5 || menu.bottom > ancestor.bottom + 0.5))
  )
}

type Mark = {
  element: HTMLElement
  attribute: string
  previous: string | null
  clip?: Clip
}

/**
 * Install one plugin-owned compatibility lifetime. Closing Jobs, hiding the
 * Worker pane or disposing the plugin restores attributes and native CSS.
 * No React-owned node or host inline style is moved or rewritten.
 */
export function installNativeJobOverlay(doc: Document): () => void {
  const view = doc.defaultView
  if (!view?.MutationObserver || !doc.body) return () => {}
  const style = doc.createElement('style')
  style.dataset.pluginCss = 'dsh-cliworker-now/native-job-overlay'
  style.textContent = overlayStyles
  doc.head.append(style)
  let marks: Mark[] = []
  let disposed = false
  let frame: number | undefined

  const visible = (element: HTMLElement) => {
    if (element.closest('[hidden], [aria-hidden="true"]')) return false
    const box = element.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) return false
    for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
      const css = view.getComputedStyle(parent)
      if (css.display === 'none' || css.visibility !== 'visible') return false
    }
    return true
  }
  const restore = (mark: Mark) => {
    if (mark.element.getAttribute(mark.attribute) !== '') return
    if (mark.previous === null) mark.element.removeAttribute(mark.attribute)
    else mark.element.setAttribute(mark.attribute, mark.previous)
  }
  const reconcile = () => {
    frame = undefined
    if (disposed) return
    const desired = new Map<HTMLElement, Set<string>>()
    const clips = new Map<HTMLElement, Clip>()
    const add = (element: HTMLElement, attribute: string) => {
      const attributes = desired.get(element) ?? new Set<string>()
      attributes.add(attribute)
      desired.set(element, attributes)
    }
    const workerVisible = [...doc.querySelectorAll<HTMLElement>('[data-sidebar-right-session] .cwn')].some(
      visible,
    )
    if (workerVisible) {
      for (const menu of doc.querySelectorAll<HTMLElement>(MENU)) {
        if (!visible(menu) || !menu.parentElement?.querySelector(':scope > button[aria-expanded="true"]'))
          continue
        const title = menu.closest('[data-slot="conversation.session.header"] > div')
        if (!(title instanceof view.HTMLElement)) continue
        add(title, LAYER)
        const menuBox = menu.getBoundingClientRect()
        for (
          let parent: HTMLElement | null = menu.parentElement;
          parent && parent !== doc.body;
          parent = parent.parentElement
        ) {
          const css = view.getComputedStyle(parent)
          const previous = marks.find((mark) => mark.element === parent && mark.attribute === OVERFLOW)?.clip
          const clip = previous ?? { overflowX: css.overflowX, overflowY: css.overflowY }
          if (!clipsNativeJobMenu(menuBox, parent.getBoundingClientRect(), clip)) continue
          clips.set(parent, clip)
          add(parent, OVERFLOW)
        }
      }
    }
    for (const mark of marks)
      if (!desired.get(mark.element)?.has(mark.attribute)) restore(mark)
    const retained = marks.filter((mark) => desired.get(mark.element)?.has(mark.attribute))
    for (const [element, attributes] of desired) {
      for (const attribute of attributes) {
        if (retained.some((mark) => mark.element === element && mark.attribute === attribute)) continue
        retained.push({ element, attribute, previous: element.getAttribute(attribute), clip: clips.get(element) })
        element.setAttribute(attribute, '')
      }
    }
    marks = retained
  }
  const schedule = () => {
    if (!disposed && frame === undefined) frame = view.requestAnimationFrame(reconcile)
  }
  const observer = new view.MutationObserver(schedule)
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', 'aria-hidden', 'aria-expanded', 'data-sidebar-right-open', 'class', 'style'],
  })
  view.addEventListener('resize', schedule)
  reconcile()
  return () => {
    disposed = true
    observer.disconnect()
    view.removeEventListener('resize', schedule)
    if (frame !== undefined) view.cancelAnimationFrame(frame)
    for (const mark of marks) restore(mark)
    marks = []
    style.remove()
  }
}
