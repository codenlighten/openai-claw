import fs from "node:fs";
import path from "node:path";
export const MODEL_PRICES = {
    "gpt-5": { inputUSDPerMtok: 1.25, outputUSDPerMtok: 10.0, cachedUSDPerMtok: 0.125 },
    "gpt-5-mini": { inputUSDPerMtok: 0.25, outputUSDPerMtok: 2.0, cachedUSDPerMtok: 0.025 },
    "gpt-5-nano": { inputUSDPerMtok: 0.05, outputUSDPerMtok: 0.4, cachedUSDPerMtok: 0.005 },
    "gpt-4o": { inputUSDPerMtok: 2.5, outputUSDPerMtok: 10.0 },
    "gpt-4o-mini": { inputUSDPerMtok: 0.15, outputUSDPerMtok: 0.6 },
    "o4-mini": { inputUSDPerMtok: 1.1, outputUSDPerMtok: 4.4 },
};
/**
 * Exact id first, then the LONGEST matching family prefix. Longest wins because
 * dated ids are supersets of their family: "gpt-5-nano-2025-08-07" starts with
 * both "gpt-5" and "gpt-5-nano", and picking the shorter one prices nano at
 * flagship rates (25x too high).
 */
export function priceFor(model) {
    if (MODEL_PRICES[model])
        return MODEL_PRICES[model];
    const keys = Object.keys(MODEL_PRICES)
        .filter((key) => model.startsWith(key + "-") || model.startsWith(key))
        .sort((a, b) => b.length - a.length);
    return keys.length > 0 ? MODEL_PRICES[keys[0]] : undefined;
}
/**
 * `prompt_tokens` from the API is inclusive of `cached_tokens`, so the uncached
 * remainder is billed at the input rate and the cached portion at the model's
 * cached rate (defaulting to half input when the table doesn't say).
 */
export function computeCostUSD(model, promptTokens, completionTokens, cachedTokens = 0) {
    const p = priceFor(model);
    if (!p)
        return 0;
    const uncached = Math.max(0, promptTokens - cachedTokens);
    const cachedRate = p.cachedUSDPerMtok ?? p.inputUSDPerMtok * 0.5;
    return ((uncached / 1_000_000) * p.inputUSDPerMtok +
        (cachedTokens / 1_000_000) * cachedRate +
        (completionTokens / 1_000_000) * p.outputUSDPerMtok);
}
function costLogFile(config) {
    return path.join(config.projectDir, "cost.log");
}
let costLogWarned = false;
export function appendCostLog(config, entry) {
    try {
        const full = { ts: new Date().toISOString(), ...entry };
        fs.appendFileSync(costLogFile(config), JSON.stringify(full) + "\n");
    }
    catch (e) {
        // logging is never allowed to crash the agent, but a one-shot warning
        // makes silent breakage of /cost diagnosable.
        if (!costLogWarned) {
            costLogWarned = true;
            console.error(`[claw] cost log write failed (further errors silenced): ${e?.message ?? e}`);
        }
    }
}
/** Test-only: reset the once-per-process warning latch. */
export function _resetCostLogWarned() {
    costLogWarned = false;
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