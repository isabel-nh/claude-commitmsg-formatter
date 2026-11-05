import { expect, test } from 'claude-code/testing'
import { checkMessage, DEFAULT_RULES, gitCleanup, leadingGitmoji, wrapLine } from '../hooks/message.ts'

const BODY = '\n\nExplain why the change is needed.'
const ok = (subject: string, rules = DEFAULT_RULES) => checkMessage(subject + BODY, rules)
const pad = (n: number) => 'a'.repeat(n)

test('valid message: no errors, nothing to normalize', () => {
  const v = ok('✨ Add the commit formatter')
  expect(v.errors).toEqual([])
  expect(v.changed).toBe(false)
  expect(v.fixes).toEqual([])
})

test('subject length boundary 50/51, counted in code points', () => {
  expect(ok(`✨ A${pad(47)}`).errors).toEqual([])
  const over = ok(`✨ A${pad(48)}`)
  expect(over.subjectLength).toBe(51)
  expect(over.errors[0]).toContain('Subject is 51 characters (max 50)')
  // ♻️ is U+267B U+FE0F: two characters, as the wrapper counts it.
  expect(ok(`♻️ A${pad(46)}`).errors).toEqual([])
  expect(ok(`♻️ A${pad(47)}`).subjectLength).toBe(51)
  // 🧑‍💻 is three code points joined by ZWJ.
  expect(ok(`🧑‍💻 A${pad(45)}`).errors).toEqual([])
  expect(ok(`🧑‍💻 A${pad(46)}`).errors[0]).toContain('51 characters')
})

test('subjectMax option changes the limit', () => {
  expect(ok(`✨ A${pad(20)}`, { ...DEFAULT_RULES, subjectMax: 20 }).errors[0]).toContain('(max 20)')
})

test('gitmoji: variation selector optional, ZWJ sequence is one glyph', () => {
  expect(leadingGitmoji('♻️ Refactor')?.gitmoji.name).toBe('recycle')
  expect(leadingGitmoji('♻ Refactor')?.gitmoji.name).toBe('recycle')
  expect(leadingGitmoji('🧑‍💻 Improve tooling')?.gitmoji.name).toBe('technologist')
  expect(ok('♻ Refactor the parser').errors).toEqual([])
  expect(ok('🧑‍💻 Improve developer tooling').errors).toEqual([])
  expect(ok('⚡️ Speed up parsing').errors).toEqual([])
})

test('stacked emoji are rejected, with or without a space', () => {
  for (const s of ['✨🐛 Add and fix', '✨ 🐛 Add and fix', '♻️🎨 Tidy', '🧑‍💻🐛 Fix tooling']) {
    expect(ok(s).errors.some(e => e.includes('multiple emojis'))).toBe(true)
  }
})

test('shortcode in place of the glyph is rejected with the glyph to use', () => {
  const v = ok(':sparkles: Add a thing')
  expect(v.errors.join('\n')).toContain('use ✨ in place of :sparkles:')
})

test('subject must open with a gitmoji from the official list', () => {
  expect(ok('Add a thing').errors.join('\n')).toContain('must start with a gitmoji glyph')
  expect(ok('😀 Add a thing').errors.join('\n')).toContain('is not one')
  expect(checkMessage('  ').errors.join('\n')).toContain('Subject is empty')
})

test('requireGitmoji off: no emoji needed, any single emoji allowed, stacking still rejected', () => {
  const rules = { ...DEFAULT_RULES, requireGitmoji: false }
  expect(ok('Add a thing', rules).errors).toEqual([])
  expect(ok('😀 Add a thing', rules).errors).toEqual([])
  expect(ok('😀😀 Add a thing', rules).errors.join('\n')).toContain('multiple emojis')
})

test('colon anywhere in the subject is rejected', () => {
  expect(ok('✨ feat: add a thing').errors.join('\n')).toContain('must not contain a colon')
  expect(ok('✨ Add a thing for x:y').errors.join('\n')).toContain('must not contain a colon')
})

test('normalizes the space after the emoji and capitalizes the first letter', () => {
  expect(ok('✨add a thing').message.split('\n')[0]).toBe('✨ Add a thing')
  expect(ok('✨    add a thing').message.split('\n')[0]).toBe('✨ Add a thing')
  const v = ok('  ✨ add a thing')
  expect(v.message.split('\n')[0]).toBe('✨ Add a thing')
  expect(v.changed).toBe(true)
  expect(v.fixes).toContain('capitalized the first letter of the subject')
})

test('inserts the blank line between subject and body', () => {
  const v = checkMessage('✨ Add a thing\nBody text.')
  expect(v.message).toBe('✨ Add a thing\n\nBody text.')
  expect(v.fixes).toContain('inserted a blank line between the subject and the body')
})

test('a body is required; trailers alone do not count', () => {
  expect(checkMessage('✨ Add a thing').errors).toContain('Provide details about your commit beyond just a subject line.')
  expect(checkMessage('✨ Add a thing\n\nCo-Authored-By: A <a@b.c>').errors).toContain('Provide details about your commit beyond just a subject line.')
})

test('git cleanup differences are not normalizations', () => {
  expect(gitCleanup('\n\nA  \n\n\n\nB\n\n')).toBe('A\n\nB')
  expect(checkMessage('✨ Add a thing  \r\n\r\nBody.\n\n\n').changed).toBe(false)
})

test('body lines over 72 are re-wrapped; short lines are left as written', () => {
  const long = 'This sentence keeps going well past the seventy-two character limit of a body line.'
  const v = checkMessage(`✨ Add a thing\n\nShort line.\n${long}`)
  const body = v.message.split('\n').slice(2)
  expect(body.every(l => [...l].length <= 72)).toBe(true)
  expect(v.fixes).toContain('re-wrapped the body at 72 characters')
  expect(checkMessage('✨ Add a thing\n\nShort one.\nShort two.').changed).toBe(false)
})

test('list items wrap with a hanging indent', () => {
  const v = checkMessage(`✨ Add a thing\n\n- ${'word '.repeat(20).trim()}`)
  const [first, second] = v.message.split('\n').slice(2)
  expect(first!.startsWith('- word')).toBe(true)
  expect(second!.startsWith('  word')).toBe(true)
})

test('a lone URL line may exceed the width and is never hyphenated', () => {
  const url = `https://example.com/${'segment/'.repeat(10)}end`
  expect(checkMessage(`✨ Add a thing\n\nSee the docs.\n${url}`).changed).toBe(false)
  const v = checkMessage(`✨ Add a thing\n\nSee ${url}`)
  expect(v.message.split('\n').slice(2)).toEqual(['See', url])
})

test('a long plain word is hyphenated the way the wrapper does', () => {
  const lines = wrapLine(`x ${'abcdefghij'.repeat(9)}`, 72)
  expect(lines[0]).toBe('x')
  expect(lines[1]!.endsWith('-')).toBe(true)
  expect(lines.every(l => l.length <= 72)).toBe(true)
})

test('trailers are exempt from wrapping and kept in their own paragraph', () => {
  const trailer = `Co-Authored-By: ${'Somebody With A Long Name '.repeat(3)}<x@example.com>`
  const v = checkMessage(`✨ Add a thing\n\nBody.\n\n${trailer}\nSigned-off-by: A <a@b.c>`)
  expect(v.changed).toBe(false)
  const split = checkMessage('✨ Add a thing\n\nBody.\nCo-Authored-By: A <a@b.c>')
  expect(split.message).toBe('✨ Add a thing\n\nBody.\n\nCo-Authored-By: A <a@b.c>')
  expect(split.fixes).toContain('moved the trailers into a paragraph of their own')
})

test('paragraph followed by a list gets a separating blank line', () => {
  const v = checkMessage('✨ Add a thing\n\nChanges\n- one\n- two')
  expect(v.message).toBe('✨ Add a thing\n\nChanges\n\n- one\n- two')
})

test('disallowed patterns match subject or body', () => {
  const rules = { ...DEFAULT_RULES, disallowed: [/\bABC-\d+\b/] }
  expect(checkMessage('✨ Add ABC-123 support\n\nBody.', rules).errors.join('\n')).toContain('disallowed pattern /\\bABC-\\d+\\b/ ("ABC-123")')
  expect(checkMessage('✨ Add a thing\n\nFor ABC-9.', rules).errors.length).toBe(1)
  expect(checkMessage('✨ Add a thing\n\nBody.', rules).errors).toEqual([])
})
