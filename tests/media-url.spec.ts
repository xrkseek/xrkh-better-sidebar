/**
 * mediaUrl revision / cache-bust contract: open-file hot refresh remounts
 * image/PDF viewers with `&v=mtime` so the browser cannot keep stale bytes.
 */
import { describe, expect, it } from 'vitest'
import { mediaUrl } from '../src/client/api.ts'

const scope = { sessionId: 's1', cwd: '/w' }

describe('mediaUrl', () => {
  it('omits the revision query when no stamp is provided', () => {
    const url = mediaUrl(scope, '/w/a.png')
    expect(url).toContain('/sidebar/file')
    expect(url).toContain('path=')
    expect(url).not.toMatch(/[?&]v=/)
  })

  it('appends a rounded &v= stamp for cache-busting remounts', () => {
    const url = mediaUrl(scope, '/w/a.png', 1_700_000_000_123.7)
    expect(url).toMatch(/[?&]v=1700000000124(?:&|$)/)
  })

  it('ignores non-finite revisions', () => {
    expect(mediaUrl(scope, '/w/a.png', Number.NaN)).not.toMatch(/[?&]v=/)
    expect(mediaUrl(scope, '/w/a.png', Number.POSITIVE_INFINITY)).not.toMatch(/[?&]v=/)
  })
})
