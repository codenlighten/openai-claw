import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
const BUILTIN = [
    {
        name: "general-purpose",
        description: "General-purpose subagent with the full tool set. Use for open-ended multi-step tasks.",
        body: "",
        file: "(builtin)",
    },
    {
        name: "explore",
        description: "Read-only search subagent. Use for locating code, files, references.",
        tools: ["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch"],
        body: "",
        file: "(builtin)",
    },
];
/**
 * Discover subagent definitions. Order of precedence:
 *   1. project: <workdir>/.claw/agents/*.md (wins on name clash)
 *   2. user:    <homeDir>/agents/*.md
 *   3. builtin: general-purpose, explore
 */
export function listSubagents(config) {
    const seen = new Map();
    for (const def of BUILTIN)
        seen.set(def.name, def);
    const dirs = [
        path.join(config.homeDir, "agents"),
        path.join(config.workdir, ".claw", "agents"),
    ];
    for (const dir of dirs) {
        if (!fs.existsSync(dir))
            continue;
        for (const entry of fs.readdirSync(dir)) {
            if (!entry.endsWith(".md"))
                continue;
            const file = path.join(dir, entry);
            try {
                const parsed = matter(fs.readFileSync(file, "utf8"));
                const name = parsed.data?.name ?? entry.replace(/\.md$/, "");
                const def = {
                    name,
                    description: parsed.data?.description ?? "",
                    tools: Array.isArray(parsed.data?.tools) ? parsed.data.tools : undefined,
                    modelRole: parsed.data?.modelRole,
                    body: parsed.content.trim(),
                    file,
                };
                seen.set(name, def); // later overwrites earlier
            }
            catch { }
        }
    }
    return Array.from(seen.values());
}
export function findSubagent(config, name) {
    return listSubagents(config).find((s) => s.name === name);
}
//# sourceMappingURL=index.js.map