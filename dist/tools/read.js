import fs from "node:fs";
import path from "node:path";
import { ok, err } from "./types.js";
const MAX_LINES = 2000;
const MAX_LINE_LEN = 2000;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff"]);
export const readTool = {
    name: "Read",
    description: "Read a file from the local filesystem. Use absolute paths. Text files return lines prefixed with line numbers (cat -n format); use offset/limit for large files. .pdf files extract text (use `pages` like '1-5'); .ipynb files return cell sources and outputs.",
    needsPermission: false,
    mutates: false,
    parameters: {
        type: "object",
        properties: {
            file_path: { type: "string", description: "Absolute path to the file" },
            offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
            limit: { type: "number", description: "Number of lines to read (default 2000)" },
            pages: { type: "string", description: "Page range for PDFs, e.g. '1-5' or '3'" },
        },
        required: ["file_path"],
    },
    async run(input) {
        const fp = path.resolve(input.file_path);
        if (!fs.existsSync(fp))
            return err(`File does not exist: ${fp}`);
        const stat = fs.statSync(fp);
        if (stat.isDirectory())
            return err(`Path is a directory, not a file: ${fp}`);
        const ext = path.extname(fp).toLowerCase();
        if (IMAGE_EXTS.has(ext)) {
            return err(`${fp} is an image file. Read returns raw bytes which are not useful for understanding image content. ` +
                `If the image was already attached to the user's message, just look at it. ` +
                `If not, ask the user to attach it via @${path.basename(fp)} or /img.`);
        }
        if (ext === ".pdf") {
            return readPdf(fp, input.pages);
        }
        if (ext === ".ipynb") {
            return readNotebook(fp);
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
        if (rendered.length === 0)
            return ok("(file is empty)");
        return ok(rendered);
    },
    preview: (input) => `Read ${input.file_path}`,
};
async function readPdf(fp, pages) {
    try {
        const mod = (await import("pdf-parse"));
        const pdf = mod.default ?? mod;
        const data = await pdf(fs.readFileSync(fp));
        if (!pages) {
            if (data.numpages > 10) {
                return err(`PDF has ${data.numpages} pages. Provide a 'pages' range (e.g. '1-5') to limit extraction.`);
            }
            return ok(data.text || "(empty PDF)");
        }
        // pdf-parse doesn't expose per-page text directly without a hook, so we approximate by
        // splitting on form-feed (\f) which pdf-parse inserts between pages.
        const allPages = (data.text || "").split("\f");
        const [from, to] = parsePageRange(pages, allPages.length);
        if (from < 1 || from > allPages.length) {
            return err(`pages out of range — PDF has ${allPages.length} page(s).`);
        }
        const slice = allPages.slice(from - 1, to);
        return ok(slice.map((p, i) => `--- Page ${from + i} ---\n${p}`).join("\n\n"));
    }
    catch (e) {
        return err(`PDF read failed: ${e?.message ?? String(e)}`);
    }
}
function parsePageRange(spec, total) {
    const m = spec.match(/^(\d+)(?:-(\d+))?$/);
    if (!m)
        return [1, total];
    const from = parseInt(m[1], 10);
    const to = m[2] ? parseInt(m[2], 10) : from;
    return [from, Math.min(to, total)];
}
function readNotebook(fp) {
    try {
        const nb = JSON.parse(fs.readFileSync(fp, "utf8"));
        const cells = Array.isArray(nb.cells) ? nb.cells : [];
        const out = [];
        cells.forEach((cell, i) => {
            const src = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? "");
            out.push(`[cell ${i + 1} type=${cell.cell_type}]\n${src}`);
            if (cell.cell_type === "code" && Array.isArray(cell.outputs) && cell.outputs.length) {
                const outs = cell.outputs
                    .map((o) => {
                    if (o.text)
                        return Array.isArray(o.text) ? o.text.join("") : String(o.text);
                    if (o.data?.["text/plain"]) {
                        const t = o.data["text/plain"];
                        return Array.isArray(t) ? t.join("") : String(t);
                    }
                    return "";
                })
                    .filter(Boolean)
                    .join("\n");
                if (outs)
                    out.push(`[cell ${i + 1} output]\n${outs}`);
            }
        });
        return ok(out.join("\n\n") || "(empty notebook)");
    }
    catch (e) {
        return err(`Notebook parse failed: ${e?.message ?? String(e)}`);
    }
}
//# sourceMappingURL=read.js.map