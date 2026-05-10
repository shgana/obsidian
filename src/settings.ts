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
  minimumCanonicalSources: number;
  maxSourceLinksPerType: number;
  maxProjectLinksPerType: number;
  maxCoOccurrenceLinksPerType: number;
  maxSimilarityLinksPerType: number;
  similarityLinkThreshold: number;
  maxPromptChars: number;
  linkAgentContextToGraph: boolean;
  pruneStaleManagedFiles: boolean;
  synthesizeNodeSummaries: boolean;
  synthesizeNodeSummaryMinEvidence: number;
  agentContextSections: boolean;
  estimatedExtractionCostPer1MInputTokensUsd: number;
}

export const DEFAULT_SETTINGS: PersonalContextGraphSettings = {
  openAiApiKey: "",
  rememberOpenAiApiKey: false,
  extractionModel: "gpt-5.4",
  embeddingModel: "text-embedding-3-large",
  outputFolder: "Context Graph",
  maxConversations: 0,
  costCapUsd: 5,
  overwritePolicy: "managed-only",
  confidenceThreshold: 0.78,
  singleSourcePromotionThreshold: 0.94,
  semanticMergeThreshold: 0.92,
  minimumCanonicalSources: 2,
  maxSourceLinksPerType: 3,
  maxProjectLinksPerType: 3,
  maxCoOccurrenceLinksPerType: 4,
  maxSimilarityLinksPerType: 4,
  similarityLinkThreshold: 0.78,
  maxPromptChars: 36000,
  linkAgentContextToGraph: false,
  pruneStaleManagedFiles: true,
  synthesizeNodeSummaries: true,
  synthesizeNodeSummaryMinEvidence: 3,
  agentContextSections: true,
  estimatedExtractionCostPer1MInputTokensUsd: 0.25
};
