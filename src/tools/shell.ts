import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { type Tool, ok, err } from "./types.js";
import type { ClawConfig } from "../config.js";

interface BackgroundShell {
  id: string;
  pid: number;
  command: string;
  startedAt: number;
  logFile: string;
  child: ChildProcess;
  status: "running" | "exited" | "killed";
  exitCode: number | null;
  /** Byte offset already returned to the agent. BashOutput resumes from here. */
  cursor: number;
}

const shells = new Map<string, BackgroundShell>();

function shellsDir(config: ClawConfig): string {
  const dir = path.join(config.projectDir, "shells");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function nextShellId(): string {
  return `sh_${Date.now().toString(36)}_${Math.floor(Math.random() * 0xfff).toString(16)}`;
}

/** Spawn a background shell. Caller is responsible for messaging the agent. */
export function spawnBackgroundShell(config: ClawConfig, command: string): BackgroundShell {
  const dir = shellsDir(config);
  const id = nextShellId();
  const logFile = path.join(dir, `${id}.log`);
  const out = fs.openSync(logFile, "w");

  const child = spawn("bash", ["-c", command], {
    cwd: config.workdir,
    env: process.env,
    stdio: ["ignore", out, out],
    detached: true,
  });
  child.unref();

  const shell: BackgroundShell = {
    id,
    pid: child.pid ?? -1,
    command,
    startedAt: Date.now(),
    logFile,
    child,
    status: "running",
    exitCode: null,
    cursor: 0,
  };
  child.on("exit", (code, signal) => {
    shell.status = signal === "SIGKILL" || signal === "SIGTERM" ? "killed" : "exited";
    shell.exitCode = code;
    try { fs.closeSync(out); } catch {}
  });
  shells.set(id, shell);
  return shell;
}

function readLogTail(shell: BackgroundShell, fromCursor: boolean): { chunk: string; newCursor: number } {
  if (!fs.existsSync(shell.logFile)) return { chunk: "", newCursor: shell.cursor };
  const stat = fs.statSync(shell.logFile);
  const start = fromCursor ? shell.cursor : 0;
  if (start >= stat.size) return { chunk: "", newCursor: stat.size };
  const fd = fs.openSync(shell.logFile, "r");
  const len = stat.size - start;
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, start);
  fs.closeSync(fd);
  return { chunk: buf.toString("utf8"), newCursor: stat.size };
}

export const bashOutputTool: Tool<{ shell_id: string; from_start?: boolean }> = {
  name: "BashOutput",
  description:
    "Retrieve new output from a background Bash shell since the last poll. Returns the shell's status (running/exited/killed) and the new stdout+stderr bytes. Use this to monitor long-running jobs you launched with Bash(run_in_background: true).",
  needsPermission: false,
  mutates: false,
  parameters: {
    type: "object",
    properties: {
      shell_id: { type: "string", description: "Shell id returned by Bash(run_in_background: true)" },
      from_start: { type: "boolean", description: "Re-read all output from the beginning (default false: resume from cursor)" },
    },
    required: ["shell_id"],
  },
  async run(input) {
    const shell = shells.get(input.shell_id);
    if (!shell) return err(`Unknown shell_id: ${input.shell_id}`);
    const { chunk, newCursor } = readLogTail(shell, !input.from_start);
    if (!input.from_start) shell.cursor = newCursor;
    const header = `[shell ${shell.id} status=${shell.status}${shell.exitCode !== null ? ` exit=${shell.exitCode}` : ""}]`;
    return ok(`${header}\n${chunk || "(no new output)"}`);
  },
  preview: (input) => `BashOutput ${input.shell_id}`,
};

export const killShellTool: Tool<{ shell_id: string }> = {
  name: "KillShell",
  description: "Terminate a background Bash shell by id. Sends SIGTERM, then SIGKILL after 2s.",
  needsPermission: true,
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      shell_id: { type: "string", description: "Shell id to kill" },
    },
    required: ["shell_id"],
  },
  async run(input) {
    const shell = shells.get(input.shell_id);
    if (!shell) return err(`Unknown shell_id: ${input.shell_id}`);
    if (shell.status !== "running") return ok(`Shell ${shell.id} already ${shell.status}.`);
    try {
      shell.child.kill("SIGTERM");
      setTimeout(() => {
        if (shell.status === "running") shell.child.kill("SIGKILL");
      }, 2000);
      return ok(`Sent SIGTERM to shell ${shell.id}.`);
    } catch (e: any) {
      return err(`KillShell failed: ${e?.message ?? String(e)}`);
    }
  },
  preview: (input) => `KillShell ${input.shell_id}`,
};

/** For /agents-style introspection. */
export function listShells(): Array<{ id: string; pid: number; command: string; status: string; exitCode: number | null }> {
  return Array.from(shells.values()).map((s) => ({
    id: s.id,
    pid: s.pid,
    command: s.command,
    status: s.status,
    exitCode: s.exitCode,
  }));
}
