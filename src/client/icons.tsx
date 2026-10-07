import { IconSettingsOutlineRegular, IconCopyOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CliId } from '../shared/types.ts'
import antigravity from './assets/antigravity.png'
import codex from './assets/codex.png'
import claude from './assets/claude-code.png'
import kimiLight from './assets/kimi-light.png'
import kimiDark from './assets/kimi-dark.png'
import mimo from './assets/mimo-code.png'
import zcode from './assets/zcode.png'
import omp from './assets/omp.png'
import pi from './assets/pi.png'
import hermes from './assets/hermes.png'
import opencode from './assets/opencode.png'
import grok from './assets/grok.png'
import projectLogo from './assets/cliworker-now-logo.png'

const icons: Partial<Record<CliId, string>> = {
  antigravity,
  codex,
  claude,
  mimo,
  zcode,
  grok,
  omp,
  pi,
  hermes,
  opencode,
}

const optical: Partial<Record<CliId, { scale: number; x: number; y: number; mono: boolean }>> = {
  zcode: { scale: 1.1518, x: -0.5051754385964912, y: 0.22962519936204143, mono: true },
  omp: { scale: 1.2796, x: 0.0, y: 0.0, mono: false },
  pi: { scale: 1.3012, x: -2.023397129186603, y: -1.5045773524720893, mono: false },
  hermes: { scale: 0.9518, x: -1.8595773524720893, y: -0.15180223285486444, mono: true },
  opencode: { scale: 1.2087, x: -0.048193779904306226, y: 0.0, mono: true },
  grok: { scale: 0.8523, x: -1.1214473684210524, y: 0.7136483253588516, mono: true },
}

/** User-provided transparent PNGs, bundled locally without remote asset requests. */
export function BrandIcon({
  cli,
  size = cli ? 22 : 32,
  tone = 'color',
}: {
  cli?: CliId
  size?: number
  tone?: 'color' | 'monochrome'
}) {
  const asset = cli ? optical[cli] : undefined
  return (
    <span className="cwn-brand" aria-hidden="true" style={{ width: size, height: size }}>
      {!cli && tone === 'color' ? (
        <img className="cwn-project-logo-color" src={projectLogo} alt="" />
      ) : !cli ? (
        <span
          className="cwn-project-logo monochrome"
          style={{ maskImage: `url("${projectLogo}")`, WebkitMaskImage: `url("${projectLogo}")` }}
        />
      ) : cli === 'kimi' ? (
        <>
          <img className="cwn-icon-light" src={kimiLight} alt="" />
          <img className="cwn-icon-dark" src={kimiDark} alt="" />
        </>
      ) : cli && !icons[cli] ? (
        <span style={{ fontSize: size * 0.48, fontWeight: 600 }}>
          {
            (
              {
                zcode: 'Z',
                grok: 'G',
                omp: 'O',
                pi: 'π',
                hermes: 'H',
                harness: 'H',
                opencode: 'OC',
              } as Record<string, string>
            )[cli]
          }
        </span>
      ) : (
        <img
          src={icons[cli]}
          className={asset?.mono ? 'cwn-icon-mono' : undefined}
          style={
            asset ? { transform: `translate(${asset.x}%, ${asset.y}%) scale(${asset.scale})` } : undefined
          }
          alt=""
        />
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
  logout: 'M9 4H5v16h4M12 12h9m-4-4 4 4-4 4',
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
