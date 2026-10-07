import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";

export type FilesystemPolicy = {
  denyRead: string[];
  allowWrite: string[];
  denyWrite: string[];
};

// Resolves symlinks in the longest existing prefix, so a new file behind a
// symlinked directory is checked where it would actually land.
export function absolute(path: string, cwd: string): string {
  const resolved = path === "~" || path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
  try {
    return realpathSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(resolved);
    if (parent === resolved) throw error;
    return resolve(absolute(parent, cwd), relative(parent, resolved));
  }
}

function under(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

function inGit(path: string): boolean {
  return path.split(sep).includes(".git");
}

// Entries containing a slash are paths (a trailing /** covers the subtree);
// bare entries are file-name patterns matched anywhere.
function denies(entry: string, target: string, cwd: string): boolean {
  if (entry.includes("/")) return under(target, absolute(entry.replace(/\/\*\*$/, ""), cwd));
  const name = basename(target);
  if (entry.startsWith("*")) return name.endsWith(entry.slice(1));
  if (entry.endsWith("*")) return name.startsWith(entry.slice(0, -1));
  return name === entry;
}

export function readBlocked(path: string, policy: FilesystemPolicy, cwd: string): string {
  const target = absolute(path, cwd);
  const denied = policy.denyRead.find((entry) => under(target, absolute(entry, cwd)));
  return denied ? `Read denied: '${path}' is under restricted path '${denied}'` : "";
}

// Allowing a directory never opens .git metadata inside it: writes under a
// .git directory need an allowWrite entry that is itself inside .git.
export function writeBlocked(path: string, policy: FilesystemPolicy, cwd: string): string {
  const target = absolute(path, cwd);
  const denied = policy.denyWrite.find((entry) => denies(entry, target, cwd));
  if (denied) return `Write denied: '${path}' matches restricted pattern '${denied}'`;
  const allowed = policy.allowWrite.some((entry) => {
    const directory = absolute(entry, cwd);
    return under(target, directory) && (!inGit(target) || inGit(directory));
  });
  if (allowed) return "";
  return inGit(target) ? `Write denied: '${path}' targets restricted .git metadata` : `Write denied: '${path}' is outside allowed paths`;
}
