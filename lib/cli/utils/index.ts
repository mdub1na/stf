import type {Argv} from 'yargs'

var command = 'utils [args..]'
var describe = 'User tools for connecting to a Smartphone Test Farm.'

var builder = function(yargs: Argv) {
  return yargs.strict(false).help(false).version(false)
}

var handler = async function() {
  const clientUrl = new URL('../../../tools/adb-tunnel/cli.mts', import.meta.url)
  const {main} = await import(clientUrl.href)
  await main(process.argv.slice(2))
}

export {command, describe, builder, handler}
