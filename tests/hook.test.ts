import { expect, test } from 'claude-code/testing'

const CWD = 'C:/repo'
const GOOD = "git commit -m '✨ Add the formatter\n\nExplain why.'"

// A fake engine: session.cwd, process.run (git rev-parse MERGE_HEAD), fs.read and the Bash tool.
function setup(on: any, { merging = false, files = {} as Record<string, string> } = {}) {
  const ran: string[] = []
  const gitCalls: string[][] = []
  on('session.cwd', () => ({ value: CWD }))
  on('process.run', (_: unknown, e: any) => {
    gitCalls.push([...e.argv])
    return { value: { exitCode: merging ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_: unknown, e: any) => {
    const path = String(e.path).replaceAll('\\', '/')
    if (path in files) return { value: files[path] }
    throw new Error('ENOENT')
  })
  on('tool.call', (_: unknown, e: any) => {
    ran.push(e.command)
    return { result: 'ran' }
  })
  return { ran, gitCalls }
}
const bash = ($: any, command: string) => $.tool.call({ tool: 'Bash', command } as any)

test('a valid commit runs unchanged; other commands are untouched', async ($, on) => {
  const { ran } = setup(on)
  expect((await bash($, GOOD)).result).toBe('ran')
  expect((await bash($, 'echo "git commit"')).result).toBe('ran')
  expect((await bash($, 'format-commit-message.sh -c -q "bad: subject"')).result).toBe('ran')
  expect(ran).toEqual([GOOD, 'echo "git commit"', 'format-commit-message.sh -c -q "bad: subject"'])
})

test('violations are denied with every error and the subject length', async ($, on) => {
  const { ran } = setup(on)
  const r = await bash($, `git commit -m "feat: ${'x'.repeat(50)}"`)
  const deny = String(r.deny)
  expect(deny.startsWith('commitmsg-formatter: commit message rejected (subject 56/50 characters)')).toBe(true)
  expect(deny).toContain('Subject is 56 characters')
  expect(deny).toContain('must not contain a colon')
  expect(deny).toContain('must start with a gitmoji glyph')
  expect(deny).toContain('beyond just a subject line')
  expect(deny).not.toContain('--no-verify')
  expect(ran).toEqual([])
})

test('single-quoted -m needing normalization is rewritten before it runs', async ($, on) => {
  const { ran } = setup(on)
  const r = await bash($, "git commit -m '✨add the formatter\nExplain why.'")
  expect(ran).toEqual(["git commit -m '✨ Add the formatter\n\nExplain why.'"])
  expect(String(r.context)).toContain('normalized')
})

test('$(cat <<EOF) and -F - heredocs are rewritten in place', async ($, on) => {
  const { ran } = setup(on)
  await bash($, ["git commit -m \"$(cat <<'EOF'", '✨  add it', 'Why.', 'EOF', ')"'].join('\n'))
  await bash($, "git commit -F - <<'EOF'\n✨add it\n\nWhy.\nEOF")
  expect(ran).toEqual([["git commit -m \"$(cat <<'EOF'", '✨ Add it', '', 'Why.', 'EOF', ')"'].join('\n'), "git commit -F - <<'EOF'\n✨ Add it\n\nWhy.\nEOF"])
})

test('a form that cannot be rewritten safely is denied with the normalized message', async ($, on) => {
  const { ran } = setup(on)
  const r = await bash($, 'git commit -m "✨add it\n\nWhy."')
  expect(String(r.deny)).toContain('cannot be applied to this command safely')
  expect(String(r.deny)).toContain('✨ Add it\n\nWhy.')
  expect(ran).toEqual([])
})

test('-F <file> is read relative to the repository and validated', async ($, on) => {
  const { ran } = setup(on, { files: { 'C:/repo/sub/msg.txt': '✨ Add it\n\nWhy.\n', 'C:/tmp/bad.txt': 'no gitmoji\n\nWhy.', 'C:/repo/m.txt': '✨add it\n\nWhy.' } })
  expect((await bash($, 'git -C sub commit -F msg.txt')).result).toBe('ran')
  expect(String((await bash($, 'git commit -F C:/tmp/bad.txt')).deny)).toContain('must start with a gitmoji')
  expect(String((await bash($, 'git commit -F missing.txt')).deny)).toContain('could not be read')
  expect(String((await bash($, 'git commit -F m.txt')).deny)).toContain('cannot be applied')
  expect(ran.length).toBe(1)
})

test('editor-opening forms are denied; generated messages skip validation', async ($, on) => {
  const { ran } = setup(on)
  for (const c of ['git commit', 'git commit --amend', 'git commit -e -m x', 'git commit --fixup=amend:HEAD']) {
    expect(String((await bash($, c)).deny)).toContain('editor')
  }
  for (const c of ['git commit --amend --no-edit', 'git commit --fixup=HEAD~2', 'git commit -C HEAD']) {
    expect((await bash($, c)).result).toBe('ran')
  }
  expect(ran.length).toBe(3)
})

test('bare --no-edit runs only while a merge is in progress', async ($, on) => {
  const { gitCalls } = setup(on, { merging: false })
  expect(String((await bash($, 'git commit --no-edit')).deny)).toContain('--no-edit requires --amend, --fixup or a merge in progress')
  expect(gitCalls).toEqual([['git', '-C', 'C:/repo', 'rev-parse', '-q', '--verify', 'MERGE_HEAD']])
})

test('merge commit via --no-edit with MERGE_HEAD present passes', async ($, on) => {
  setup(on, { merging: true })
  expect((await bash($, 'git commit --no-edit')).result).toBe('ran')
})

test('messages built from shell expansions are denied as uncheckable', async ($, on) => {
  setup(on)
  expect(String((await bash($, 'git commit -m "$MSG"')).deny)).toContain('cannot be checked')
})

test('requireGitmoji off accepts a plain subject', { options: { requireGitmoji: false } }, async ($, on) => {
  setup(on)
  expect((await bash($, "git commit -m 'Add the formatter\n\nWhy.'")).result).toBe('ran')
})

test('disallowedPatterns deny a matching message', { options: { disallowedPatterns: 'ABC-\\d+\n\nSECRET' } }, async ($, on) => {
  setup(on)
  expect(String((await bash($, "git commit -m '✨ Add ABC-42 support\n\nWhy.'")).deny)).toContain('disallowed pattern /ABC-\\d+/')
  expect(String((await bash($, "git commit -m '✨ Add it\n\nSECRET reason.'")).deny)).toContain('/SECRET/')
  expect((await bash($, GOOD)).result).toBe('ran')
})

test('an invalid disallowed pattern fails closed', { options: { disallowedPatterns: '(' } }, async ($, on) => {
  setup(on)
  expect(String((await bash($, GOOD)).deny)).toContain('invalid regular expression')
})

test('every commit in a command is checked', async ($, on) => {
  const { ran } = setup(on)
  expect(String((await bash($, `${GOOD} && git commit -m 'bad'`)).deny)).toContain('rejected')
  expect(ran).toEqual([])
})
