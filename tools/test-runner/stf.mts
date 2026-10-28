#!/usr/bin/env node
import {main} from './cli.mts'

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'STF test run failed'}\n`)
    process.exitCode = 1
  })
}
