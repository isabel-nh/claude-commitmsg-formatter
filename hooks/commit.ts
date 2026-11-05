import { allCommands, parse, wordValue, type Command, type Heredoc, type Part, type Range, type Script, type Word } from './shell.ts'

export type Edit = Range & { text: string }
type Target = { kind: 'single'; part: Range } | { kind: 'heredoc'; heredoc: Heredoc }

export type MessageSource =
  | { kind: 'text'; text: string; target?: Target }
  | { kind: 'file'; path: string }
  | { kind: 'unknown'; reason: string }

export type Commit = {
  // The directory git runs in: the last `git -C`, else the last `cd`, else the session's.
  dir: string | undefined
  command: Command
  amend: boolean
  noEdit: boolean
  edit: boolean
  reuse: boolean
  reedit: boolean
  editorSet: boolean
  fixup?: string
  squash?: string
  messages: MessageSource[]
  file?: MessageSource
}

export type Plan =
  | { action: 'skip' }
  | { action: 'deny'; reason: string }
  | { action: 'merge' }
  | { action: 'validate'; sources: MessageSource[] }

export function normalizeDrive(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const posix = /^\/([A-Za-z])(\/|$)/.exec(s)
  if (posix) s = `${posix[1]!.toUpperCase()}:/${s.slice(3)}`
  return s.length > 3 ? s.replace(/\/+$/, '') : s
}

export function resolve(p: string, cwd: string | undefined): string | undefined {
  if (p.startsWith('~')) return undefined
  const expanded = normalizeDrive(p)
  const isAbsolute = /^([A-Za-z]:\/|\/)/.test(expanded)
  if (!isAbsolute && cwd === undefined) return undefined
  const abs = isAbsolute ? expanded : `${normalizeDrive(cwd!)}/${expanded}`
  const out: string[] = []
  for (const seg of abs.split('/')) {
    if (seg === '.' || (seg === '' && out.length > 0)) continue
    if (seg === '..') {
      if (out.length > 1) out.pop()
    } else out.push(seg)
  }
  return normalizeDrive(out.join('/') || '/')
}

const PREFIX_WORDS = new Set(['{', '!', 'time', 'command', 'exec', 'env', 'sudo', 'nohup'])
const GIT_VALUE_OPTIONS = new Set(['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])
const COMMIT_VALUE_OPTIONS = new Set(['--author', '--date', '--cleanup', '--trailer', '--pathspec-from-file'])

// The text of a word's leading unquoted literal: the option name in `--message="$(...)"`.
function leadingBare(w: Word): string {
  let s = ''
  for (const p of w.parts) {
    if (p.kind !== 'literal' || p.quote !== 'none') break
    s += p.text
  }
  return s
}

// The parts of a word past its first `skip` characters (an attached option value).
function valueAfter(w: Word, skip: number): Part[] {
  const [first, ...rest] = w.parts
  if (first === undefined || first.kind !== 'literal') return w.parts
  if (first.text.length === skip) return rest
  if (first.text.length < skip) return rest
  return [{ ...first, text: first.text.slice(skip), quote: 'none' }, ...rest]
}

function catHeredoc(script: Script): Heredoc | undefined {
  if (script.commands.length !== 1) return undefined
  const [cat] = script.commands
  const words = cat!.words.map(wordValue)
  const isCat = words[0] === 'cat' && (words.length === 1 || (words.length === 2 && words[1] === '-'))
  return isCat && cat!.heredocs.length === 1 && !cat!.hasHerestring ? cat!.heredocs[0] : undefined
}

const EXPANDS = /[$`\\]/
const UNKNOWN_EXPANSION = 'it passes through a shell expansion'

function heredocSource(h: Heredoc, trimTrailing: boolean): MessageSource {
  if (!h.quoted && EXPANDS.test(h.text)) return { kind: 'unknown', reason: `its heredoc delimiter is unquoted and the body holds $, \` or \\` }
  const text = trimTrailing ? h.text.replace(/\n+$/, '') : h.text
  return { kind: 'text', text, target: h.quoted ? { kind: 'heredoc', heredoc: h } : undefined }
}

function messageSource(parts: Part[] | undefined): MessageSource {
  if (parts === undefined) return { kind: 'unknown', reason: 'the option has no value' }
  if (parts.every(p => p.kind === 'literal')) {
    const only = parts.length === 1 && parts[0]!.quote === 'single' ? parts[0]! : undefined
    return { kind: 'text', text: parts.map(p => (p.kind === 'literal' ? p.text : '')).join(''), target: only && { kind: 'single', part: only } }
  }
  const [sub] = parts
  if (parts.length === 1 && sub!.kind === 'expansion' && sub!.quote === 'double' && sub!.script !== undefined) {
    const h = catHeredoc(sub!.script)
    if (h !== undefined) return heredocSource(h, true)
  }
  return { kind: 'unknown', reason: UNKNOWN_EXPANSION }
}

function stdinSource(c: Command): MessageSource {
  const h = c.heredocs[c.heredocs.length - 1]
  if (h !== undefined && !c.hasHerestring) return heredocSource(h, false)
  return { kind: 'unknown', reason: '-F - reads stdin from something other than a heredoc' }
}

function parseCommit(cmd: Command, from: number, dir: string | undefined, editorSet: boolean): Commit {
  const c: Commit = { dir, command: cmd, amend: false, noEdit: false, edit: false, reuse: false, reedit: false, editorSet, messages: [] }
  const words = cmd.words
  for (let k = from; k < words.length; k++) {
    const w = words[k]!
    const opt = wordValue(w) ?? leadingBare(w)
    const nextParts = (): Part[] | undefined => (k + 1 < words.length ? words[++k]!.parts : undefined)
    const text = (parts: Part[] | undefined) => (parts === undefined ? '' : (wordValue({ start: 0, end: 0, parts }) ?? '?'))
    const take = (flag: string, parts: Part[] | undefined) => {
      if (flag === 'm') c.messages.push(messageSource(parts))
      else if (flag === 'F') c.file = text(parts) === '-' ? stdinSource(cmd) : parts && wordValue({ start: 0, end: 0, parts }) !== undefined ? { kind: 'file', path: text(parts) } : { kind: 'unknown', reason: UNKNOWN_EXPANSION }
      else if (flag === 'C') c.reuse = true
      else if (flag === 'c') c.reedit = true
    }
    if (opt === '--') break
    if (opt.startsWith('--')) {
      const eq = opt.indexOf('=')
      const name = eq < 0 ? opt : opt.slice(0, eq)
      const value = () => (eq < 0 ? nextParts() : valueAfter(w, eq + 1))
      if (name === '--message') take('m', value())
      else if (name === '--file') take('F', value())
      else if (name === '--reuse-message') take('C', value())
      else if (name === '--reedit-message') take('c', value())
      else if (name === '--template') value()
      else if (name === '--fixup') c.fixup = text(value())
      else if (name === '--squash') c.squash = text(value())
      else if (COMMIT_VALUE_OPTIONS.has(name) && eq < 0) k++
      else if (name === '--amend') c.amend = true
      else if (name === '--no-edit') c.noEdit = true
      else if (name === '--edit') c.edit = true
    } else if (opt.startsWith('-') && opt.length > 1) {
      for (let j = 1; j < opt.length; j++) {
        const ch = opt[j]!
        if ('mFCct'.includes(ch)) {
          take(ch, j + 1 < opt.length ? valueAfter(w, j + 1) : nextParts())
          break
        }
        if (ch === 'S' || ch === 'u') break
        if (ch === 'e') c.edit = true
      }
    }
  }
  return c
}

// Every `git commit` run as a command of its own; `git commit` inside quoted text is an argument, not one.
export function findCommits(command: string, cwd: string): Commit[] {
  const out: Commit[] = []
  let dir: string | undefined = normalizeDrive(cwd)
  for (const cmd of allCommands(parse(command))) {
    const values = cmd.words.map(wordValue)
    let k = 0
    let editorSet = false
    for (; k < values.length; k++) {
      const v = values[k]
      if (v === undefined) break
      if (/^[A-Za-z_]\w*=/.test(v)) editorSet ||= v.startsWith('GIT_EDITOR=')
      else if (!PREFIX_WORDS.has(v)) break
    }
    const head = values[k]
    if (head === 'cd' || head === 'pushd') {
      const target = values[k + 1] === '--' ? values[k + 2] : values[k + 1]
      dir = target === undefined ? undefined : resolve(target, dir)
      continue
    }
    if (head === undefined || !/^(?:.*[/\\])?git(?:\.exe)?$/i.test(head)) continue
    let repo = dir
    for (k++; k < values.length; k++) {
      const v = values[k]
      if (v === undefined) break
      if (v === '-C') {
        const target = values[++k]
        repo = target === undefined ? undefined : resolve(target, repo)
      } else if (v === '-c') editorSet ||= values[++k]?.startsWith('core.editor=') ?? false
      else if (GIT_VALUE_OPTIONS.has(v)) k++
      else if (!v.startsWith('-')) break
    }
    if (values[k] === 'commit') out.push(parseCommit(cmd, k + 1, repo, editorSet))
  }
  return out
}

const deny = (reason: string): Plan => ({ action: 'deny', reason })
const NO_EDITOR = 'which is not available here'

// What git does for the message: generates it (skip), would open an editor (deny), or takes the authored text (validate).
export function classify(c: Commit): Plan {
  const hasMessage = c.messages.length > 0 || c.file !== undefined
  if (c.edit) return deny(`-e/--edit opens an editor, ${NO_EDITOR}. Pass the message with -m or -F instead.`)
  if (c.fixup !== undefined) {
    if (c.amend) return deny('--amend and --fixup are mutually exclusive. To amend the message of an earlier commit, use --fixup=amend:<commit>.')
    if (hasMessage) return deny("--fixup takes no message; git generates 'fixup! <subject>'.")
    const prefix = /^(amend|reword):/.exec(c.fixup)
    if (prefix !== null && !c.noEdit && !c.editorSet) return deny(`--fixup=${prefix[1]}: opens an editor on the copied log message, ${NO_EDITOR}. Pass --no-edit to keep that message verbatim.`)
    return { action: 'skip' }
  }
  if (c.reuse) return { action: 'skip' }
  if (c.reedit) return c.noEdit ? { action: 'skip' } : deny(`-c <commit> opens an editor on the reused message, ${NO_EDITOR}. Use -C <commit> to reuse it unchanged, or pass a new message with -m.`)
  if (c.squash !== undefined) return hasMessage || c.noEdit ? { action: 'skip' } : deny(`--squash without -m opens an editor, ${NO_EDITOR}. Pass --no-edit or -m.`)
  if (c.noEdit) {
    if (hasMessage) return deny('--no-edit reuses the existing message; do not pass one.')
    return c.amend ? { action: 'skip' } : { action: 'merge' }
  }
  if (hasMessage) return { action: 'validate', sources: c.file !== undefined && c.messages.length === 0 ? [c.file] : c.messages }
  if (c.amend) return deny(`--amend needs either a new message or --no-edit. Without one git would open an editor, ${NO_EDITOR}.`)
  return deny(`git commit without -m or -F opens an editor, ${NO_EDITOR}. Pass the message with -m, or with -F - and a quoted heredoc (<<'EOF').`)
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

// The edit that puts `message` in place of a source's text, when the source's shell form allows it.
export function rewrite(source: MessageSource, message: string): Edit | undefined {
  if (source.kind !== 'text' || source.target === undefined) return undefined
  const t = source.target
  if (t.kind === 'single') return { ...t.part, text: shellQuote(message) }
  const lines = message.split('\n')
  if (lines.some(l => l === t.heredoc.delimiter || (t.heredoc.stripTabs && l.startsWith('\t')))) return undefined
  return { ...t.heredoc.body, text: `${message}\n` }
}

export function applyEdits(command: string, edits: readonly Edit[]): string {
  let out = command
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

export const MERGE_HEAD_ARGS = (dir: string): string[] => ['git', '-C', dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD']
