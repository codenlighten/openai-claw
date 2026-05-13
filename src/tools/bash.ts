import { spawn } from "node:child_process";
import { type Tool, ok, err } from "./types.js";
import { spawnBackgroundShell } from "./shell.js";

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 100_000;

export const bashTool: Tool<{
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}> = {
  name: "Bash",
  description:
    "Execute a bash command. Working directory persists, shell state does not. Always quote paths with spaces. Output is truncated at 100k chars. Timeout defaults to 120s (max 600s). Set run_in_background=true to start a long-running shell and get back a shell_id; poll it with BashOutput and stop it with KillShell.",
  needsPermission: true,
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The bash command to execute" },
      description: { type: "string", description: "Brief description of what the command does" },
      timeout: { type: "number", description: "Timeout in ms (max 600000)" },
      run_in_background: { type: "boolean", description: "Run as a background shell; returns a shell_id for BashOutput/KillShell" },
    },
    required: ["command"],
  },
  async run(input, ctx) {
    if (input.run_in_background) {
      const shell = spawnBackgroundShell(ctx.config, input.command);
      return ok(
        `Started background shell ${shell.id} (pid ${shell.pid}).\nUse BashOutput(shell_id="${shell.id}") to poll, KillShell to stop.`
      );
    }
    const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const cwd = ctx.config.workdir;
    return new Promise((resolve) => {
      const child = spawn("bash", ["-c", input.command], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let killed = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 2000);
        } catch {}
      }, timeout);

      const abortHandler = () => {
        killed = true;
        try {
          child.kill("SIGTERM");
        } catch {}
      };
      ctx.abortSignal?.addEventListener("abort", abortHandler);

      child.stdout.on("data", (d) => {
        const text = d.toString();
        stdout += text;
        if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT) + "\n[stdout truncated]";
        ctx.onProgress?.(text);
      });
      child.stderr.on("data", (d) => {
        const text = d.toString();
        stderr += text;
        if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT) + "\n[stderr truncated]";
        ctx.onProgress?.(text);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.abortSignal?.removeEventListener("abort", abortHandler);
        const parts: string[] = [];
        if (stdout) parts.push(stdout);
        if (stderr) parts.push(`[stderr]\n${stderr}`);
        if (timedOut) parts.push(`[command timed out after ${timeout}ms]`);
        if (killed) parts.push(`[command aborted]`);
        parts.push(`[exit code: ${code ?? -1}]`);
        const out = parts.join("\n");
        if (code !== 0 || timedOut || killed) {
          resolve(err(out));
        } else {
          resolve(ok(out || "(no output)"));
        }
      });
    });
  },
  preview: (input) => `Bash: ${input.command.split("\n")[0].slice(0, 100)}`,
};
