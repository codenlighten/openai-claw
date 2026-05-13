import fs from "node:fs";
import path from "node:path";
import { createPatch } from "diff";
import { err } from "./types.js";
export const editTool = {
    name: "Edit",
    description: "Perform an exact string replacement in a file. old_string must be unique unless replace_all is true. Preserve exact indentation. For renames or sweeping changes, use replace_all.",
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
        if (!fs.existsSync(fp))
            return err(`File does not exist: ${fp}`);
        if (input.old_string === input.new_string)
            return err("new_string must differ from old_string");
        const original = fs.readFileSync(fp, "utf8");
        // If the file uses CRLF endings but old_string was given with LF (typical when the
        // model echoes Read output), normalize both sides for matching, then re-apply line
        // endings to the final result.
        const usesCRLF = original.includes("\r\n");
        const matchText = usesCRLF ? original.replace(/\r\n/g, "\n") : original;
        const oldStr = input.old_string.replace(/\r\n/g, "\n");
        const newStr = input.new_string.replace(/\r\n/g, "\n");
        let updated;
        let summary;
        if (input.replace_all) {
            const count = matchText.split(oldStr).length - 1;
            if (count === 0)
                return err(`old_string not found in ${fp}`);
            updated = matchText.split(oldStr).join(newStr);
            summary = `Replaced ${count} occurrence(s) in ${fp}`;
        }
        else {
            const first = matchText.indexOf(oldStr);
            if (first === -1)
                return err(`old_string not found in ${fp}`);
            const last = matchText.lastIndexOf(oldStr);
            if (first !== last) {
                return err(`old_string is not unique in ${fp} (found multiple matches). Provide more context or set replace_all=true.`);
            }
            updated = matchText.slice(0, first) + newStr + matchText.slice(first + oldStr.length);
            summary = `Edited ${fp}`;
        }
        const finalText = usesCRLF ? updated.replace(/\n/g, "\r\n") : updated;
        fs.writeFileSync(fp, finalText, "utf8");
        const patch = createPatch(path.relative(process.cwd(), fp), original, finalText, "", "");
        return { content: summary, display: patch };
    },
    preview: (input) => `Edit ${input.file_path}`,
};
//# sourceMappingURL=edit.js.map