import {execFileSync} from 'node:child_process'
import {chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {archiveFiles, sha256} from './archive.mts'
import type {ArchiveFile} from './archive.mts'

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtime = ['stf.mts', 'cli.mts', 'client.mts', 'types.mts', 'package.json', 'package-lock.json', 'LICENSE', 'README.md']
export interface ReleaseManifest {
  name: string
  version: string
  artifact: string
  sha256: string
  node: string
  dependencies: {ws: string}
  files: Array<{path: string, sha256: string}>
}

export async function buildRelease(options: {out: string, source?: string, offline?: boolean, npmCache?: string}): Promise<ReleaseManifest> {
  const source = resolve(options.source ?? packageDirectory)
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(source, 'package-lock.json'), 'utf8'))
  if (pkg.name !== '@finservice/stf-utils' || pkg.private !== true ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(pkg.version) ||
      pkg.bin?.stf !== 'stf.mts' || pkg.engines?.node !== '>=22.18.0' ||
      JSON.stringify(pkg.dependencies) !== JSON.stringify({ws: '8.22.0'}) ||
      lock.name !== pkg.name || lock.version !== pkg.version || lock.packages?.['node_modules/ws']?.version !== '8.22.0') {
    throw new Error('Client package or lockfile does not match the release contract')
  }
  const stage = await mkdtemp(join(tmpdir(), 'stf-utils-build-'))
  try {
    for (const file of runtime) {
      if (!(await lstat(join(source, file))).isFile()) throw new Error('Release sources must be regular files')
      await copyFile(join(source, file), join(stage, file))
    }
    const npmArgs = ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund',
      ...(options.offline ? ['--offline'] : []), ...(options.npmCache ? ['--cache', resolve(options.npmCache)] : [])]
    execFileSync('npm', npmArgs, {cwd: stage, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000})
    const dependencies = (await readdir(join(stage, 'node_modules'))).filter(name => name !== '.package-lock.json')
    if (dependencies.length !== 1 || dependencies[0] !== 'ws') throw new Error('Unexpected packaged runtime dependency')
    const ws = JSON.parse(await readFile(join(stage, 'node_modules/ws/package.json'), 'utf8'))
    if (ws.version !== '8.22.0') throw new Error('Incorrect WebSocket dependency')
    const files: ArchiveFile[] = []
    for (const path of runtime) files.push({path, data: await readFile(join(stage, path)), executable: path === 'stf.mts'})
    const collect = async(directory: string) => {
      for (const name of (await readdir(join(stage, directory))).sort()) {
        const path = `${directory}/${name}`
        const stat = await lstat(join(stage, path))
        if (stat.isDirectory()) await collect(path)
        else if (stat.isFile() && !path.endsWith('.node')) files.push({path, data: await readFile(join(stage, path))})
        else throw new Error('Runtime dependencies must contain only portable regular files')
      }
    }
    await collect('node_modules/ws')
    const artifact = `stf-utils-${pkg.version}.tar.gz`
    const archive = archiveFiles(`stf-utils-${pkg.version}`, files)
    const manifest: ReleaseManifest = {
      name: pkg.name, version: pkg.version, artifact, sha256: sha256(archive), node: pkg.engines.node,
      dependencies: {ws: ws.version},
      files: files.map(file => ({path: file.path, sha256: sha256(file.data)})).sort((a, b) => a.path < b.path ? -1 : 1)
    }
    await mkdir(options.out, {recursive: true})
    await writeFile(join(options.out, artifact), archive, {flag: 'wx'})
    await writeFile(join(options.out, artifact + '.sha256'), `${manifest.sha256}  ${artifact}\n`, {flag: 'wx'})
    await writeFile(join(options.out, `stf-utils-${pkg.version}.manifest.json`), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'})
    return manifest
  }
  finally {
    await rm(stage, {recursive: true, force: true})
  }
}

async function main() {
  const {values} = parseArgs({options: {out: {type: 'string'}, offline: {type: 'boolean'}, 'npm-cache': {type: 'string'}}})
  if (!values.out) throw new Error('Provide --out with a new release output directory')
  const manifest = await buildRelease({out: resolve(values.out),
    ...(values.offline ? {offline: true} : {}), ...(values['npm-cache'] ? {npmCache: values['npm-cache']} : {})})
  process.stdout.write(JSON.stringify({artifact: manifest.artifact, sha256: manifest.sha256, version: manifest.version}) + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('STF utilities release build failed; verify the pinned client sources and npm dependency availability.\n'); process.exitCode = 1 })
}
