import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
export function listMemories(config) {
    const dir = config.memoryDir;
    if (!fs.existsSync(dir))
        return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    const entries = [];
    for (const f of files) {
        const full = path.join(dir, f);
        try {
            const parsed = matter(fs.readFileSync(full, "utf8"));
            const fm = parsed.data ?? {};
            entries.push({
                name: fm.name ?? f.replace(/\.md$/, ""),
                description: fm.description ?? "",
                type: (fm.metadata?.type ?? fm.type ?? "project"),
                body: parsed.content.trim(),
                file: full,
            });
        }
        catch {
            // skip malformed
        }
    }
    return entries;
}
export function writeMemory(config, entry) {
    const file = path.join(config.memoryDir, `${entry.name}.md`);
    const frontmatter = matter.stringify(entry.body, {
        name: entry.name,
        description: entry.description,
        metadata: { type: entry.type },
    });
    fs.writeFileSync(file, frontmatter);
    updateIndex(config);
    return file;
}
export function deleteMemory(config, name) {
    const file = path.join(config.memoryDir, `${name}.md`);
    if (!fs.existsSync(file))
        return false;
    fs.unlinkSync(file);
    updateIndex(config);
    return true;
}
function updateIndex(config) {
    const entries = listMemories(config);
    const lines = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => `- [${e.name}](${path.basename(e.file)}) — ${e.description}`);
    const idx = path.join(config.memoryDir, "MEMORY.md");
    fs.writeFileSync(idx, lines.join("\n") + "\n");
}
//# sourceMappingURL=index.js.map