import {stripTypeScriptTypes} from 'node:module'
import {chmod, readFile, writeFile} from 'node:fs/promises'

const files = ['stf', 'cli', 'coordinator', 'transports', 'run', 'types']
for (const name of files) {
  const path = new URL(`./${name}.mts`, import.meta.url)
  const source = await readFile(path, 'utf8')
  const javascript = stripTypeScriptTypes(source, {mode: 'strip', sourceUrl: path.href})
    .replace(/(['"]\.\/[^'"\n]+)\.mts(['"])/g, '$1.mjs$2')
    .replace(/\n\/\/# sourceURL=.*(?:\n|$)/, '\n')
  const output = new URL(`./${name}.mjs`, import.meta.url)
  await writeFile(output, javascript, {mode: name === 'stf' ? 0o755 : 0o644})
  if (name === 'stf') await chmod(output, 0o755)
}
