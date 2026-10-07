# pi-sandbox

A [Pi](https://pi.dev) extension that runs every bash command, including `!` commands you type, inside an OS-level sandbox via [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime). It also guards Pi's file tools: `read`, `grep`, `find`, and `ls` respect the read denials, and `write` and `edit` respect the write rules.

## Install

```bash
pi install git:github.com/ahalekelly/pi-sandbox@main
```

## Policy

- **Writes** are allowed in the project directory (where Pi starts), the trash (`~/.Trash`, `~/.local/share/Trash`), and the sandbox temp directory (`$CLAUDE_CODE_TMPDIR`, else `$CLAUDE_TMPDIR`, else `/tmp/claude`), which commands see as `TMPDIR`.
- **Writes are denied** to `.env`, `.env.*`, `*.pem`, `*.key`, and Pi's `auth.json`.
- **Reads are denied** for `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.secrets.env`, `~/.agents/secrets.env`, and Pi's `auth.json`.
- **Network** is unrestricted.
- **Commit signing** is turned off inside the sandbox, since signing keys are unreadable.

## Git

The git rules follow from the checkout Pi starts in:

- **Plain checkout:** `.git` is read-only. The agent can edit files but not commit.
- **Linked worktree** (`git worktree add`): the agent can commit, branch, and fetch. It may write the shared repository (objects, refs, logs) and its own worktree metadata, but not the main checkout's `HEAD`, `index`, or `config`, the shared `hooks/`, its own `config.worktree`, or the pointer files (`.git`, `gitdir`, `commondir`) that tell git where the repository lives.
- **Not a repository:** no git rules.

Give the agent its own worktree when it should commit.

## Fail closed

Bash refuses to run until the sandbox has initialized. If initialization fails, bash stays blocked for the whole session and the error says why.

## Requirements

- **macOS:** `sandbox-exec`, built in.
- **Linux:** `bubblewrap`, `socat`, and `ripgrep`. See the [sandbox runtime's platform notes](https://github.com/anthropic-experimental/sandbox-runtime#platform-support).

## Credits

Derived from [`@sysid/pi-sandbox`](https://github.com/sysid/pi-extensions) and Pi's example sandbox extension, both MIT licensed.
