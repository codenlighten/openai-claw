import { ok, err } from "./types.js";
/**
 * WebSearch uses DuckDuckGo's HTML endpoint as a zero-key provider.
 * Configure OPENAI_CLAW_SEARCH_PROVIDER=tavily and TAVILY_API_KEY to use Tavily instead.
 */
export const webSearchTool = {
    name: "WebSearch",
    description: "Search the web for a query. Returns a list of result titles, URLs, and snippets. Useful for current events or recent docs the model wouldn't know.",
    needsPermission: true,
    mutates: false,
    parameters: {
        type: "object",
        properties: {
            query: { type: "string", description: "Search query" },
            max_results: { type: "number", description: "Max results to return (default 10)" },
        },
        required: ["query"],
    },
    async run(input) {
        const max = input.max_results ?? 10;
        const provider = process.env.OPENAI_CLAW_SEARCH_PROVIDER ?? "duckduckgo";
        try {
            if (provider === "tavily")
                return ok(await tavilySearch(input.query, max));
            return ok(await duckSearch(input.query, max));
        }
        catch (e) {
            return err(`Web search failed: ${e?.message ?? String(e)}`);
        }
    },
    preview: (input) => `WebSearch "${input.query}"`,
};
async function tavilySearch(query, max) {
    const key = process.env.TAVILY_API_KEY;
    if (!key)
        throw new Error("TAVILY_API_KEY not set");
    const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key, query, max_results: max }),
    });
    if (!res.ok)
        throw new Error(`Tavily HTTP ${res.status}`);
    const data = await res.json();
    return (data.results ?? [])
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content}`)
        .join("\n\n");
}
async function duckSearch(query, max) {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { "User-Agent": "Mozilla/5.0 openai-claw/0.1" } });
    if (!res.ok)
        throw new Error(`DDG HTTP ${res.status}`);
    const html = await res.text();
    const results = [];
    const linkRe = /<a [^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /<a [^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const links = [];
    let m;
    while ((m = linkRe.exec(html))) {
        const url = decodeURIComponent(m[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, "").replace(/&.*$/, ""));
        links.push({ title: strip(m[2]), url });
    }
    const snippets = [];
    while ((m = snippetRe.exec(html)))
        snippets.push(strip(m[1]));
    for (let i = 0; i < Math.min(links.length, max); i++) {
        results.push({ ...links[i], snippet: snippets[i] ?? "" });
    }
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
}
function strip(s) {
    return s
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .trim();
}
//# sourceMappingURL=websearch.js.map