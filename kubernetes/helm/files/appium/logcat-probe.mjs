import {spawn} from 'node:child_process'
import {once} from 'node:events'

// Logcat is collected by an ADB child process that Appium must be able to stop.
const probe = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
  stdio: ['pipe', 'ignore', 'ignore']
})
const closed = new Promise(resolve => probe.once('close', resolve))
try {
  await once(probe, 'spawn')
  probe.once('error', error => {
    process.stderr.write(`Cannot signal the logcat probe (${error.code}); disabling automatic logcat capture\n`)
  })
  const canStopChild = probe.kill('SIGTERM')
  process.stdout.write(`${!canStopChild}\n`)
}
finally {
  // EOF also stops the probe when the container rejects SIGTERM.
  probe.stdin.destroy()
  await closed
}
