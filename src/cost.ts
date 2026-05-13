/**
 * USD per million tokens. Update as OpenAI changes pricing. The cost tracker
 * falls back to zero if the model isn't in the table; users can override via
 * settings.json (mtokInputUSD/mtokOutputUSD).
 */
export interface ModelPrice {
  inputUSDPerMtok: number;
  outputUSDPerMtok: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "gpt-5": { inputUSDPerMtok: 1.25, outputUSDPerMtok: 10.0 },
  "gpt-5-mini": { inputUSDPerMtok: 0.25, outputUSDPerMtok: 2.0 },
  "gpt-5-nano": { inputUSDPerMtok: 0.05, outputUSDPerMtok: 0.4 },
  "gpt-4o": { inputUSDPerMtok: 2.5, outputUSDPerMtok: 10.0 },
  "gpt-4o-mini": { inputUSDPerMtok: 0.15, outputUSDPerMtok: 0.6 },
  "o4-mini": { inputUSDPerMtok: 1.1, outputUSDPerMtok: 4.4 },
};

export function priceFor(model: string): ModelPrice | undefined {
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  // Fallback by family prefix.
  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    if (model.startsWith(key + "-") || model.startsWith(key)) return price;
  }
  return undefined;
}

export function computeCostUSD(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const p = priceFor(model);
  if (!p) return 0;
  return (
    (promptTokens / 1_000_000) * p.inputUSDPerMtok +
    (completionTokens / 1_000_000) * p.outputUSDPerMtok
  );
}
