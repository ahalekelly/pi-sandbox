import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readBlocked, writeBlocked } from "../src/path-guard.ts";
import { sandboxPolicy } from "../src/policy.ts";

const auth = "/home/user/.pi/agent/auth.json";

function tempDir(name: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `pi-sandbox-${name}-`)));
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, stdio: "ignore" });
}

function repo(): string {
  const dir = tempDir("repo");
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

test("policy leaves network unrestricted and protects secrets and Pi's auth.json", () => {
  const policy = sandboxPolicy(tempDir("plain"), auth);
  assert.deepEqual(policy.network, {});
  assert.ok(policy.filesystem.denyRead.includes(auth));
  assert.ok(policy.filesystem.denyRead.includes("~/.ssh"));
  assert.ok(policy.filesystem.denyWrite.includes(auth));
  assert.match(readBlocked(auth, policy.filesystem, "/work"), /restricted path/);
});

test("outside git, the project is writable and has no git paths", () => {
  const cwd = tempDir("nogit");
  const policy = sandboxPolicy(cwd, auth);
  assert.equal(policy.filesystem.allowWrite[0], cwd);
  assert.equal(policy.filesystem.allowWrite.length, 4);
  assert.deepEqual(policy.filesystem.denyWrite.filter((entry) => entry.startsWith(cwd)), []);
  assert.equal(writeBlocked("src/app.ts", policy.filesystem, cwd), "");
});

test("a plain checkout denies writes to its .git", () => {
  const cwd = repo();
  const policy = sandboxPolicy(cwd, auth);
  assert.ok(policy.filesystem.denyWrite.includes(join(cwd, ".git")));
  assert.equal(writeBlocked("src/app.ts", policy.filesystem, cwd), "");
  assert.match(writeBlocked(".git/index", policy.filesystem, cwd), /restricted/);
  assert.match(writeBlocked("nested/.git/config", policy.filesystem, cwd), /restricted .git metadata/);
});

test("a linked worktree may write the shared repository except the main checkout's state", () => {
  const main = repo();
  const cwd = join(tempDir("wt"), "feature");
  git(main, "worktree", "add", "-q", "-b", "feature", cwd);
  const policy = sandboxPolicy(cwd, auth);
  const common = join(main, ".git");
  assert.deepEqual(policy.filesystem.allowWrite.slice(4), [common]);
  for (const path of [
    join(common, "objects/ab/cdef"),
    join(common, "refs/heads/feature"),
    join(common, "packed-refs"),
    join(common, "logs/HEAD"),
    join(common, "worktrees/feature/HEAD"),
    join(common, "worktrees/feature/index"),
    join(cwd, "src/app.ts"),
  ]) assert.equal(writeBlocked(path, policy.filesystem, cwd), "", path);
  for (const path of [
    join(common, "HEAD"),
    join(common, "index"),
    join(common, "config"),
    join(common, "hooks/pre-commit"),
    join(common, "worktrees/feature/config.worktree"),
    join(common, "worktrees/feature/commondir"),
    join(common, "worktrees/feature/gitdir"),
    join(cwd, ".git"),
    join(main, "src/app.ts"),
  ]) assert.match(writeBlocked(path, policy.filesystem, cwd), /Write denied/, path);
});

test("write guard blocks secrets and paths outside the allowed set", () => {
  const cwd = tempDir("guard");
  const policy = sandboxPolicy(cwd, auth);
  assert.match(writeBlocked(".env", policy.filesystem, cwd), /restricted pattern/);
  assert.match(writeBlocked("config/.env.local", policy.filesystem, cwd), /restricted pattern/);
  assert.match(writeBlocked("certs/server.pem", policy.filesystem, cwd), /restricted pattern/);
  assert.match(writeBlocked("/work/other/app.ts", policy.filesystem, cwd), /outside allowed paths/);
});

test("write guard resolves an existing symlink before checking a new target", () => {
  const cwd = tempDir("symlink");
  const outside = tempDir("outside");
  symlinkSync(outside, join(cwd, "escape"));
  const policy = sandboxPolicy(cwd, auth);
  assert.match(writeBlocked("escape/new.txt", policy.filesystem, cwd), /outside allowed paths/);
});
