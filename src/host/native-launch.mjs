// Inspect fixed launcher data; never ask a shell to interpret CLI arguments.
import { openSync, readSync, fstatSync, closeSync, realpathSync, statSync, existsSync } from 'node:fs'
import { dirname, extname, isAbsolute, resolve, sep, delimiter, join } from 'node:path'
import { homedir, userInfo } from 'node:os'

const invalid = () => new Error('CLI 启动入口无法确认，请配置原生程序或固定 Node/Bun 入口')
const batch = (value) => /\.(?:cmd|bat)$/i.test(value)
function text(path, limit = 128 * 1024) {
  const descriptor = openSync(path, 'r')
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size > limit) throw invalid()
    const bytes = Buffer.alloc(info.size + 1)
    const read = readSync(descriptor, bytes, 0, bytes.length, 0)
    const after = fstatSync(descriptor)
    if (read !== info.size || info.size !== after.size || info.mtimeMs !== after.mtimeMs) throw invalid()
    return bytes
      .subarray(0, read)
      .toString('utf8')
      .replace(/^\uFEFF/, '')
  } finally {
    closeSync(descriptor)
  }
}
function file(path) {
  const canonical = realpathSync(path)
  if (!statSync(canonical).isFile()) throw invalid()
  return canonical
}
function scriptRuntime(path) {
  const descriptor = openSync(path, 'r')
  try {
    const bytes = Buffer.alloc(256)
    const length = readSync(descriptor, bytes, 0, bytes.length, 0)
    const header = bytes.subarray(0, length).toString('utf8').split('\n')[0].trim()
    if (header.startsWith('#!')) {
      const match = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?)?(?:[^\s]*\/)?(node|bun)\s*$/.exec(header)
      if (!match) throw invalid()
      return match[1]
    }
    // A fixed npm bin entry can declare its runtime in the package manifest.
    for (let directory = dirname(path), depth = 0; depth < 5; depth++, directory = dirname(directory)) {
      const manifestPath = join(directory, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(text(manifestPath))
      const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {})
      if (bins.some((entry) => typeof entry === 'string' && resolve(directory, entry) === path)) {
        if (manifest.engines?.bun && !manifest.engines?.node) return 'bun'
        return 'node'
      }
      break
    }
    return /\.[cm]?js$/i.test(path) ? 'node' : undefined
  } finally {
    closeSync(descriptor)
  }
}
function runtimeProgram(runtime, platform, launcherDirectory) {
  if (runtime === 'node') return process.execPath
  if (runtime !== 'bun') throw invalid()
  const name = platform === 'win32' ? 'bun.exe' : 'bun'
  const candidates = [
    ...(launcherDirectory ? [join(launcherDirectory, name)] : []),
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .map((directory) => directory.replace(/^"|"$/g, ''))
      .filter(isAbsolute)
      .map((directory) => join(directory, name)),
    ...(process.env.BUN_INSTALL ? [join(process.env.BUN_INSTALL, 'bin', name)] : []),
    ...[homedir(), userInfo().homedir].map((home) => join(home, '.bun', 'bin', name)),
  ]
  const candidate = candidates.find((path) => existsSync(path) && statSync(path).isFile())
  if (!candidate) throw new Error('未找到 Bun，请安装该 CLI 所需的 Bun 运行时')
  return file(candidate)
}
function inspectBatch(executable, platform) {
  const source = text(file(executable)).trim().replace(/\r\n/g, '\n')
  // Nous' official fallback contains just a fixed interpreter and its encoded
  // launcher. Preserve its own bootstrap; do not guess a virtualenv interpreter.
  const hermes =
    /^@echo off\n"([^"\n%]+)" -I -c "(import base64; exec\(base64\.b64decode\('([A-Za-z0-9+/]+={0,2})'\)\))" %\*$/i.exec(
      source,
    )
  if (hermes) {
    const decoded = Buffer.from(hermes[3], 'base64')
    if (
      !isAbsolute(hermes[1]) ||
      decoded.toString('base64') !== hermes[3] ||
      !decoded.toString('utf8').startsWith('import os, re, sys\n') ||
      !decoded.toString('utf8').includes('import hermes_bootstrap') ||
      !decoded.toString('utf8').includes('from hermes_cli.main import main')
    )
      throw invalid()
    return { kind: 'python', argv: [file(hermes[1]), '-I', '-c', hermes[2]] }
  }
  const entries = new Set()
  const runtimes = new Set()
  for (const original of source.split('\n')) {
    let line = original.trim()
    if (!line || /^@?(?:echo off|rem\b.*)$/i.test(line)) continue
    // npm cmd-shim's standard final control prefix is launcher boilerplate;
    // it is discarded, and nothing from it is executed by this module.
    line = line.replace(/^endLocal & goto #_undefined_# 2>NUL \|\| title [^&\n]+ & /i, '')
    const command =
      /^@?(?:(node|bun)|"%_prog%"|"%(?:~dp0|dp0%)[\\/](node|bun)\.exe")\s+"%(?:~dp0|dp0%)[\\/]([^"\n%]+)"\s+%\*$/i.exec(
        line,
      )
    if (command) {
      const path = file(resolve(dirname(executable), command[3].replace(/[\\/]/g, sep)))
      if (!scriptRuntime(path)) throw invalid()
      entries.add(path)
      if (command[1] || command[2]) runtimes.add((command[1] || command[2]).toLowerCase())
      continue
    }
    const program = /^@?set "?_prog=(?:%(?:~dp0|dp0%)[\\/])?(node|bun)(?:\.exe)?"?$/i.exec(line)
    if (program) {
      runtimes.add(program[1].toLowerCase())
      continue
    }
    if (
      /^@?(?:goto start|:find_dp0|:start|set dp0=%~dp0|exit \/b|setlocal|endlocal|call :find_dp0)$/i.test(
        line,
      ) ||
      /^@?if (?:not )?exist "%(?:~dp0|dp0%)[\\/](?:node|bun)\.exe" \($/i.test(line) ||
      /^\)(?: else \()?$/i.test(line) ||
      /^@?set pathext=%pathext:;\.js;=;%$/i.test(line) ||
      /^@?if (?:not )?defined node_path \($/i.test(line) ||
      /^@?set "node_path=[^"\n&|<>]+"$/i.test(line)
    )
      continue
    throw invalid()
  }
  if (entries.size !== 1 || runtimes.size !== 1) throw invalid()
  const entry = [...entries][0],
    runtime = [...runtimes][0]
  if (scriptRuntime(entry) !== runtime) throw invalid()
  return { kind: runtime, argv: [runtimeProgram(runtime, platform, dirname(executable)), entry] }
}

/** Canonical npm entry for installation identity checks; Python launchers keep their identity. */
export function resolveNativeEntry(executable, platform = process.platform) {
  if (platform !== 'win32') return executable
  if (isAbsolute(executable) && !extname(executable) && !existsSync(executable)) {
    const extensions = (process.env.PATHEXT || '.EXE;.COM;.CMD;.BAT')
      .split(';')
      .map((extension) => extension.toLowerCase())
      .filter((extension) => /^\.(?:exe|com|cmd|bat)$/.test(extension))
    const candidate = [...new Set(extensions)]
      .map((extension) => executable + extension)
      .find((path) => existsSync(path) && statSync(path).isFile())
    if (candidate) executable = candidate
  }
  if (!batch(executable)) return executable
  const inspected = inspectBatch(executable, platform)
  // Keep Bun's fixed shim identity: it may pin a bundled bun.exe beside the
  // shim which cannot be recovered from only the package's JS path.
  return inspected.kind === 'node' ? inspected.argv[1] : executable
}

/** Windows CreateProcess accepts real programs, not npm command files. */
export function nativeLaunchArgv(argv, platform = process.platform) {
  if (
    !Array.isArray(argv) ||
    !argv.length ||
    argv.some((value) => typeof value !== 'string' || value.includes('\0'))
  )
    throw invalid()
  if (platform !== 'win32') {
    if (!/\.[cm]?js$/i.test(argv[0])) return [...argv]
    const entry = file(argv[0])
    return [runtimeProgram(scriptRuntime(entry), platform), entry, ...argv.slice(1)]
  }
  const executable = resolveNativeEntry(argv[0], platform),
    arguments_ = argv.slice(1)
  if (batch(executable)) return [...inspectBatch(executable, platform).argv, ...arguments_]
  if (/\.[cm]?js$/i.test(executable) || (extname(executable) === '' && scriptRuntime(executable)))
    return [runtimeProgram(scriptRuntime(executable), platform), file(executable), ...arguments_]
  return [executable, ...arguments_]
}
