import { IconSettingsOutlineRegular, IconCopyOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CliId } from '../shared/types.ts'
import antigravity from './assets/antigravity.png'
import codex from './assets/codex.png'
import claude from './assets/claude-code.png'
import kimiLight from './assets/kimi-light.png'
import kimiDark from './assets/kimi-dark.png'
import mimo from './assets/mimo-code.png'
import logo from './assets/cliworker-now-logo.png'

const icons = { antigravity, codex, claude, mimo }

/** User-provided transparent PNGs, bundled locally without remote asset requests. */
export function BrandIcon({ cli, size = 22 }: { cli?: CliId; size?: number }) {
  return (
    <span className="cwn-brand" aria-hidden="true" style={{ width: size, height: size }}>
      {cli === 'kimi' ? (
        <>
          <img className="cwn-icon-light" src={kimiLight} alt="" />
          <img className="cwn-icon-dark" src={kimiDark} alt="" />
        </>
      ) : (
        <img src={cli ? icons[cli] : logo} alt="" />
      )}
    </span>
  )
}

const paths = {
  back: 'm14 5-7 7 7 7M7 12h13',
  chevron: 'm9 5 7 7-7 7',
  search: 'm20 20-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  send: 'M12 20V4m-7 7 7-7 7 7',
  tool: 'm5 7 5 5-5 5m8 0h6',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
} as const
export function Glyph({ name }: { name: keyof typeof paths | 'stop' | 'copy' }) {
  if (name === 'settings') return <IconSettingsOutlineRegular size={18} />
  if (name === 'send')
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z"
          fill="currentColor"
        />
      </svg>
    )
  if (name === 'copy') return <IconCopyOutlineRegular size={16} />
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'stop' ? (
        <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
      ) : (
        <path d={paths[name]} />
      )}
    </svg>
  )
}
