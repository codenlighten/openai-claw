import fs from "node:fs";
import path from "node:path";
import { createPatch } from "diff";
import { err } from "./types.js";
export const writeTool = {
    name: "Write",
    description: "Write contents to a file. Creates the file if missing, overwrites if it exists. Use absolute paths. For modifying existing files, prefer the Edit tool instead — it only sends the diff.",
    needsPermission: true,
    mutates: true,
    parameters: {
        type: "object",
        properties: {
            file_path: { type: "string", description: "Absolute path to the file" },
            content: { type: "string", description: "Full contents to write" },
        },
        required: ["file_path", "content"],
    },
    async run(input) {
        const fp = path.resolve(input.file_path);
        const dir = path.dirname(fp);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        try {
            const existed = fs.existsSync(fp);
            const before = existed ? fs.readFileSync(fp, "utf8") : "";
            // Match Edit's line-ending handling. Rewriting a CRLF file with LF
            // content silently reformats every line in it, so which of the two tools
            // the model happened to pick decided whether the file survived intact.
            const keepCRLF = existed && before.includes("\r\n") && !input.content.includes("\r\n");
            const content = keepCRLF ? input.content.replace(/\n/g, "\r\n") : input.content;
            fs.writeFileSync(fp, content, "utf8");
            const summary = existed
                ? `Overwrote ${fp} (${content.length} bytes)${keepCRLF ? " [kept CRLF line endings]" : ""}`
                : `Created ${fp} (${content.length} bytes)`;
            const patch = createPatch(path.relative(process.cwd(), fp), before, content, "", "");
            return { content: summary, display: patch };
        }
        catch (e) {
            return err(`Failed to write ${fp}: ${e?.message ?? String(e)}`);
        }
    },
    preview: (input) => `Write ${input.file_path} (${input.content.length} bytes)`,
};
//# sourceMappingURL=write.js.map