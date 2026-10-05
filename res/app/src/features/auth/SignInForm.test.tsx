import {renderToStaticMarkup} from 'react-dom/server'
import {describe, expect, it, vi} from 'vitest'
import {AuthProviders} from '@/ui/AuthProviders'
import {SignInForm} from './SignInForm'

vi.mock('@/core/contact', () => ({useContactEmail: () => null}))
vi.mock('@/core/i18n', () => ({useTranslation: () => ({t: (text: string) => text})}))

describe('OAuth sign-in page', () => {
  it('shows an explicit GitLab sign-in link without collecting credentials', () => {
    const html = renderToStaticMarkup(<AuthProviders><SignInForm mode='oauth' /></AuthProviders>)
    const page = new DOMParser().parseFromString(html, 'text/html')
    const link = page.querySelector('a[href="/auth/oauth/start"]')
    expect(link?.textContent).toContain('Sign in with GitLab')
    expect(page.querySelector('input')).toBeNull()
    expect(page.querySelector('form')).toBeNull()
    expect(page.querySelector('img')?.getAttribute('src')).toBe('/static/logo/exports/STF-512.png')
  })
})
