import {cleanup, fireEvent, render, screen} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {AuthProviders} from '@/ui/AuthProviders'
import type {Control} from '@/core/control'
import {installationStore} from '@/core/install'
import {InstallCard} from './InstallCard'

vi.mock('@/core/i18n', () => ({useTranslation: () => ({t: (text: string) => text})
  , gettext: (text: string) => text, translate: (text: string) => text}))
beforeEach(() => vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({matches: false
  , addEventListener: vi.fn(), removeEventListener: vi.fn()})))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('installation reset', () => {
  it.each(['iOS', 'Android'])('only protects a running iOS installation from Clear (%s)', platform => {
    const serial = 'clear-' + platform
    installationStore.set(serial, {id: 1, state: 'installing_app', settled: false, success: false
      , progress: 0, manifest: null, error: null})
    const control = {target: {serial, platform}, iosInstallStatus: vi.fn()} as unknown as Control
    render(<AuthProviders><InstallCard control={control} /></AuthProviders>)
    const clear = screen.getByRole('button', {name: 'Clear'}) as HTMLButtonElement
    expect(clear.disabled).toBe(platform === 'iOS')
    const sign = screen.queryByRole('button', {name: 'Sign and install'}) as HTMLButtonElement | null
    expect(sign?.disabled ?? null).toBe(platform === 'iOS' ? true : null)
    fireEvent.click(clear)
    expect(installationStore.get(serial) === null).toBe(platform === 'Android')
  })

  it('opens the existing upload picker for sign and install', () => {
    const serial = 'sign-and-install'
    const control = {target: {serial, platform: 'iOS'}
      , iosInstallStatus: vi.fn().mockResolvedValue({body: null})} as unknown as Control
    const {container} = render(<AuthProviders><InstallCard control={control} /></AuthProviders>)
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const chooseFile = vi.spyOn(input, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', {name: 'Sign and install'}))
    expect(chooseFile).toHaveBeenCalledOnce()
  })
})
