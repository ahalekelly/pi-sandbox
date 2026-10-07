import { spawnSync } from "node:child_process";
import { join } from "node:path";

import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

import type { FilesystemPolicy } from "./path-guard.ts";

// The sandbox runtime points the child's TMPDIR at this directory (same
// precedence) but neither creates it nor permits writes to it when set by
// environment variable, so without the mkdir and allowWrite every
// TMPDIR-respecting tool (python tempfile, node os.tmpdir) fails, and mktemp
// silently returns "" so `cat $tmp` hangs on stdin.
export function sandboxTmpdir(): string {
  return process.env.CLAUDE_CODE_TMPDIR || process.env.CLAUDE_TMPDIR || "/tmp/claude";
}

// A plain checkout keeps its .git read-only. A linked worktree may write its
// own gitdir and the shared repository (objects, refs, logs) so commits work,
// but not the main checkout's HEAD, index, config, or hooks, nor any pointer
// file that tells git where the repository lives.
function gitPaths(cwd: string): { allowWrite: string[]; denyWrite: string[] } {
  const git = (...args: string[]) => spawnSync("git", ["rev-parse", "--path-format=absolute", ...args], { cwd, encoding: "utf8" });
  const dirs = git("--git-dir", "--git-common-dir");
  if (dirs.error) throw dirs.error;
  if (dirs.status !== 0) {
    if (dirs.stderr.includes("not a git repository")) return { allowWrite: [], denyWrite: [] };
    throw new Error(`git rev-parse failed in ${cwd}: ${dirs.stderr.trim()}`);
  }
  const [gitDir, commonDir] = dirs.stdout.trim().split("\n") as [string, string];
  if (gitDir === commonDir) return { allowWrite: [], denyWrite: [gitDir] };
  const toplevel = git("--show-toplevel");
  if (toplevel.status !== 0) throw new Error(`git rev-parse --show-toplevel failed in ${cwd}: ${toplevel.stderr.trim()}`);
  return {
    allowWrite: [commonDir],
    denyWrite: [
      ...["HEAD", "index", "config", "hooks"].map((name) => join(commonDir, name)),
      ...["config.worktree", "commondir", "gitdir"].map((name) => join(gitDir, name)),
      join(toplevel.stdout.trim(), ".git"),
    ],
  };
}

export function sandboxPolicy(cwd: string, authPath: string): SandboxRuntimeConfig & { filesystem: FilesystemPolicy } {
  const git = gitPaths(cwd);
  return {
    // The runtime restricts network only when allowedDomains is set; an empty
    // object leaves command network unrestricted while keeping the filesystem
    // sandbox. Its type marks allowedDomains required, hence the cast.
    network: {} as SandboxRuntimeConfig["network"],
    filesystem: {
      denyRead: ["~/.agents/secrets.env", "~/.secrets.env", "~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gcloud", authPath],
      allowWrite: [cwd, sandboxTmpdir(), "~/.Trash", "~/.local/share/Trash", ...git.allowWrite],
      denyWrite: [
        // The runtime makes these two writable by default.
        "~/.npm/_logs/**",
        "~/.claude/debug/**",
        ".env",
        ".env.*",
        "*.pem",
        "*.key",
        authPath,
        ...git.denyWrite,
      ],
    },
  };
}
