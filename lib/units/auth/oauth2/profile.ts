import type {UserIdentity} from '../../../types/stf.js'

interface ProfileOptions {
  domain?: string
  requireVerifiedEmail?: boolean
}

export default function(
  profile: unknown
, options: ProfileOptions
): Pick<UserIdentity, 'email' | 'name'> | null {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return null
  }
  var claims = profile as Record<string, unknown>
  if (typeof claims.email !== 'string' ||
      (options.requireVerifiedEmail !== false && claims.email_verified !== true)) {
    return null
  }

  var email = claims.email.trim()
  var parts = email.split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1] || /\s/.test(email)) {
    return null
  }
  if (options.domain && parts[1].toLowerCase() !==
      options.domain.trim().replace(/^@/, '').toLowerCase()) {
    return null
  }

  return {
    email: email
  , name: typeof claims.name === 'string' && claims.name.trim() ?
      claims.name.trim() : parts[0]
  }
}
