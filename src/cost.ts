import type { PersonalContextGraphSettings } from "./settings";
import type { ApiUsageEvent, ApiUsagePhase, ApiUsagePhaseSummary } from "./types";

export interface TokenPrice {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
}

export const EXTRACTION_MODEL_PRICES: Record<string, TokenPrice> = {
  "gpt-5.4-nano": { inputUsdPer1M: 0.2, outputUsdPer1M: 1.25 },
  "gpt-5.4-mini": { inputUsdPer1M: 0.75, outputUsdPer1M: 4.5 },
  "gpt-5.4": { inputUsdPer1M: 2.5, outputUsdPer1M: 15 },
  "gpt-5.5": { inputUsdPer1M: 5, outputUsdPer1M: 30 }
};

export const EMBEDDING_MODEL_PRICES_USD_PER_1M: Record<string, number> = {
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13
};

export interface ApiUsageTotals {
  actualInputTokens: number;
  actualOutputTokens: number;
  actualEmbeddingTokens: number;
  actualTotalTokens: number;
  actualCostUsd: number;
  cacheHitCount: number;
  cacheMissCount: number;
  apiUsageByPhase: Partial<Record<ApiUsagePhase, ApiUsagePhaseSummary>>;
}

export function summarizeApiUsage(
  events: ApiUsageEvent[],
  settings: PersonalContextGraphSettings
): ApiUsageTotals {
  const byPhase: Partial<Record<ApiUsagePhase, ApiUsagePhaseSummary>> = {};

  for (const event of events) {
    const summary = byPhase[event.phase] || createEmptyPhaseSummary();
    const inputTokens = event.inputTokens || 0;
    const outputTokens = event.outputTokens || 0;
    const embeddingTokens = event.embeddingTokens || 0;
    const totalTokens = event.totalTokens || inputTokens + outputTokens + embeddingTokens;
    const estimatedCostUsd =
      event.estimatedCostUsd ?? estimateApiUsageEventCostUsd(event, settings);

    summary.calls += event.cached ? 0 : 1;
    summary.cacheHits += event.cached ? 1 : 0;
    summary.cacheMisses += event.cached ? 0 : 1;
    summary.inputTokens += inputTokens;
    summary.outputTokens += outputTokens;
    summary.embeddingTokens += embeddingTokens;
    summary.totalTokens += totalTokens;
    summary.estimatedCostUsd += estimatedCostUsd;
    byPhase[event.phase] = summary;
  }

  const phaseValues = Object.values(byPhase);
  return {
    actualInputTokens: phaseValues.reduce((sum, phase) => sum + phase.inputTokens, 0),
    actualOutputTokens: phaseValues.reduce((sum, phase) => sum + phase.outputTokens, 0),
    actualEmbeddingTokens: phaseValues.reduce((sum, phase) => sum + phase.embeddingTokens, 0),
    actualTotalTokens: phaseValues.reduce((sum, phase) => sum + phase.totalTokens, 0),
    actualCostUsd: phaseValues.reduce((sum, phase) => sum + phase.estimatedCostUsd, 0),
    cacheHitCount: phaseValues.reduce((sum, phase) => sum + phase.cacheHits, 0),
    cacheMissCount: phaseValues.reduce((sum, phase) => sum + phase.cacheMisses, 0),
    apiUsageByPhase: byPhase
  };
}

export function estimateApiUsageEventCostUsd(
  event: ApiUsageEvent,
  settings: PersonalContextGraphSettings
): number {
  if (event.phase === "embedding") {
    const price = embeddingModelPrice(event.model);
    return ((event.embeddingTokens || event.totalTokens || 0) / 1_000_000) * price;
  }

  const price = extractionModelPrice(event.model, settings);
  return (
    ((event.inputTokens || 0) / 1_000_000) * price.inputUsdPer1M +
    ((event.outputTokens || 0) / 1_000_000) * price.outputUsdPer1M
  );
}

export function extractionModelPrice(
  model: string,
  settings: PersonalContextGraphSettings
): TokenPrice {
  const knownPrice = EXTRACTION_MODEL_PRICES[model.trim()];
  if (knownPrice) {
    return knownPrice;
  }

  return {
    inputUsdPer1M: settings.estimatedExtractionCostPer1MInputTokensUsd,
    outputUsdPer1M: settings.estimatedExtractionCostPer1MInputTokensUsd * 6
  };
}

export function embeddingModelPrice(model: string): number {
  return EMBEDDING_MODEL_PRICES_USD_PER_1M[model.trim()] || 0.13;
}

function createEmptyPhaseSummary(): ApiUsagePhaseSummary {
  return {
    calls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    inputTokens: 0,
    outputTokens: 0,
    embeddingTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0
  };
}
