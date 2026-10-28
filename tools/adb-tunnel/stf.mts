#!/usr/bin/env node
import {main, reportError} from './cli.mts'

if (import.meta.main) {
  main(process.argv.slice(2)).catch(reportError)
}
