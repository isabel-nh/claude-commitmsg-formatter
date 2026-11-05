import { GITMOJIS, type Gitmoji } from './gitmojis.ts'

export type Rules = {
  subjectMax: number
  bodyWrap: number
  requireGitmoji: boolean
  disallowed: readonly RegExp[]
}

export const DEFAULT_RULES: Rules = { subjectMax: 50, bodyWrap: 72, requireGitmoji: true, disallowed: [] }

export type Verdict = {
  errors: string[]
  // What normalization changed; empty when `message` is the input as git would store it.
  fixes: string[]
  message: string
  changed: boolean
  subject: string
  subjectLength: number
}

const VS = '️'
const ZWJ = '‍'
const isSkinTone = (c: string | undefined) => c !== undefined && /[\u{1F3FB}-\u{1F3FF}]/u.test(c)
const isAscii = (c: string | undefined) => c !== undefined && c.codePointAt(0)! < 128
// Characters as the wrapper counts them: code points (`♻️` is two, `🧑‍💻` three).
export const length = (s: string): number => [...s].length

// A git trailer token: hyphenated (`Co-Authored-By`, `Signed-off-by`) or a common one-word key.
const TRAILER = /^(?:[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+|Fixes|Closes|Resolves|Refs|Bug):\s*\S/
// Words never hyphenated: URLs, paths, e-mail addresses, dotted names.
const UNBREAKABLE = /:\/\/|[/\\@]|\w\.\w/

// git's `whitespace` cleanup, the mode a -m or -F message gets: trailing whitespace
// dropped, blank-line runs collapsed, leading and trailing blank lines removed.
export function gitCleanup(text: string): string {
  const out: string[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/[ \t\r\f\v]+$/, '')
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue
    out.push(line)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

const stripVs = (s: string) => s.replaceAll(VS, '')
const BY_LENGTH = [...GITMOJIS].sort((a, b) => length(stripVs(b.emoji)) - length(stripVs(a.emoji)))

// The catalog gitmoji the subject opens with (variation selectors optional) and the
// code-point index just past it.
export function leadingGitmoji(subject: string): { gitmoji: Gitmoji; end: number } | undefined {
  const s = [...subject]
  for (const g of BY_LENGTH) {
    const want = [...stripVs(g.emoji)]
    let i = 0
    let k = 0
    while (k < want.length && i < s.length) {
      if (s[i] === VS) {
        i++
        continue
      }
      if (s[i] !== want[k]) break
      i++
      k++
    }
    if (k < want.length) continue
    if (s[i] === VS) i++
    return { gitmoji: g, end: i }
  }
  return undefined
}

export const gitmojiByCode = (code: string): Gitmoji | undefined => GITMOJIS.find(g => g.code === code)

// True when another emoji follows the first one: past its variation selector, skin
// tone and ZWJ-joined continuations, and one space, the next character is not ASCII.
function isStacked(subject: string, end: number): boolean {
  const s = [...subject]
  let i = end
  const glyphTail = () => {
    while (s[i] === VS || isSkinTone(s[i])) i++
  }
  glyphTail()
  while (s[i] === ZWJ) {
    i++
    if (s[i] !== undefined && !isAscii(s[i])) i++
    glyphTail()
  }
  if (s[i] === ' ') i++
  return s[i] !== undefined && !isAscii(s[i])
}

const VOWELS = 'aeiouAEIOU'

function hyphenBreak(word: string[], max: number): number {
  const lookback = Math.max(0, max - 10)
  for (let i = max; i > lookback; i--) {
    const before = VOWELS.includes(word[i - 1]!)
    const at = VOWELS.includes(word[i] ?? '')
    if (before !== at) return i
  }
  return max
}

export function wrapLine(text: string, width: number): string[] {
  const out: string[] = []
  let current = ''
  for (const word of text.split(' ').filter(w => w !== '')) {
    let chars = [...word]
    if (chars.length > width) {
      if (current !== '') out.push(current)
      current = ''
      if (UNBREAKABLE.test(word)) {
        out.push(word)
        continue
      }
      while (chars.length > width - 1) {
        const at = hyphenBreak(chars, width - 1)
        out.push(`${chars.slice(0, at).join('')}-`)
        chars = chars.slice(at)
      }
      current = chars.join('')
    } else if (current === '') current = word
    else if (length(current) + 1 + chars.length <= width) current = `${current} ${word}`
    else {
      out.push(current)
      current = word
    }
  }
  if (current !== '') out.push(current)
  return out.length > 0 ? out : ['']
}

function wrapListItem(text: string, width: number, prefix: string): string[] {
  const indent = ' '.repeat(length(prefix))
  return wrapLine(text, width - length(prefix)).map((l, i) => (i === 0 ? prefix : indent) + l)
}

type Text = { kind: 'para' | 'pre' | 'trailer'; lines: string[] }
type Item = { kind: 'bullet' | 'number'; prefix: string; text: string; lines: string[] }
type Block = { kind: 'blank' } | Text | Item

function blocks(body: readonly string[]): Block[] {
  const out: Block[] = []
  let open: Text | Item | undefined
  const close = () => {
    if (open !== undefined) out.push(open)
    open = undefined
  }
  for (const line of body) {
    const item = /^(\s*[-*]\s+)/.exec(line) ?? /^(\s*\d+\.\s+)/.exec(line)
    if (line === '') {
      close()
      out.push({ kind: 'blank' })
    } else if (item !== null) {
      close()
      open = { kind: /\d/.test(item[1]!) ? 'number' : 'bullet', prefix: item[1]!, text: line.slice(item[1]!.length), lines: [line] }
    } else if ((open?.kind === 'bullet' || open?.kind === 'number') && /^\s/.test(line)) {
      open.text += ` ${line.replace(/^ +/, '')}`
      open.lines.push(line)
    } else if (/^(\t| {4})/.test(line) && (open === undefined || open.kind === 'pre')) {
      const pre: Text = open ?? { kind: 'pre', lines: [] }
      pre.lines.push(line)
      open = pre
    } else {
      if (open?.kind !== 'para') close()
      const para: Text = open?.kind === 'para' ? open : { kind: 'para', lines: [] }
      para.lines.push(line)
      open = para
    }
  }
  close()
  return out
}

// The last paragraph's trailer lines become a trailer block of their own.
function splitTrailers(list: Block[]): boolean {
  const last = list[list.length - 1]
  if (last?.kind !== 'para') return false
  let k = last.lines.length
  while (k > 0 && TRAILER.test(last.lines[k - 1]!)) k--
  if (k === last.lines.length) return false
  const trailer: Block = { kind: 'trailer', lines: last.lines.slice(k) }
  if (k === 0) {
    list[list.length - 1] = trailer
    return false
  }
  list.splice(list.length - 1, 1, { kind: 'para', lines: last.lines.slice(0, k) }, { kind: 'blank' }, trailer)
  return true
}

// A line holding one unbreakable word (a URL, a path), list marker aside, may run past the width.
const isExempt = (line: string) => {
  const t = line.trim().replace(/^([-*]|\d+\.)\s+/, '')
  return !/\s/.test(t) && UNBREAKABLE.test(t)
}
const overlong = (lines: readonly string[], width: number) => lines.some(l => length(l) > width && !isExempt(l))

export function checkMessage(input: string, rules: Rules = DEFAULT_RULES): Verdict {
  const errors: string[] = []
  const fixes: string[] = []
  const clean = gitCleanup(input)
  const lines = clean.split('\n')
  const original = lines[0] ?? ''
  let subject = original.replace(/^\s+/, '')
  if (subject !== original) fixes.push('removed leading whitespace from the subject')

  // A single space between the leading emoji run and the text.
  const chars = [...subject]
  let run = 0
  while (run < chars.length && !isAscii(chars[run])) run++
  if (run > 0 && run < chars.length) {
    const rest = chars.slice(run).join('').replace(/^\s+/, '')
    const spaced = rest === '' ? chars.slice(0, run).join('') : `${chars.slice(0, run).join('')} ${rest}`
    if (spaced !== subject) fixes.push('set a single space after the emoji')
    subject = spaced
  }

  const firstText = /[\x21-\x7e]/.exec(subject)
  if (firstText !== null && /[a-z]/.test(firstText[0])) {
    subject = subject.slice(0, firstText.index) + firstText[0].toUpperCase() + subject.slice(firstText.index + 1)
    fixes.push('capitalized the first letter of the subject')
  }

  const subjectLength = length(subject)
  if (subjectLength > rules.subjectMax) errors.push(`Subject is ${subjectLength} characters (max ${rules.subjectMax}). Shorten it: "${subject}"`)
  if (subject.includes(':')) errors.push(`Subject must not contain a colon. Remove it: "${subject}"`)

  const shortcode = /^:([a-z0-9_+-]+):/.exec(subject)
  if (subject === '') errors.push(rules.requireGitmoji ? 'Subject is empty; it must start with a gitmoji.' : 'Subject is empty.')
  else if (!isAscii([...subject][0])) {
    const match = leadingGitmoji(subject)
    if (match === undefined && rules.requireGitmoji) {
      errors.push(`Subject must start with a gitmoji from https://gitmoji.dev; "${[...subject][0]}" is not one. Subject: "${subject}"`)
    }
    if (isStacked(subject, match?.end ?? 1)) errors.push(`Subject contains multiple emojis; use exactly one gitmoji. Subject: "${subject}"`)
  } else if (rules.requireGitmoji) {
    const g = shortcode === null ? undefined : gitmojiByCode(shortcode[0])
    errors.push(
      g === undefined
        ? `Subject must start with a gitmoji glyph: "${subject}"`
        : `Subject must start with the gitmoji glyph, not its shortcode: use ${g.emoji} in place of ${g.code}.`,
    )
  }

  const body = lines.slice(1)
  if (body.length > 0 && body[0] !== '') fixes.push('inserted a blank line between the subject and the body')
  const list = blocks(body)
  if (splitTrailers(list)) fixes.push('moved the trailers into a paragraph of their own')

  const width = rules.bodyWrap
  const out: string[] = []
  let last: 'para' | 'bullet' | 'number' | undefined
  let wrapped = false
  let separated = false
  for (const b of list) {
    if (b.kind === 'blank') {
      out.push('')
      continue
    }
    const kind = b.kind === 'bullet' || b.kind === 'number' ? b.kind : 'para'
    const needsSep = last !== undefined && (last === 'para' || kind === 'para' || last !== kind)
    if (needsSep && out.length > 0 && out[out.length - 1] !== '') {
      out.push('')
      separated = true
    }
    let rendered = b.lines
    if ((b.kind === 'para' || b.kind === 'bullet' || b.kind === 'number') && overlong(b.lines, width)) {
      rendered = 'prefix' in b ? wrapListItem(b.text, width, b.prefix) : wrapLine(b.lines.join(' ').trim(), width)
      if (rendered.join('\n') !== b.lines.join('\n')) wrapped = true
    }
    out.push(...rendered)
    last = kind
  }
  if (separated) fixes.push('separated paragraphs and lists with blank lines')
  if (wrapped) fixes.push(`re-wrapped the body at ${width} characters`)

  if (!list.some(b => b.kind !== 'blank' && b.kind !== 'trailer')) errors.push('Provide details about your commit beyond just a subject line.')

  const message = gitCleanup([subject, '', ...out].join('\n'))
  for (const pattern of rules.disallowed) {
    const hit = pattern.exec(message)
    if (hit !== null) errors.push(`Message matches the disallowed pattern /${pattern.source}/ ("${hit[0]}"). Remove it.`)
  }
  const changed = message !== clean
  if (changed && fixes.length === 0) fixes.push('normalized whitespace')
  return { errors, fixes: changed ? fixes : [], message, changed, subject, subjectLength }
}
