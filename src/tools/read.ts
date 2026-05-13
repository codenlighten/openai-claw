import fs from "node:fs";
import path from "node:path";
import { type Tool, ok, err } from "./types.js";

const MAX_LINES = 2000;
const MAX_LINE_LEN = 2000;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff"]);

export const readTool: Tool<{ file_path: string; offset?: number; limit?: number }> = {
  name: "Read",
  description:
    "Read a file from the local filesystem. Use absolute paths. Returns lines prefixed with line numbers (cat -n format). Use offset/limit for large files.",
  needsPermission: false,
  mutates: false,
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file" },
      offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
      limit: { type: "number", description: "Number of lines to read (default 2000)" },
    },
    required: ["file_path"],
  },
  async run(input) {
    const fp = path.resolve(input.file_path);
    if (!fs.existsSync(fp)) return err(`File does not exist: ${fp}`);

    const stat = fs.statSync(fp);
    if (stat.isDirectory()) return err(`Path is a directory, not a file: ${fp}`);

    const ext = path.extname(fp).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      return err(
        `${fp} is an image file. Read returns raw bytes which are not useful for understanding image content. ` +
          `If the image was already attached to the user's message, just look at it. ` +
          `If not, ask the user to attach it via @${path.basename(fp)} or /img.`
      );
    }

    if (stat.size > 10 * 1024 * 1024 && !input.limit) {
      return err(`File is too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Use offset/limit.`);
    }

    const text = fs.readFileSync(fp, "utf8");
    const lines = text.split("\n");
    const start = (input.offset ?? 1) - 1;
    const limit = input.limit ?? MAX_LINES;
    const slice = lines.slice(start, start + limit);
    const rendered = slice
      .map((line, i) => {
        const num = start + i + 1;
        const truncated = line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) + " [truncated]" : line;
        return `${String(num).padStart(6, " ")}\t${truncated}`;
      })
      .join("\n");

    if (rendered.length === 0) return ok("(file is empty)");
    return ok(rendered);
  },
  preview: (input) => `Read ${input.file_path}`,
};
