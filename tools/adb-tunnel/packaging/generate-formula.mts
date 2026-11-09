import {readFile, mkdir, writeFile} from 'node:fs/promises'
import {basename, dirname, join, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {sha256, unpackRelease} from './archive.mts'
import type {ReleaseManifest} from './build-release.mts'

export async function generateFormula(options: {artifact: string, out: string, url?: string, homepage?: string}): Promise<string> {
  const artifact = resolve(options.artifact)
  const match = /^stf-utils-([0-9]+\.[0-9]+\.[0-9]+)\.tar\.gz$/.exec(basename(artifact))
  if (!match) throw new Error('Provide a versioned STF utilities release artifact')
  const version = match[1]!
  const bytes = await readFile(artifact)
  const manifest: ReleaseManifest = JSON.parse(await readFile(join(dirname(artifact), `stf-utils-${version}.manifest.json`), 'utf8'))
  if (manifest.version !== version || manifest.artifact !== basename(artifact) || sha256(bytes) !== manifest.sha256) {
    throw new Error('Release artifact and manifest do not match')
  }
  const files = unpackRelease(bytes, `stf-utils-${version}`)
  const pkg = JSON.parse(files.find(file => file.path === 'package.json')!.data.toString('utf8'))
  if (pkg.name !== '@finservice/stf-utils' || pkg.version !== version || pkg.bin?.stf !== 'stf.mts') {
    throw new Error('Release archive is not the STF utilities client')
  }
  const url = new URL(options.url ?? pathToFileURL(artifact).href)
  const homepage = new URL(options.homepage ?? 'https://github.com/mdub1na/stf')
  if (!['https:', 'file:'].includes(url.protocol) || url.username || url.password || url.hash || url.search ||
      homepage.protocol !== 'https:' || homepage.username || homepage.password || homepage.search || homepage.hash) {
    throw new Error('Formula needs a credential-free HTTPS URL or a local file URL')
  }
  if (url.protocol === 'file:' && fileURLToPath(url) !== artifact) throw new Error('Local formula URL must name the verified artifact')
  const template = await readFile(new URL('./stf-utils.rb.in', import.meta.url), 'utf8')
  const replacements: Record<string, string> = {
    HOMEPAGE: homepage.href, DOWNLOAD_URL: url.href, VERSION: version, SHA256: manifest.sha256
  }
  const formula = template.replace(/__(HOMEPAGE|DOWNLOAD_URL|VERSION|SHA256)__/g, (_all, key: string) =>
    JSON.stringify(replacements[key]).replace(/#\{/g, '\\#{'))
  await mkdir(dirname(options.out), {recursive: true})
  await writeFile(options.out, formula, {flag: 'wx'})
  return formula
}

async function main() {
  const {values} = parseArgs({options: {
    artifact: {type: 'string'}, out: {type: 'string'}, url: {type: 'string'}, homepage: {type: 'string'}
  }})
  if (!values.artifact || !values.out) throw new Error('Provide --artifact and --out Formula/stf-utils.rb')
  await generateFormula({artifact: values.artifact, out: values.out,
    ...(values.url ? {url: values.url} : {}), ...(values.homepage ? {homepage: values.homepage} : {})})
  process.stdout.write('Formula generated from verified release bytes.\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {process.stderr.write(`${error instanceof Error ? error.message : 'Formula generation failed'}\n`); process.exitCode = 1})
}
