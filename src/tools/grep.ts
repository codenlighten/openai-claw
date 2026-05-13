import { spawn } from "node:child_process";
import path from "node:path";
import { type Tool, ok, err } from "./types.js";

export const grepTool: Tool<{
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  "-i"?: boolean;
  "-n"?: boolean;
  "-A"?: number;
  "-B"?: number;
  "-C"?: number;
  head_limit?: number;
}> = {
  name: "Grep",
  description:
    "Search file contents using ripgrep-style regex. Supports glob filters, content/files-with-matches/count output, line numbers, context lines. Prefer this over `grep` via Bash.",
  needsPermission: false,
  mutates: false,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "Directory or file to search (default: cwd)" },
      glob: { type: "string", description: "Glob filter, e.g. '*.ts'" },
      type: { type: "string", description: "File type filter, e.g. 'ts', 'py'" },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "Output mode (default 'files_with_matches')",
      },
      "-i": { type: "boolean", description: "Case-insensitive" },
      "-n": { type: "boolean", description: "Show line numbers (with content mode)" },
      "-A": { type: "number", description: "Lines of context after match" },
      "-B": { type: "number", description: "Lines of context before match" },
      "-C": { type: "number", description: "Lines of context around match" },
      head_limit: { type: "number", description: "Limit output to N lines" },
    },
    required: ["pattern"],
  },
  async run(input, ctx) {
    const args: string[] = [];
    const mode = input.output_mode ?? "files_with_matches";
    if (mode === "files_with_matches") args.push("-l");
    else if (mode === "count") args.push("-c");

    if (input["-i"]) args.push("-i");
    if (mode === "content" && input["-n"]) args.push("-n");
    if (input["-A"] !== undefined) args.push("-A", String(input["-A"]));
    if (input["-B"] !== undefined) args.push("-B", String(input["-B"]));
    if (input["-C"] !== undefined) args.push("-C", String(input["-C"]));
    if (input.glob) args.push("--glob", input.glob);
    if (input.type) args.push("--type", input.type);

    args.push(input.pattern);
    args.push(path.resolve(input.path ?? ctx.config.workdir));

    return new Promise((resolve) => {
      const child = spawn("rg", args, { cwd: ctx.config.workdir, env: process.env });
      let out = "";
      let errOut = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (errOut += d.toString()));
      child.on("error", (e) => {
        resolve(err(`Failed to run ripgrep (is it installed?): ${e.message}`));
      });
      child.on("close", (code) => {
        if (code === 1) return resolve(ok("(no matches)"));
        if (code !== 0 && code !== null) {
          return resolve(err(errOut || `ripgrep exited ${code}`));
        }
        let lines = out.split("\n");
        if (input.head_limit) lines = lines.slice(0, input.head_limit);
        resolve(ok(lines.join("\n").trim() || "(no matches)"));
      });
    });
  },
  preview: (input) => `Grep ${input.pattern} in ${input.path ?? "."}`,
};
