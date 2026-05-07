export type OverwritePolicy = "managed-only" | "skip-existing";

export interface PersonalContextGraphSettings {
  openAiApiKey: string;
  rememberOpenAiApiKey: boolean;
  extractionModel: string;
  embeddingModel: string;
  outputFolder: string;
  maxConversations: number;
  costCapUsd: number;
  overwritePolicy: OverwritePolicy;
  confidenceThreshold: number;
  singleSourcePromotionThreshold: number;
  semanticMergeThreshold: number;
  maxPromptChars: number;
  linkAgentContextToGraph: boolean;
  pruneStaleManagedFiles: boolean;
  estimatedExtractionCostPer1MInputTokensUsd: number;
}

export const DEFAULT_SETTINGS: PersonalContextGraphSettings = {
  openAiApiKey: "",
  rememberOpenAiApiKey: false,
  extractionModel: "gpt-5.4-mini",
  embeddingModel: "text-embedding-3-small",
  outputFolder: "Context Graph",
  maxConversations: 0,
  costCapUsd: 5,
  overwritePolicy: "managed-only",
  confidenceThreshold: 0.78,
  singleSourcePromotionThreshold: 0.88,
  semanticMergeThreshold: 0.92,
  maxPromptChars: 36000,
  linkAgentContextToGraph: false,
  pruneStaleManagedFiles: true,
  estimatedExtractionCostPer1MInputTokensUsd: 0.25
};
