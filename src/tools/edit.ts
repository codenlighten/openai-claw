import fs from "node:fs";
import path from "node:path";
import { createPatch } from "diff";
import { type Tool, ok, err } from "./types.js";

export const editTool: Tool<{
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}> = {
  name: "Edit",
  description:
    "Perform an exact string replacement in a file. old_string must be unique unless replace_all is true. Preserve exact indentation. For renames or sweeping changes, use replace_all.",
  needsPermission: true,
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to modify" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text (must differ from old_string)" },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences instead of requiring uniqueness (default false)",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  async run(input) {
    const fp = path.resolve(input.file_path);
    if (!fs.existsSync(fp)) return err(`File does not exist: ${fp}`);
    if (input.old_string === input.new_string) return err("new_string must differ from old_string");

    const text = fs.readFileSync(fp, "utf8");
    let updated: string;
    let summary: string;
    if (input.replace_all) {
      const count = text.split(input.old_string).length - 1;
      if (count === 0) return err(`old_string not found in ${fp}`);
      updated = text.split(input.old_string).join(input.new_string);
      summary = `Replaced ${count} occurrence(s) in ${fp}`;
    } else {
      const first = text.indexOf(input.old_string);
      if (first === -1) return err(`old_string not found in ${fp}`);
      const last = text.lastIndexOf(input.old_string);
      if (first !== last) {
        return err(
          `old_string is not unique in ${fp} (found multiple matches). Provide more context or set replace_all=true.`
        );
      }
      updated = text.slice(0, first) + input.new_string + text.slice(first + input.old_string.length);
      summary = `Edited ${fp}`;
    }
    fs.writeFileSync(fp, updated, "utf8");
    const patch = createPatch(path.relative(process.cwd(), fp), text, updated, "", "");
    return { content: summary, display: patch };
  },
  preview: (input) => `Edit ${input.file_path}`,
};
