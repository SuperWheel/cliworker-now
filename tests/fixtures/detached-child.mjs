// Synthetic OS-process fixture: child deliberately owns a different process group.
import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,
  stdio: 'ignore',
})
process.stdout.write(String(child.pid) + '\n')
setInterval(() => {}, 1000)
