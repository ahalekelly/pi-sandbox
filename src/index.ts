import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  createBashTool,
  getAgentDir,
  isToolCallEventType,
  type BashOperations,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { readBlocked, writeBlocked } from "./path-guard.ts";
import { sandboxPolicy, sandboxTmpdir } from "./policy.ts";

function sandboxedBash(): BashOperations {
  if (!process.env.PATH) throw new Error("PATH environment variable is required");
  // Commit signing cannot work in the sandbox — the user's signing key is
  // unreadable by design, and the agent signing as the user would be
  // dishonest anyway. Without this, a global commit.gpgsign=true fails every
  // commit with "could not create temporary file: Operation not permitted".
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
  };

  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
      const timeoutSeconds = timeout && timeout > 0 ? Math.min(timeout, 600) : 600;
      const wrapped = await SandboxManager.wrapWithSandbox(command);
      return await new Promise((resolveCommand, reject) => {
        const child = spawn("bash", ["-c", wrapped], {
          cwd,
          detached: true,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        }, timeoutSeconds * 1000);
        const abort = () => child.pid && process.kill(-child.pid, "SIGKILL");
        let finished = false;
        const finish = (complete: () => void) => {
          if (finished) return;
          finished = true;
          SandboxManager.cleanupAfterCommand();
          complete();
        };
        signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.once("error", (error) => finish(() => reject(error)));
        child.once("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          finish(() => {
            if (signal?.aborted) reject(new Error("Sandboxed command aborted"));
            else if (timedOut) reject(new Error(`Sandboxed command timed out after ${timeoutSeconds} seconds`));
            else resolveCommand({ exitCode: code });
          });
        });
      });
    },
  };
}

export default function sandboxExtension(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const localBash = createBashTool(cwd);
  const policy = sandboxPolicy(cwd, join(getAgentDir(), "auth.json"));
  let status: { state: "starting" } | { state: "ready" } | { state: "failed"; error: string } = { state: "starting" };

  // Bash refuses to run until the OS sandbox is up, and forever if it failed.
  const requireReady = () => {
    if (status.state === "failed") throw new Error(status.error);
    if (status.state === "starting") throw new Error("Sandbox has not initialized; bash is blocked");
  };

  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate) {
      requireReady();
      return createBashTool(cwd, { operations: sandboxedBash() }).execute(id, params, signal, onUpdate);
    },
  });

  pi.on("user_bash", () => {
    requireReady();
    return { operations: sandboxedBash() };
  });

  pi.on("tool_call", (event, ctx) => {
    for (const tool of ["read", "grep", "find", "ls"] as const) {
      if (!isToolCallEventType(tool, event) || !event.input.path) continue;
      const reason = readBlocked(String(event.input.path), policy.filesystem, ctx.cwd);
      return reason ? { block: true, reason } : undefined;
    }
    for (const tool of ["write", "edit"] as const) {
      if (!isToolCallEventType(tool, event) || !event.input.path) continue;
      const reason = writeBlocked(String(event.input.path), policy.filesystem, ctx.cwd);
      return reason ? { block: true, reason } : undefined;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      mkdirSync(sandboxTmpdir(), { recursive: true });
      await SandboxManager.initialize(policy);
      status = { state: "ready" };
      ctx.ui.notify("Sandbox initialized", "info");
    } catch (error) {
      const message = `Sandbox initialization failed; bash is blocked: ${error instanceof Error ? error.message : String(error)}`;
      status = { state: "failed", error: message };
      process.stderr.write(`${message}\n`);
      ctx.ui.notify(message, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    if (status.state === "ready") await SandboxManager.reset();
  });
}
