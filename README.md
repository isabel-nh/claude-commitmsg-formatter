# claude-commitmsg-formatter

Claude Code mod that validates and normalizes git commit messages before a Bash `git commit` runs.

## Rules

| Rule | On violation |
| --- | --- |
| Subject at most 50 characters (`subjectMax`), counted in Unicode code points: `✨` is one, `♻️` two, `🧑‍💻` three. | Deny |
| Subject opens with exactly one gitmoji glyph from the [official list](https://gitmoji.dev) (bundled, no fetch). A variation selector is optional; ZWJ sequences are one glyph. A `:shortcode:` is rejected with the glyph to use. | Deny |
| No stacked emoji (`✨🐛`, `✨ 🐛`). | Deny |
| No colon anywhere in the subject. | Deny |
| A body beyond the subject; trailers alone do not count. | Deny |
| No match for any `disallowedPatterns` regex in subject or body. | Deny |
| Leading whitespace removed from the subject; one space after the emoji; first letter capitalized. | Normalize |
| Blank line between subject and body; a blank line between a paragraph and a list, and before trailers. | Normalize |
| Body paragraphs and list items with a line over 72 characters (`bodyWrap`) re-wrapped, list items with a hanging indent. Long words are hyphenated; URLs, paths and dotted names are kept whole on their own line. Trailers (`Co-Authored-By:`, `Signed-off-by:`) and lines indented by a tab or four spaces outside a list are never wrapped. | Normalize |

A denied commit lists every error, the subject length, and the normalized message where normalization changed it.

### Normalization

The command is rewritten in place, and runs, when the message is passed in a form that can be rewritten safely:

- `-m '<single-quoted>'` (one `-m` only)
- `-F - <<'EOF'` with a quoted delimiter
- `-m "$(cat <<'EOF' … EOF)"` with a quoted delimiter

Any other form (double-quoted `-m`, several `-m`, `-F <file>`) is denied with the normalized message to use instead. The model is told what was normalized.

### Commit forms

- Editor-opening forms are denied: no `-m` / `-F` / `-C` / `--no-edit` / `--fixup`, `--amend` without a message or `--no-edit`, `-e` / `--edit`, `-c <commit>` without `--no-edit`, `--fixup=amend:` / `--fixup=reword:` without `--no-edit` (or `GIT_EDITOR` set on the command).
- Messages git generates skip validation: `--amend --no-edit`, `--fixup=<commit>`, `-C <commit>`, and `--no-edit` while a merge is in progress (`MERGE_HEAD` exists). Bare `--no-edit` outside a merge is denied.
- `--fixup` with `--amend` or a message, and `--no-edit` with a message, are denied.
- `-F <file>` is read (relative to the repository directory: `git -C`, else `cd`, else the session's) and validated.
- A message built from a shell expansion (`-m "$MSG"`, an unquoted heredoc holding `$`) or `-F -` fed by a pipe cannot be checked and is denied.
- `git commit` inside quoted text (`echo "git commit"`) is not a commit. Other commands, `format-commit-message.sh` included, are left alone.

If the check fails, the call is denied, never passed through.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `subjectMax` | `50` | Maximum subject length. |
| `bodyWrap` | `72` | Body wrap width. |
| `requireGitmoji` | `true` | Off: no emoji is required, and a leading emoji may be any single emoji. |
| `disallowedPatterns` | empty | Regular expressions, one per line; a matching message is denied. An invalid expression denies every commit until fixed. |

Set them in `settings.json`:

```json
"pluginConfigs": {
  "commitmsg-formatter@isabel-nh": {
    "options": { "subjectMax": 50, "disallowedPatterns": "\\bDRAFT\\b" }
  }
}
```

## Limits

- Commits run through `bash -c '…'`, `xargs` or scripts are not seen.
- `cd` is tracked in command order, not by subshell scope.

## Install

The plugin is published through the [isabel-nh marketplace](https://github.com/isabel-nh/marketplace).

At the prompt of a Claude Code terminal session:

```
/plugin marketplace add isabel-nh/marketplace
/plugin install commitmsg-formatter@isabel-nh
```

From a shell:

```bash
claude plugin marketplace add isabel-nh/marketplace
```

```bash
claude plugin install commitmsg-formatter@isabel-nh
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `isabel-nh/marketplace`, then Add plugin.

Pick a scope when prompted (user scope applies to every session).

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

`tsc -p .` type-checks once Claude Code has loaded the mod and written `.claude-plugin/types/`.
