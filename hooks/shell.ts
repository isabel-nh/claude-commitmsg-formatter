// A small bash lexer: enough of the grammar to find simple commands, their words
// (with each quoted or expanded part and its source range), and heredoc bodies.

export type Range = { start: number; end: number }
export type Quote = 'none' | 'single' | 'double' | 'ansi'
export type Part =
  | (Range & { kind: 'literal'; quote: Quote; text: string })
  | (Range & { kind: 'expansion'; quote: 'none' | 'double'; script?: Script })
export type Word = Range & { parts: Part[] }
export type Heredoc = { delimiter: string; quoted: boolean; stripTabs: boolean; opener: Range; body: Range; text: string }
export type Command = Range & { words: Word[]; heredocs: Heredoc[]; hasHerestring: boolean; hasStdinRedirect: boolean; inPipeline: boolean }
export type Script = { commands: Command[]; end: number }

const OPERATOR = /[;&|()\n]/
const BLANK = /[ \t\r]/
const NAME = /[A-Za-z_]/
const REDIRECT = /^(\d*|&)(<<<|<<-|<<|<&|>&|>>|>\||<>|<|>)/

export function wordValue(w: Word): string | undefined {
  let s = ''
  for (const p of w.parts) {
    if (p.kind !== 'literal') return undefined
    s += p.text
  }
  return s
}

function ansiDecode(s: string): string {
  const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }
  return s.replace(/\\(x[0-9A-Fa-f]{1,2}|[0-7]{1,3}|.)/g, (m, c: string) => {
    if (c[0] === 'x') return String.fromCharCode(parseInt(c.slice(1), 16))
    if (/^[0-7]/.test(c)) return String.fromCharCode(parseInt(c, 8))
    return map[c] ?? m
  })
}

class Lexer {
  pending: { h: Heredoc; command: Command }[] = []
  constructor(readonly src: string) {}

  // Parses commands from `i`; nested (inside `$(`) stops after the closing paren.
  script(i: number, nested: boolean): Script {
    const commands: Command[] = []
    let depth = 0
    let current: Command | undefined
    let pipeNext = false
    const close = (end: number) => {
      if (current !== undefined) {
        current.end = end
        commands.push(current)
      }
      current = undefined
    }
    const src = this.src
    while (i < src.length) {
      const c = src[i]!
      if (BLANK.test(c)) {
        i++
        continue
      }
      if (c === '\\' && src[i + 1] === '\n') {
        i += 2
        continue
      }
      if (c === '#') {
        while (i < src.length && src[i] !== '\n') i++
        continue
      }
      if (c === '\n') {
        close(i)
        pipeNext = false
        i = this.readHeredocs(i + 1)
        continue
      }
      const redirect = REDIRECT.exec(src.slice(i, i + 6))
      if (redirect !== null && (redirect[1] !== '&' || src[i + 1] === '>')) {
        current ??= this.newCommand(i, pipeNext)
        i = this.redirect(i, redirect, current)
        continue
      }
      if (OPERATOR.test(c)) {
        if (c === ')') {
          close(i)
          if (nested && depth === 0) return { commands, end: i + 1 }
          depth--
          i++
          continue
        }
        if (c === '(') depth++
        close(i)
        const two = src.slice(i, i + 2)
        pipeNext = c === '|' && two !== '||'
        i += two === '&&' || two === '||' || two === '|&' || two === ';;' ? 2 : 1
        continue
      }
      current ??= this.newCommand(i, pipeNext)
      const w = this.word(i)
      current.words.push(w)
      i = w.end
    }
    close(i)
    return { commands, end: i }
  }

  newCommand(start: number, inPipeline: boolean): Command {
    return { start, end: start, words: [], heredocs: [], hasHerestring: false, hasStdinRedirect: false, inPipeline }
  }

  redirect(i: number, m: RegExpExecArray, command: Command): number {
    const op = m[2]!
    const fd = m[1] === '' ? (op.startsWith('<') ? '0' : '1') : m[1]
    let at = i + m[0].length
    while (at < this.src.length && BLANK.test(this.src[at]!)) at++
    const target = this.word(at)
    if (op === '<<' || op === '<<-') {
      const delimiter = target.parts.map(p => (p.kind === 'literal' ? p.text : this.src.slice(p.start, p.end))).join('')
      const quoted = target.parts.some(p => p.kind === 'literal' && p.quote !== 'none') || /\\/.test(this.src.slice(target.start, target.end))
      const h: Heredoc = { delimiter, quoted, stripTabs: op === '<<-', opener: { start: i, end: target.end }, body: { start: -1, end: -1 }, text: '' }
      command.heredocs.push(h)
      this.pending.push({ h, command })
    } else if (op === '<<<') command.hasHerestring = true
    if (fd === '0' && op.startsWith('<')) command.hasStdinRedirect = true
    return target.end
  }

  readHeredocs(i: number): number {
    const src = this.src
    for (const { h } of this.pending) {
      const lines: string[] = []
      let at = i
      h.body.start = i
      h.body.end = src.length
      while (at < src.length) {
        const nl = src.indexOf('\n', at)
        const lineEnd = nl < 0 ? src.length : nl
        let line = src.slice(at, lineEnd).replace(/\r$/, '')
        if (h.stripTabs) line = line.replace(/^\t+/, '')
        if (line === h.delimiter) {
          h.body.end = at
          at = nl < 0 ? src.length : nl + 1
          break
        }
        lines.push(line)
        at = nl < 0 ? src.length : nl + 1
      }
      if (h.body.end === src.length) at = src.length
      h.text = lines.map(l => `${l}\n`).join('')
      i = at
    }
    this.pending = []
    return i
  }

  word(i: number): Word {
    const src = this.src
    const parts: Part[] = []
    const start = i
    let lit = ''
    let litStart = i
    const flush = (end: number) => {
      if (lit !== '' || end > litStart) parts.push({ kind: 'literal', quote: 'none', text: lit, start: litStart, end })
      lit = ''
    }
    while (i < src.length) {
      const c = src[i]!
      if (BLANK.test(c) || OPERATOR.test(c) || c === '<' || c === '>') break
      if (c === '\\') {
        if (src[i + 1] !== '\n') lit += src[i + 1] ?? ''
        i = Math.min(i + 2, src.length)
        continue
      }
      if (c === "'" || (c === '$' && src[i + 1] === "'")) {
        flush(i)
        const open = c === '$' ? i + 2 : i + 1
        const close = c === '$' ? this.ansiEnd(open) : src.indexOf("'", open)
        const end = close < 0 ? src.length : close
        const raw = src.slice(open, end)
        parts.push({ kind: 'literal', quote: c === '$' ? 'ansi' : 'single', text: c === '$' ? ansiDecode(raw) : raw, start: i, end: Math.min(end + 1, src.length) })
        i = Math.min(end + 1, src.length)
        litStart = i
        continue
      }
      if (c === '"' || (c === '$' && src[i + 1] === '"')) {
        flush(i)
        i = this.double(c === '$' ? i + 2 : i + 1, parts)
        litStart = i
        continue
      }
      const exp = this.expansion(i, 'none')
      if (exp !== undefined) {
        flush(i)
        parts.push(exp)
        i = exp.end
        litStart = i
        continue
      }
      lit += c
      i++
    }
    flush(i)
    return { start, end: i, parts }
  }

  ansiEnd(i: number): number {
    while (i < this.src.length) {
      if (this.src[i] === '\\') i += 2
      else if (this.src[i] === "'") return i
      else i++
    }
    return -1
  }

  // Parses a double-quoted body from `i` (after the quote); returns the index past the closing quote.
  double(i: number, parts: Part[]): number {
    const src = this.src
    let lit = ''
    let litStart = i
    const flush = (end: number) => {
      if (lit !== '' || end > litStart) parts.push({ kind: 'literal', quote: 'double', text: lit, start: litStart, end })
      lit = ''
    }
    while (i < src.length) {
      const c = src[i]!
      if (c === '"') {
        flush(i)
        return i + 1
      }
      if (c === '\\' && /[$`"\\\n]/.test(src[i + 1] ?? '')) {
        if (src[i + 1] !== '\n') lit += src[i + 1]
        i += 2
        continue
      }
      const exp = this.expansion(i, 'double')
      if (exp !== undefined) {
        flush(i)
        parts.push(exp)
        i = exp.end
        litStart = i
        continue
      }
      lit += c
      i++
    }
    flush(i)
    return i
  }

  expansion(i: number, quote: 'none' | 'double'): Part | undefined {
    const src = this.src
    const c = src[i]
    if (c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1
      return { kind: 'expansion', quote, start: i, end: Math.min(j + 1, src.length) }
    }
    if (c !== '$') return undefined
    const n = src[i + 1] ?? ''
    if (n === '(' && src[i + 2] === '(') return { kind: 'expansion', quote, start: i, end: this.balanced(i + 1, '(', ')') }
    if (n === '(') {
      const script = this.script(i + 2, true)
      return { kind: 'expansion', quote, start: i, end: script.end, script }
    }
    if (n === '{') return { kind: 'expansion', quote, start: i, end: this.balanced(i + 1, '{', '}') }
    if (NAME.test(n)) {
      let j = i + 1
      while (j < src.length && /\w/.test(src[j]!)) j++
      return { kind: 'expansion', quote, start: i, end: j }
    }
    if (/[0-9@*#?$!-]/.test(n)) return { kind: 'expansion', quote, start: i, end: i + 2 }
    return undefined
  }

  balanced(i: number, open: string, close: string): number {
    let depth = 0
    for (; i < this.src.length; i++) {
      if (this.src[i] === open) depth++
      else if (this.src[i] === close && --depth === 0) return i + 1
    }
    return this.src.length
  }
}

export function parse(command: string): Script {
  return new Lexer(command).script(0, false)
}

// Every simple command, those inside `$( )` substitutions included, in source order.
export function allCommands(script: Script): Command[] {
  const out: Command[] = []
  for (const c of script.commands) {
    out.push(c)
    for (const w of c.words) for (const p of w.parts) if (p.kind === 'expansion' && p.script) out.push(...allCommands(p.script))
  }
  return out.sort((a, b) => a.start - b.start)
}
