import { ok, err } from "./types.js";
import { semanticSearch } from "../rag/index.js";
export const semanticTool = {
    name: "Semantic",
    description: "Search the project by semantic meaning, not literal pattern. Returns the top-K most relevant code chunks ranked by embedding similarity. Use this when the user describes what they want by intent (e.g. \"where is auth checked?\") rather than by exact string. Falls back to a helpful error if the index hasn't been built — run /index first.",
    needsPermission: false,
    mutates: false,
    parameters: {
        type: "object",
        properties: {
            query: { type: "string", description: "Natural-language query — describe what you're looking for" },
            k: { type: "number", description: "Top-K hits to return (default 8)" },
            snippets: {
                type: "boolean",
                description: "Include the chunk text in the output (default false: file paths + scores only)",
            },
        },
        required: ["query"],
    },
    async run(input, ctx) {
        try {
            const k = Math.max(1, Math.min(50, input.k ?? 8));
            const hits = await semanticSearch(ctx.config, input.query, k);
            if (hits.length === 0)
                return ok("(no hits)");
            const lines = hits.map((h, i) => {
                const head = `${i + 1}. ${h.file}#${h.chunkIndex} (score=${h.score.toFixed(3)})`;
                if (!input.snippets)
                    return head;
                return `${head}\n${h.text.slice(0, 800)}${h.text.length > 800 ? "\n…" : ""}`;
            });
            return ok(lines.join("\n\n"));
        }
        catch (e) {
            return err(e?.message ?? String(e));
        }
    },
    preview: (input) => `Semantic ${JSON.stringify(input.query).slice(0, 60)}`,
};
//# sourceMappingURL=semantic.js.map