// The native terminal owner tracks descendants across their own process groups.
// Keep this root alive until the Host acknowledges cleanup; never merge stderr
// into the CLI JSON protocol. Envelopes are transport only, not agent events.
import { spawn } from 'node:child_process'
import { nativeLaunchArgv } from './native-launch.mjs'
const [executable, ...args] = nativeLaunchArgv(process.argv.slice(2))
const send = (channel, fields) => process.stdout.write(JSON.stringify({ channel, ...fields }) + '\n')
const keepAlive = setInterval(() => {}, 60000)
const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', (bytes) => send('stdout', { bytes: bytes.toString('base64') }))
child.stderr.on('data', (bytes) => send('stderr', { bytes: bytes.toString('base64') }))
child.on('error', (error) => send('error', { message: error.message }))
child.on('close', (exitCode, signal) => send('exit', { exitCode, signal }))
// Native terminal teardown kills descendants first, then this root.
process.on('SIGTERM', () => {
  clearInterval(keepAlive)
  process.exit(0)
})
