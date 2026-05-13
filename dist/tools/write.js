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
            fs.writeFileSync(fp, input.content, "utf8");
            const summary = existed
                ? `Overwrote ${fp} (${input.content.length} bytes)`
                : `Created ${fp} (${input.content.length} bytes)`;
            const patch = createPatch(path.relative(process.cwd(), fp), before, input.content, "", "");
            return { content: summary, display: patch };
        }
        catch (e) {
            return err(`Failed to write ${fp}: ${e?.message ?? String(e)}`);
        }
    },
    preview: (input) => `Write ${input.file_path} (${input.content.length} bytes)`,
};
//# sourceMappingURL=write.js.map