import { expect, test } from 'claude-code/testing'
import { applyEdits, classify, findCommits, rewrite, type MessageSource } from '../hooks/commit.ts'

const CWD = 'C:/repo'
const one = (command: string) => {
  const found = findCommits(command, CWD)
  expect(found.length).toBe(1)
  return found[0]!
}
const sources = (command: string): MessageSource[] => {
  const plan = classify(one(command))
  if (plan.action !== 'validate') throw new Error(`expected validate, got ${plan.action}`)
  return plan.sources
}
const textOf = (s: MessageSource | undefined) => (s?.kind === 'text' ? s.text : `<${s?.kind}>`)

const CAT = ["git commit -m \"$(cat <<'EOF'", '✨ Add a thing', '', 'Body.', 'EOF', ')"'].join('\n')

test('git commit inside quotes or as an argument is not a commit', () => {
  expect(findCommits('echo "git commit -m x"', CWD)).toEqual([])
  expect(findCommits("grep 'git commit' log.txt", CWD)).toEqual([])
  expect(findCommits('format-commit-message.sh -c -q "✨ Add git commit docs"', CWD)).toEqual([])
  expect(findCommits('git log --grep commit', CWD)).toEqual([])
})

test('directory from git -C, then cd, then the session cwd', () => {
  expect(one('git -C "C:/other repo" commit -m x').dir).toBe('C:/other repo')
  expect(one('cd sub && git commit -m x').dir).toBe('C:/repo/sub')
  expect(one('git commit -m x').dir).toBe('C:/repo')
  expect(findCommits('git add . && git commit -m a; git -C b commit -m c', CWD).map(c => c.dir)).toEqual(['C:/repo', 'C:/repo/b'])
})

test('message forms: -m, --message=, -am, attached, multiple -m', () => {
  expect(textOf(sources("git commit -m 'single'")[0])).toBe('single')
  expect(textOf(sources('git commit --message="double $ sign\\"q\\""')[0])).toBe('double $ sign"q"')
  expect(textOf(sources("git commit -am 'bundled'")[0])).toBe('bundled')
  expect(textOf(sources("git commit -m'attached'")[0])).toBe('attached')
  expect(sources('git commit -m a -m b').map(textOf)).toEqual(['a', 'b'])
})

test('$(cat <<EOF) and -F - heredoc forms', () => {
  expect(textOf(sources(CAT)[0])).toBe('✨ Add a thing\n\nBody.')
  expect(textOf(sources("git commit -F - <<'EOF'\n✨ Add a thing\n\nBody.\nEOF")[0])).toBe('✨ Add a thing\n\nBody.\n')
  expect(textOf(sources('git commit -F- <<EOF\nplain text\nEOF')[0])).toBe('plain text\n')
  expect(sources('git commit -F - <<EOF\n$(date)\nEOF')[0]!.kind).toBe('unknown')
  expect(sources('printf x | git commit -F -')[0]!.kind).toBe('unknown')
})

test('-F <file> is a file source; expansions are unknown', () => {
  expect(sources('git commit -F msg.txt')[0]).toEqual({ kind: 'file', path: 'msg.txt' })
  expect(sources('git commit --file=C:/tmp/m.txt')[0]).toEqual({ kind: 'file', path: 'C:/tmp/m.txt' })
  expect(sources('git commit -m "$MSG"')[0]!.kind).toBe('unknown')
  expect(sources('git commit -m "$(git log -1 --format=%B)"')[0]!.kind).toBe('unknown')
})

test('editor-opening forms are denied', () => {
  for (const c of ['git commit', 'git commit -a', 'git commit --amend', 'git commit -e -m x', 'git commit --edit -m x', 'git commit -c HEAD', 'git commit --fixup=amend:HEAD~1', 'git commit --squash=HEAD', 'git commit -t tpl.txt']) {
    expect(classify(one(c)).action).toBe('deny')
  }
})

test('generated messages skip validation', () => {
  for (const c of ['git commit --amend --no-edit', 'git commit --fixup=abc123', 'git commit --fixup abc123', 'git commit --fixup=amend:HEAD --no-edit', 'git commit --fixup=reword:HEAD --no-edit', 'git commit -C HEAD', 'git commit --reuse-message=HEAD', 'git commit -c HEAD --no-edit', 'GIT_EDITOR=true git commit --fixup=amend:HEAD']) {
    expect(classify(one(c)).action).toBe('skip')
  }
  expect(classify(one('git commit --no-edit')).action).toBe('merge')
})

test('wrapper flag rules: --fixup with --amend or a message, --no-edit with a message', () => {
  expect(classify(one('git commit --amend --fixup=abc')).action).toBe('deny')
  expect(classify(one("git commit --fixup=abc -m 'x'")).action).toBe('deny')
  expect(classify(one("git commit --amend --no-edit -m 'x'")).action).toBe('deny')
})

test('rewrite: single-quoted -m and quoted heredocs only', () => {
  const single = "git commit -m '✨add it' && git push"
  const [s] = sources(single)
  expect(applyEdits(single, [rewrite(s!, "✨ Add it's\n\nBody.")!])).toBe("git commit -m '✨ Add it'\\''s\n\nBody.' && git push")

  const [cat] = sources(CAT)
  expect(applyEdits(CAT, [rewrite(cat!, '✨ Add it\n\nNew body.')!])).toBe(["git commit -m \"$(cat <<'EOF'", '✨ Add it', '', 'New body.', 'EOF', ')"'].join('\n'))

  const stdin = "git commit -F - <<'MSG'\nold\nMSG\necho done"
  const [h] = sources(stdin)
  expect(applyEdits(stdin, [rewrite(h!, 'new\n\nbody')!])).toBe("git commit -F - <<'MSG'\nnew\n\nbody\nMSG\necho done")

  expect(rewrite(sources('git commit -m "double"')[0]!, 'x')).toBeUndefined()
  expect(rewrite(sources('git commit -F - <<EOF\nplain\nEOF')[0]!, 'x')).toBeUndefined()
  expect(rewrite(h!, 'a\nMSG\nb')).toBeUndefined()
})
