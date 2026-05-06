export type OverwritePolicy = "managed-only" | "skip-existing";

export interface PersonalContextGraphSettings {
  openAiApiKey: string;
  extractionModel: string;
  embeddingModel: string;
  outputFolder: string;
  maxConversations: number;
  costCapUsd: number;
  overwritePolicy: OverwritePolicy;
  confidenceThreshold: number;
  semanticMergeThreshold: number;
  maxPromptChars: number;
  estimatedExtractionCostPer1MInputTokensUsd: number;
}

export const DEFAULT_SETTINGS: PersonalContextGraphSettings = {
  openAiApiKey: "",
  extractionModel: "gpt-5.4-mini",
  embeddingModel: "text-embedding-3-small",
  outputFolder: "Context Graph",
  maxConversations: 0,
  costCapUsd: 5,
  overwritePolicy: "managed-only",
  confidenceThreshold: 0.72,
  semanticMergeThreshold: 0.92,
  maxPromptChars: 36000,
  estimatedExtractionCostPer1MInputTokensUsd: 0.25
};
