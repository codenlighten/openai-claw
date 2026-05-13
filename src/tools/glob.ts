import fg from "fast-glob";
import path from "node:path";
import fs from "node:fs";
import { type Tool, ok } from "./types.js";

export const globTool: Tool<{ pattern: string; path?: string }> = {
  name: "Glob",
  description:
    "Find files matching a glob pattern (e.g. '**/*.ts', 'src/**/index.js'). Returns results sorted by modification time.",
  needsPermission: false,
  mutates: false,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern" },
      path: { type: "string", description: "Directory to search (default: cwd)" },
    },
    required: ["pattern"],
  },
  async run(input, ctx) {
    const cwd = path.resolve(input.path ?? ctx.config.workdir);
    const entries = await fg(input.pattern, {
      cwd,
      absolute: true,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.next/**"],
    });
    const sorted = entries
      .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.p);
    return ok(sorted.length === 0 ? "(no matches)" : sorted.join("\n"));
  },
  preview: (input) => `Glob ${input.pattern}`,
};
