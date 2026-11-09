import {chmod, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {basename, dirname, join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {sha256, unpackRelease} from './archive.mts'
import type {ReleaseManifest} from './build-release.mts'

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"

/** Local smoke installation only: requires a new prefix and never registers a tap. */
export async function stageRelease(options: {artifact: string, prefix: string, node?: string}): Promise<string> {
  const artifact = resolve(options.artifact)
  const version = /^stf-utils-([0-9]+\.[0-9]+\.[0-9]+)\.tar\.gz$/.exec(basename(artifact))?.[1]
  if (!version) throw new Error('Provide a versioned STF utilities archive')
  const manifest: ReleaseManifest = JSON.parse(await readFile(join(dirname(artifact), `stf-utils-${version}.manifest.json`), 'utf8'))
  const bytes = await readFile(artifact)
  if (manifest.version !== version || manifest.artifact !== basename(artifact) || sha256(bytes) !== manifest.sha256) {
    throw new Error('Release artifact and manifest do not match')
  }
  const files = unpackRelease(bytes, `stf-utils-${version}`)
  if (files.length !== manifest.files.length || files.some(file =>
    !manifest.files.some(expected => expected.path === file.path && expected.sha256 === sha256(file.data)))) {
    throw new Error('Release files do not match the manifest')
  }
  const prefix = resolve(options.prefix)
  await mkdir(prefix, {mode: 0o700}) // EEXIST is intentional: never overwrite an existing command or prefix.
  try {
    for (const file of files) {
      const target = join(prefix, 'libexec', file.path)
      await mkdir(dirname(target), {recursive: true})
      await writeFile(target, file.data, {flag: 'wx', mode: file.executable ? 0o755 : 0o644})
    }
    await mkdir(join(prefix, 'bin'))
    const executable = join(prefix, 'bin/stf')
    await writeFile(executable, `#!/bin/sh\nexec ${quote(options.node ?? process.execPath)} ${quote(join(prefix, 'libexec/stf.mts'))} "$@"\n`, {flag: 'wx', mode: 0o755})
    await chmod(executable, 0o755)
    return executable
  }
  catch (error) {
    await rm(prefix, {recursive: true, force: true})
    throw error
  }
}

async function main() {
  const {values} = parseArgs({options: {artifact: {type: 'string'}, prefix: {type: 'string'}, node: {type: 'string'}}})
  if (!values.artifact || !values.prefix) throw new Error('Provide --artifact and --prefix with a new temporary directory')
  const executable = await stageRelease({artifact: values.artifact, prefix: values.prefix,
    ...(values.node ? {node: values.node} : {})})
  process.stdout.write(executable + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {process.stderr.write(`${error instanceof Error ? error.message : 'Staging failed'}\n`); process.exitCode = 1})
}
