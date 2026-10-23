import assert from 'node:assert/strict'
import yargs from 'yargs'
import {builder, command, describe as description} from '../../lib/cli/coordinator/index.js'

const required = [
  '--stf-api-url', 'http://stf.example.test/api/v1'
, '--appium-grid-url', 'http://grid.example.test'
, '--stf-token-file', '/secrets/stf-token'
, '--api-token-file', '/secrets/api-token'
, '--state-file', '/state/coordinator.json'
, '--adb-pools-file', '/config/adb-pools.json'
]

const parse = (args: string[]) => builder(yargs(args).exitProcess(false))
  .fail((message, error) => {
    throw error || new Error(message)
  })
  .parseSync()

describe('coordinator CLI', () => {
  it('provides an independently runnable service with file-based credentials', () => {
    assert.equal(command, 'coordinator')
    assert.match(description, /Appium/)
    const argv = parse(required)
    assert.equal(argv.host, '127.0.0.1')
    assert.equal(argv.port, 8080)
    assert.equal(argv.publicUrl, 'http://127.0.0.1:8080')
    assert.equal(argv.leaseTtlSeconds, 180)
    assert.equal(argv.heartbeatIntervalSeconds, 30)
    assert.equal(argv.pollIntervalSeconds, 1)
    assert.equal(argv.maxDurationSeconds, 21600)
    assert.equal(argv.maxParallel, 10)
    assert.equal(argv.upstreamTimeoutSeconds, 30)
    assert.equal(argv.stfTokenFile, '/secrets/stf-token')
    assert.equal(argv.apiTokenFile, '/secrets/api-token')
  })

  it('reads namespaced environment settings and lets explicit flags override them', () => {
    const key = 'STF_COORDINATOR_MAX_PARALLEL'
    const previous = process.env[key]
    process.env[key] = '3'
    try {
      assert.equal(parse(required).maxParallel, 3)
      assert.equal(parse([...required, '--max-parallel', '2']).maxParallel, 2)
    }
    finally {
      if (typeof previous === 'undefined') {
        delete process.env[key]
      }
      else {
        process.env[key] = previous
      }
    }
  })

  it('rejects missing durable configuration and accidental plaintext token flags', () => {
    const withoutState = required.filter(value =>
      !['--state-file', '/state/coordinator.json'].includes(value))
    assert.throws(() => parse(withoutState), /state-file/)
    for (const flag of ['--api-token', '--stf-token']) {
      assert.throws(() => parse([...required, flag, 'not-supported']), /Unknown argument/)
    }
  })

  it('rejects settings that cannot sustain a renewable lease', () => {
    for (const [option, value] of [
      ['--port', '65536'], ['--max-parallel', '0'], ['--poll-interval-seconds', '1.5']
    , ['--lease-ttl-seconds', '30'], ['--heartbeat-interval-seconds', '180']
    ]) {
      assert.throws(() => parse([...required, option!, value!]))
    }
  })

  it('documents the service flags without starting an upstream connection', () => {
    const output = builder(yargs([]).exitProcess(false)).help().getHelp()
    return Promise.resolve(output).then(help => {
      assert.match(help, /--state-file/)
      assert.match(help, /--api-token-file/)
      assert.match(help, /STF_COORDINATOR_/)
      assert.match(help, /exactly one coordinator/)
    })
  })
})
