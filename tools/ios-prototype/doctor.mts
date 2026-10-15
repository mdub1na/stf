import {runCommand, runJson} from './process.mts'

interface DoctorOptions {
  goIos: string
  iproxy: string
  tunnelPort: number
  udid?: string
}

export async function diagnose(options: DoctorOptions) {
  const checks: Array<{name: string, passed: boolean, detail: unknown}> = []
  const check = async(name: string, action: () => Promise<unknown>) => {
    try {
      checks.push({name, passed: true, detail: await action()})
    }
    catch (error) {
      checks.push({name, passed: false, detail: (error as Error).message})
    }
  }
  checks.push({name: 'linux', passed: process.platform === 'linux', detail: process.platform})
  await check('go-ios', () => runJson(options.goIos, ['version']))
  await check('iproxy', () => runCommand(options.iproxy, ['--version']))
  await check('devices', async() => {
    const result = await runJson(options.goIos, ['list']) as {deviceList?: string[]}
    if (!Array.isArray(result.deviceList)) {
      throw new Error('Unexpected device list from go-ios')
    }
    if (options.udid && !result.deviceList.includes(options.udid)) {
      throw new Error('Selected iPhone is not connected')
    }
    return result.deviceList
  })
  if (options.udid) {
    await check('pairing', () => runJson(options.goIos, ['--udid=' + options.udid, 'info']))
    await check('tunnel', async() => {
      const result = await runJson(options.goIos, [
        '--tunnel-info-port=' + options.tunnelPort, 'tunnel', 'ls'
      ])
      if (!Array.isArray(result) || !result.some(t => t?.udid === options.udid ||
        t?.Udid === options.udid)) {
        throw new Error('Start a go-ios tunnel for the selected UDID')
      }
      return 'Selected iPhone has a tunnel'
    })
  }
  return {passed: checks.every(item => item.passed), checks}
}
