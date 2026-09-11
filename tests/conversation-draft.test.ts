import { describe, expect, it } from 'vitest'
import { formatPathMention } from '../src/client/conversation-draft.ts'

describe('formatPathMention', () => {
  it('directories always end with a trailing slash', () => {
    expect(formatPathMention('知识库/英语一', 'directory')).toBe('@知识库/英语一/')
    expect(formatPathMention('知识库/英语一/', 'directory')).toBe('@知识库/英语一/')
    expect(formatPathMention('.', 'directory')).toBe('@/')
  })

  it('files keep the leaf name and quote whitespace', () => {
    expect(formatPathMention('README.md', 'file')).toBe('@README.md')
    expect(formatPathMention('docs/a note.md', 'file')).toBe('@"docs/a note.md"')
    expect(formatPathMention('my folder', 'directory')).toBe('@"my folder/"')
  })
})
