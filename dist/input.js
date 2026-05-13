import fs from "node:fs";
import path from "node:path";
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/**
 * Resolve `@path` references in user input.
 * - Text files: inlined as <file> blocks.
 * - Images (.png/.jpg/.jpeg/.gif/.webp): attached as image_url content parts.
 * - Directories: listed as a directory snippet.
 */
export function prepareUserMessage(input, config) {
    const re = /(?:^|\s)@([^\s]+)/g;
    const refs = [];
    let m;
    while ((m = re.exec(input)))
        refs.push(m[1]);
    const seen = new Set();
    const textAppends = [];
    const images = [];
    const attachments = [];
    for (const rel of refs) {
        if (seen.has(rel))
            continue;
        seen.add(rel);
        const abs = path.isAbsolute(rel) ? rel : path.join(config.workdir, rel);
        const ext = path.extname(abs).toLowerCase();
        if (IMAGE_EXTS.has(ext)) {
            try {
                const stat = fs.statSync(abs);
                if (stat.size > MAX_IMAGE_BYTES) {
                    textAppends.push(`<image path="${abs}" error="too large (${stat.size} bytes, max ${MAX_IMAGE_BYTES})"/>`);
                    continue;
                }
                const data = fs.readFileSync(abs);
                const b64 = data.toString("base64");
                images.push({
                    type: "image_url",
                    image_url: { url: `data:${MIME[ext]};base64,${b64}`, detail: "auto" },
                });
                attachments.push(`📷 ${path.basename(abs)} (${formatSize(stat.size)})`);
            }
            catch (e) {
                textAppends.push(`<image path="${abs}" error="${e?.message ?? String(e)}"/>`);
            }
            continue;
        }
        // Non-image: text file or directory.
        try {
            const stat = fs.statSync(abs);
            if (stat.isDirectory()) {
                const entries = fs.readdirSync(abs).slice(0, 80).join("\n");
                textAppends.push(`<directory path="${abs}">\n${entries}\n</directory>`);
                attachments.push(`📁 ${path.basename(abs)}/`);
                continue;
            }
            if (stat.size > 200_000) {
                textAppends.push(`<file path="${abs}" note="too large (${stat.size} bytes), use Read tool"/>`);
                continue;
            }
            const body = fs.readFileSync(abs, "utf8");
            textAppends.push(`<file path="${abs}">\n${body}\n</file>`);
            attachments.push(`📄 ${path.basename(abs)}`);
        }
        catch {
            textAppends.push(`<file path="${abs}" error="not found"/>`);
        }
    }
    const textContent = textAppends.length ? `${input}\n\n${textAppends.join("\n\n")}` : input;
    if (images.length === 0) {
        return { content: textContent, attachments };
    }
    return {
        content: [{ type: "text", text: textContent }, ...images],
        attachments,
    };
}
/** Legacy entry — preserved for callers that only need text expansion. */
export function expandAtRefs(input, config) {
    const prep = prepareUserMessage(input, config);
    return typeof prep.content === "string" ? prep.content : prep.content.find((p) => p.type === "text")?.text ?? input;
}
function formatSize(n) {
    if (n < 1024)
        return `${n}B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
//# sourceMappingURL=input.js.map