import type { PluginOptions, Register } from 'claude-code'
import { applyEdits, classify, findCommits, MERGE_HEAD_ARGS, resolve, rewrite, type Edit } from './commit.ts'
import { checkMessage, DEFAULT_RULES, type Rules } from './message.ts'

export function rulesFrom(options: PluginOptions): { rules: Rules; error?: string } {
  const int = (v: unknown, min: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : fallback)
  const disallowed: RegExp[] = []
  let error: string | undefined
  for (const line of String(options.disallowedPatterns ?? '').split(/\r?\n/)) {
    const source = line.trim()
    if (source === '') continue
    try {
      disallowed.push(new RegExp(source))
    } catch {
      error ??= `the disallowedPatterns option holds an invalid regular expression (${source}), so no commit message can be checked. Fix the option.`
    }
  }
  const rules: Rules = {
    subjectMax: int(options.subjectMax, 10, DEFAULT_RULES.subjectMax),
    bodyWrap: int(options.bodyWrap, 20, DEFAULT_RULES.bodyWrap),
    requireGitmoji: options.requireGitmoji !== false,
    disallowed,
  }
  return error === undefined ? { rules } : { rules, error }
}

const LITERAL = "Pass the message as literal text: -m '<message>', or -F - with a quoted heredoc (<<'EOF')."

export const register: Register = (on, options) => {
  const { rules, error } = rulesFrom(options)

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!/\bcommit\b/.test(e.command)) return next(e)
    const commits = findCommits(e.command, await $.session.cwd())
    if (commits.length === 0) return next(e)
    const deny = (reason: string) => ({ deny: `${$.plugin.name}: ${reason}` })
    if (error !== undefined) return deny(error)

    const edits: Edit[] = []
    const fixes = new Set<string>()
    for (const commit of commits) {
      const plan = classify(commit)
      if (plan.action === 'skip') continue
      if (plan.action === 'deny') return deny(plan.reason)
      if (plan.action === 'merge') {
        const merging = commit.dir !== undefined && (await $.process.run(MERGE_HEAD_ARGS(commit.dir), { timeoutMs: 15_000 })).exitCode === 0
        if (merging) continue
        return deny('--no-edit requires --amend, --fixup or a merge in progress. On its own it reuses a message nobody authored. Pass a message instead.')
      }

      const texts: string[] = []
      for (const source of plan.sources) {
        if (source.kind === 'unknown') return deny(`the commit message cannot be checked: ${source.reason}. ${LITERAL}`)
        if (source.kind === 'text') {
          texts.push(source.text)
          continue
        }
        const path = resolve(source.path, commit.dir)
        let text: string | undefined
        try {
          text = path === undefined ? undefined : await $.fs.read(path)
        } catch {
          text = undefined
        }
        if (text === undefined) return deny(`the -F file ${source.path} could not be read, so its message cannot be checked. ${LITERAL}`)
        texts.push(text)
      }

      const verdict = checkMessage(texts.join('\n\n'), rules)
      const corrected = verdict.changed ? `\n\nNormalized message (${verdict.fixes.join('; ')}):\n${verdict.message}` : ''
      if (verdict.errors.length > 0) {
        const list = verdict.errors.map(err => `  - ${err}`).join('\n')
        return deny(`commit message rejected (subject ${verdict.subjectLength}/${rules.subjectMax} characters):\n${list}\nFix every item and run the commit again.${corrected}`)
      }
      if (!verdict.changed) continue
      const edit = plan.sources.length === 1 ? rewrite(plan.sources[0]!, verdict.message) : undefined
      if (edit === undefined) return deny(`the commit message needs reformatting that cannot be applied to this command safely. Run the commit again with the normalized message.${corrected}`)
      edits.push(edit)
      for (const f of verdict.fixes) fixes.add(f)
    }

    if (edits.length === 0) return next(e)
    const ran = await next({ ...e, command: applyEdits(e.command, edits) })
    if (ran.deny !== undefined) return ran
    return { ...ran, context: [...(ran.context ?? []), `${$.plugin.name}: the commit message was normalized before it ran (${[...fixes].join('; ')}).`] }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: its commit-message check failed.` }))
}
