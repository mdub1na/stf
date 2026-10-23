import {spawn} from 'node:child_process'

const children = []
let stopping = false
function stop(code) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  const forced = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL')
    process.exit(code)
  }, 5000)
  Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() :
    new Promise(resolve => child.once('exit', resolve)))).then(() => {
    clearTimeout(forced)
    process.exit(code)
  })
}
for (const [command, args] of [
  [process.execPath, ['/opt/stf-appium/wda-session-proxy.mjs']],
  ['appium', ['--address', '0.0.0.0', '--port', '4723', '--use-drivers', 'xcuitest', '--default-capabilities', JSON.stringify({
    'appium:webDriverAgentUrl': 'http://127.0.0.1:18101',
    'appium:skipLogCapture': true,
    'appium:autoLaunch': false
  })]]
]) {
  const child = spawn(command, args, {stdio: 'inherit'})
  children.push(child)
  child.on('error', () => stop(1))
  child.on('exit', code => { if (!stopping) stop(code || 1) })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0))
