import assert from 'node:assert/strict'
import path from 'node:path'
import {it} from 'node:test'
import {runCommand} from '../process.mts'

it('signs only authorized unsigned IPA uploads and returns a verified archive', async() => {
  const output = await runCommand('python3', [
    '-B', path.join(import.meta.dirname, 'ipa_signer_test.py')
  ], 10000)
  assert.match(output, /IPA signer HTTP fixtures passed/)
})
