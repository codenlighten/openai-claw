import fs from "node:fs";
import path from "node:path";
export const MODEL_PRICES = {
    "gpt-5": { inputUSDPerMtok: 1.25, outputUSDPerMtok: 10.0 },
    "gpt-5-mini": { inputUSDPerMtok: 0.25, outputUSDPerMtok: 2.0 },
    "gpt-5-nano": { inputUSDPerMtok: 0.05, outputUSDPerMtok: 0.4 },
    "gpt-4o": { inputUSDPerMtok: 2.5, outputUSDPerMtok: 10.0 },
    "gpt-4o-mini": { inputUSDPerMtok: 0.15, outputUSDPerMtok: 0.6 },
    "o4-mini": { inputUSDPerMtok: 1.1, outputUSDPerMtok: 4.4 },
};
export function priceFor(model) {
    if (MODEL_PRICES[model])
        return MODEL_PRICES[model];
    // Fallback by family prefix.
    for (const [key, price] of Object.entries(MODEL_PRICES)) {
        if (model.startsWith(key + "-") || model.startsWith(key))
            return price;
    }
    return undefined;
}
/**
 * OpenAI bills cached prompt tokens at half the input rate. If we know how many
 * of the prompt_tokens were served from cache, charge them at the discount rate
 * and the rest at full price.
 */
export function computeCostUSD(model, promptTokens, completionTokens, cachedTokens = 0) {
    const p = priceFor(model);
    if (!p)
        return 0;
    const uncached = Math.max(0, promptTokens - cachedTokens);
    return ((uncached / 1_000_000) * p.inputUSDPerMtok +
        (cachedTokens / 1_000_000) * p.inputUSDPerMtok * 0.5 +
        (completionTokens / 1_000_000) * p.outputUSDPerMtok);
}
function costLogFile(config) {
    return path.join(config.projectDir, "cost.log");
}
export function appendCostLog(config, entry) {
    try {
        const full = { ts: new Date().toISOString(), ...entry };
        fs.appendFileSync(costLogFile(config), JSON.stringify(full) + "\n");
    }
    catch {
        // logging is never allowed to crash the agent
    }
}
export function readCostLog(config) {
    try {
        const file = costLogFile(config);
        if (!fs.existsSync(file))
            return [];
        const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
        return lines
            .map((l) => {
            try {
                return JSON.parse(l);
            }
            catch {
                return null;
            }
        })
            .filter((x) => !!x);
    }
    catch {
        return [];
    }
}
/** Group cost entries by ISO date (YYYY-MM-DD). */
export function costByDay(entries) {
    const byDay = new Map();
    for (const e of entries) {
        const d = e.ts.slice(0, 10);
        const slot = byDay.get(d) ?? { costUSD: 0, tokens: 0, turns: 0 };
        slot.costUSD += e.costUSD;
        slot.tokens += e.prompt_tokens + e.completion_tokens;
        slot.turns += 1;
        byDay.set(d, slot);
    }
    return Array.from(byDay.entries())
        .map(([date, v]) => ({ date, ...v }))
        .sort((a, b) => (a.date < b.date ? 1 : -1));
}
/** Group cost entries by model id. */
export function costByModel(entries) {
    const byModel = new Map();
    for (const e of entries) {
        const slot = byModel.get(e.model) ?? { costUSD: 0, tokens: 0, turns: 0 };
        slot.costUSD += e.costUSD;
        slot.tokens += e.prompt_tokens + e.completion_tokens;
        slot.turns += 1;
        byModel.set(e.model, slot);
    }
    return Array.from(byModel.entries())
        .map(([model, v]) => ({ model, ...v }))
        .sort((a, b) => b.costUSD - a.costUSD);
}
//# sourceMappingURL=cost.js.map