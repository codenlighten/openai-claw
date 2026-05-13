import fs from "node:fs";
import path from "node:path";
import { type Tool, ok, err } from "./types.js";

export const lsTool: Tool<{ path: string; ignore?: string[] }> = {
  name: "LS",
  description: "List files and directories at the given absolute path.",
  needsPermission: false,
  mutates: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to list" },
      ignore: {
        type: "array",
        items: { type: "string" },
        description: "Glob patterns to skip",
      },
    },
    required: ["path"],
  },
  async run(input) {
    const p = path.resolve(input.path);
    if (!fs.existsSync(p)) return err(`Path does not exist: ${p}`);
    const stat = fs.statSync(p);
    if (!stat.isDirectory()) return ok(p);
    const entries = fs.readdirSync(p, { withFileTypes: true });
    const ignore = input.ignore ?? [];
    const lines = entries
      .filter((e) => !ignore.some((g) => e.name.includes(g)))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return ok(lines.join("\n") || "(empty)");
  },
  preview: (input) => `LS ${input.path}`,
};
