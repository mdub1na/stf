import assert from 'node:assert/strict'
import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {FileStateStore} from '../../lib/units/coordinator/state.js'
import type {CoordinatorState} from '../../lib/units/coordinator/types.js'

const empty = (): CoordinatorState => ({version: 1, requests: [], leases: []})

describe('coordinator persistent state', () => {
  let directory: string, filename: string

  beforeEach(async() => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'coordinator-state-test-'))
    filename = path.join(directory, 'private', 'coordinator.json')
  })

  afterEach(async() => {
    await rm(directory, {recursive: true, force: true})
  })

  it('starts with an empty state only when the file does not exist', async() => {
    assert.deepEqual(await new FileStateStore(filename).load(), empty())
  })

  it('persists exact state with private permissions and no leftover temporary files', async() => {
    const store = new FileStateStore(filename)
    await store.save(empty())
    assert.deepEqual(await new FileStateStore(filename).load(), empty())
    assert.equal((await stat(filename)).mode & 0o777, 0o600)
    assert.equal((await stat(path.dirname(filename))).mode & 0o777, 0o700)
    assert.deepEqual(await readdir(path.dirname(filename)), ['coordinator.json'])
  })

  it('retains the previous durable file if replacement serialization fails', async() => {
    const store = new FileStateStore(filename)
    await store.save(empty())
    const previous = await readFile(filename, 'utf8')
    const circular = empty() as CoordinatorState & {circular?: unknown}
    circular.circular = circular
    await assert.rejects(store.save(circular), /circular/i)
    assert.equal(await readFile(filename, 'utf8'), previous)
    assert.deepEqual(await readdir(path.dirname(filename)), ['coordinator.json'])
  })

  it('refuses malformed JSON instead of silently discarding recovery state', async() => {
    await new FileStateStore(filename).save(empty())
    await writeFile(filename, '{"version":1,"leases":[', {mode: 0o600})
    await assert.rejects(new FileStateStore(filename).load())
  })

  it('rejects unsupported versions and incomplete request or lease records', async() => {
    const invalid = [
      {...empty(), version: 2}
    , {...empty(), requests: [{id: 'request-one', input: {}, state: 'queued'}]}
    , {...empty(), leases: [{id: 'lease-one', device: {serial: 'ANDROID-A'}, state: 'active'}]}
    , {...empty(), requests: [{id: 'request-one', input: {runId: 'run'}, state: 'unknown'}]}
    ]
    await new FileStateStore(filename).save(empty())
    for (const value of invalid) {
      await writeFile(filename, JSON.stringify(value), {mode: 0o600})
      await assert.rejects(new FileStateStore(filename).load(),
        'Incomplete persistent state cannot justify safe device reissue')
    }
  })
})
