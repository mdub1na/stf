import {mkdir, readdir, readFile, writeFile, copyFile} from 'node:fs/promises'
import path from 'node:path'
import {stripTypeScriptTypes} from 'node:module'

// Runtime overlays reuse the pinned foundation's dependencies and unchanged frontend.
// The full repository compiler/type checks remain required before deployment.
const source = path.resolve('lib')
const destination = path.resolve(process.argv[2] || '.runtime-overlay/lib')
await mkdir(destination, {recursive: true})
async function compile(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await compile(filename)
      continue
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue
    const target = path.join(destination, path.relative(source, filename)).replace(/\.ts$/, '.js')
    await mkdir(path.dirname(target), {recursive: true})
    const code = stripTypeScriptTypes(await readFile(filename, 'utf8'), {mode: 'transform'})
    await writeFile(target, code)
  }
}
await compile(source)
await copyFile(path.join(source, 'package.json'), path.join(destination, 'package.json'))
await mkdir(path.join(destination, 'wire'), {recursive: true})
await copyFile(path.join(source, 'wire/wire.proto'), path.join(destination, 'wire/wire.proto'))
