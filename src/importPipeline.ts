import type { PersonalContextGraphSettings } from "./settings";
import { buildContextGraph } from "./graphBuilder";
import { createGraphFileDrafts, buildAgentContextPath } from "./markdown";
import type {
  AIProvider,
  BuiltContextGraph,
  CanonicalNodeSeed,
  ConversationExtraction,
  ExtractedContext,
  ExtractedContextItem,
  FileDraft,
  GraphBuildReport,
  ImportCheckpoint,
  ImportPreview,
  ParsedConversation,
  WriteSummary
} from "./types";
import { CONTEXT_NODE_TYPES as NODE_TYPES } from "./types";
import { conversationToTranscript } from "./conversationText";
import { estimateTokensFromText, hashString, nowIso, uniqueBy } from "./text";

export interface ImportProgress {
  phase: "extracting" | "building-graph" | "rendering";
  message: string;
  completed: number;
  total: number;
}

export interface ImportArtifacts {
  inputs: ConversationExtraction[];
  graph: BuiltContextGraph;
  drafts: FileDraft[];
  checkpoint: ImportCheckpoint;
  report: GraphBuildReport;
}

interface CostEstimate {
  extractionInputTokens: number;
  extractionOutputTokens: number;
  embeddingTokens: number;
  extractionCostUsd: number;
  embeddingCostUsd: number;
  totalCostUsd: number;
}

interface TokenPrice {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
}

const EXTRACTION_MODEL_PRICES: Record<string, TokenPrice> = {
  "gpt-5.4-nano": { inputUsdPer1M: 0.2, outputUsdPer1M: 1.25 },
  "gpt-5.4-mini": { inputUsdPer1M: 0.75, outputUsdPer1M: 4.5 },
  "gpt-5.4": { inputUsdPer1M: 2.5, outputUsdPer1M: 15 },
  "gpt-5.5": { inputUsdPer1M: 5, outputUsdPer1M: 30 }
};

const EMBEDDING_MODEL_PRICES_USD_PER_1M: Record<string, number> = {
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13
};

const EXTRACTION_PROMPT_OVERHEAD_TOKENS_PER_CONVERSATION = 1800;
const STRUCTURED_OUTPUT_TOKEN_RATIO = 0.25;
const EMBEDDING_TOKEN_RATIO = 0.35;

export function createImportPreview(
  fileName: string,
  conversations: ParsedConversation[],
  settings: PersonalContextGraphSettings
): ImportPreview {
  const selectedConversations = selectConversations(conversations, settings);
  const transcriptText = selectedConversations.map(conversationToTranscript).join("\n\n");
  const estimatedTokens = estimateTokensFromText(transcriptText);
  const costEstimate = estimateImportCostUsd(
    estimatedTokens,
    selectedConversations.length,
    settings
  );

  return {
    fileName,
    totalConversations: conversations.length,
    selectedConversations: selectedConversations.length,
    totalTurns: selectedConversations.reduce(
      (sum, conversation) => sum + conversation.turns.length,
      0
    ),
    estimatedTokens,
    estimatedExtractionInputTokens: costEstimate.extractionInputTokens,
    estimatedExtractionOutputTokens: costEstimate.extractionOutputTokens,
    estimatedEmbeddingTokens: costEstimate.embeddingTokens,
    estimatedExtractionCostUsd: costEstimate.extractionCostUsd,
    estimatedEmbeddingCostUsd: costEstimate.embeddingCostUsd,
    estimatedCostUsd: costEstimate.totalCostUsd
  };
}

export async function runImport(
  conversations: ParsedConversation[],
  settings: PersonalContextGraphSettings,
  provider: AIProvider,
  seedsOrProgress: CanonicalNodeSeed[] | ((progress: ImportProgress) => void) = [],
  onProgress?: (progress: ImportProgress) => void
): Promise<ImportArtifacts> {
  const seeds = Array.isArray(seedsOrProgress) ? seedsOrProgress : [];
  const progress = typeof seedsOrProgress === "function" ? seedsOrProgress : onProgress;
  const startedAt = nowIso();
  const selectedConversations = selectConversations(conversations, settings);
  const preview = createImportPreview("selected conversations", conversations, settings);

  if (settings.costCapUsd > 0 && preview.estimatedCostUsd > settings.costCapUsd) {
    throw new Error(
      `Estimated API cost $${preview.estimatedCostUsd.toFixed(
        2
      )} exceeds the configured cap of $${settings.costCapUsd.toFixed(2)}.`
    );
  }

  const inputs: ConversationExtraction[] = [];
  for (let index = 0; index < selectedConversations.length; index += 1) {
    const conversation = selectedConversations[index];
    progress?.({
      phase: "extracting",
      message: `Extracting context from ${conversation.title}`,
      completed: index,
      total: selectedConversations.length
    });

    const extraction = await extractConversation(conversation, settings, provider);
    inputs.push({ conversation, extraction });
  }

  progress?.({
    phase: "building-graph",
    message: "Building canonical context graph",
    completed: selectedConversations.length,
    total: selectedConversations.length
  });
  const graph = await buildContextGraph(inputs, settings, provider, seeds);

  progress?.({
    phase: "rendering",
    message: "Rendering Markdown graph files",
    completed: selectedConversations.length,
    total: selectedConversations.length
  });
  const drafts = createGraphFileDrafts(inputs, graph, settings);
  const completedAt = nowIso();
  const report = createBaseReport({
    startedAt,
    completedAt,
    conversations,
    selectedConversations,
    graph,
    preview,
    settings
  });
  const checkpoint: ImportCheckpoint = {
    importId: `import_${hashString(`${startedAt}:${selectedConversations.length}`)}`,
    createdAt: completedAt,
    settingsSnapshot: sanitizeSettingsSnapshot(settings),
    sourceManifest: selectedConversations.map((conversation) => ({
      sourceId: conversation.sourceId,
      title: conversation.title,
      path: graph.sourcePathsById[conversation.sourceId],
      createTime: conversation.createTime,
      updateTime: conversation.updateTime
    })),
    report
  };

  return {
    inputs,
    graph,
    drafts,
    checkpoint,
    report
  };
}

export function rebuildDraftsFromCheckpoint(
  checkpoint: ImportCheckpoint,
  settings: PersonalContextGraphSettings
): ImportArtifacts {
  void settings;
  throw new Error(
    "This plugin version no longer stores full transcripts/extractions in plugin data. Re-import the ChatGPT ZIP to rebuild the graph."
  );
}

export function applyWriteSummary(
  report: GraphBuildReport,
  summary: WriteSummary
): GraphBuildReport {
  return {
    ...report,
    createdFiles: summary.created,
    updatedFiles: summary.updated,
    deletedFiles: summary.deleted,
    skippedFiles: summary.skipped,
    warnings: [...report.warnings, ...summary.warnings]
  };
}

function selectConversations(
  conversations: ParsedConversation[],
  settings: PersonalContextGraphSettings
): ParsedConversation[] {
  if (settings.maxConversations > 0) {
    return conversations.slice(0, settings.maxConversations);
  }

  return conversations;
}

async function extractConversation(
  conversation: ParsedConversation,
  settings: PersonalContextGraphSettings,
  provider: AIProvider
): Promise<ExtractedContext> {
  const chunks = splitConversation(conversation, settings.maxPromptChars);
  if (chunks.length === 1) {
    return provider.extractContext(conversation);
  }

  const extractions: ExtractedContext[] = [];
  for (const chunk of chunks) {
    extractions.push(await provider.extractContext(chunk));
  }

  return mergeChunkExtractions(conversation, extractions);
}

function splitConversation(
  conversation: ParsedConversation,
  maxPromptChars: number
): ParsedConversation[] {
  if (conversationToTranscript(conversation).length <= maxPromptChars) {
    return [conversation];
  }

  const chunks: ParsedConversation[] = [];
  let chunkTurns: ParsedConversation["turns"] = [];
  let chunkTextLength = 0;

  for (const turn of conversation.turns) {
    const turnLength = turn.text.length + 80;
    if (chunkTurns.length > 0 && chunkTextLength + turnLength > maxPromptChars) {
      chunks.push(buildChunkConversation(conversation, chunks.length, chunkTurns));
      chunkTurns = [];
      chunkTextLength = 0;
    }

    chunkTurns.push(turn);
    chunkTextLength += turnLength;
  }

  if (chunkTurns.length > 0) {
    chunks.push(buildChunkConversation(conversation, chunks.length, chunkTurns));
  }

  return chunks;
}

function buildChunkConversation(
  conversation: ParsedConversation,
  index: number,
  turns: ParsedConversation["turns"]
): ParsedConversation {
  return {
    ...conversation,
    sourceId: `${conversation.sourceId}#chunk-${index + 1}`,
    title: conversation.title,
    turns
  };
}

function mergeChunkExtractions(
  conversation: ParsedConversation,
  extractions: ExtractedContext[]
): ExtractedContext {
  const mergedAt = nowIso();
  return {
    sourceId: conversation.sourceId,
    conversationTitle: conversation.title,
    summary: extractions
      .map((extraction) => extraction.summary)
      .filter(Boolean)
      .join(" "),
    confidence: average(extractions.map((extraction) => extraction.confidence)),
    topics: mergeItems(extractions.flatMap((extraction) => extraction.topics)),
    entities: mergeItems(extractions.flatMap((extraction) => extraction.entities)),
    projects: mergeItems(extractions.flatMap((extraction) => extraction.projects)),
    preferences: mergeItems(extractions.flatMap((extraction) => extraction.preferences)),
    decisions: mergeItems(extractions.flatMap((extraction) => extraction.decisions)),
    tasks: mergeItems(extractions.flatMap((extraction) => extraction.tasks)),
    artifacts: mergeItems(extractions.flatMap((extraction) => extraction.artifacts)),
    stylePatterns: mergeItems(extractions.flatMap((extraction) => extraction.stylePatterns)),
    extractedAt: mergedAt
  };
}

function mergeItems(items: ExtractedContextItem[]): ExtractedContextItem[] {
  return uniqueBy(items, (item) => item.label.toLowerCase()).map((item) => {
    const matchingItems = items.filter(
      (candidate) => candidate.label.toLowerCase() === item.label.toLowerCase()
    );

    return {
      ...item,
      confidence: Math.max(...matchingItems.map((candidate) => candidate.confidence)),
      evidence: uniqueBy(
        matchingItems.flatMap((candidate) => candidate.evidence),
        (evidence) => evidence.quote
      ).slice(0, 5),
      summary: matchingItems.map((candidate) => candidate.summary).join(" ").slice(0, 800)
    };
  });
}

function createBaseReport(args: {
  startedAt: string;
  completedAt: string;
  conversations: ParsedConversation[];
  selectedConversations: ParsedConversation[];
  graph: BuiltContextGraph;
  preview: ImportPreview;
  settings: PersonalContextGraphSettings;
}): GraphBuildReport {
  return {
    importedConversationCount: args.conversations.length,
    processedConversationCount: args.selectedConversations.length,
    skippedConversationCount: args.conversations.length - args.selectedConversations.length,
    createdFiles: 0,
    updatedFiles: 0,
    deletedFiles: 0,
    skippedFiles: 0,
    nodeCountByType: Object.fromEntries(
      NODE_TYPES.map((type) => [
        type,
        args.graph.nodes.filter((node) => node.type === type).length
      ])
    ) as GraphBuildReport["nodeCountByType"],
    edgeCount: args.graph.edges.length,
    seededNodeCount: args.graph.stats.seededNodes,
    mergedCandidateCount: args.graph.stats.mergedCandidates,
    newlyPromotedNodeCount: args.graph.stats.newlyPromotedNodes,
    sourceOnlyCandidateCount: args.graph.stats.sourceOnlyCandidates,
    prunedDuplicateNodeCount: args.graph.stats.prunedDuplicateNodes,
    visibleCanonicalNodeCount: args.graph.stats.visibleCanonicalNodes,
    isolatedCanonicalNodeCount: args.graph.stats.isolatedCanonicalNodes,
    unmatchedSeedNodeCount: args.graph.stats.unmatchedSeedNodes,
    demotedCandidateCount: args.graph.stats.demotedCandidates,
    rejectedProjectCandidateCount: args.graph.stats.rejectedProjectCandidates,
    projectEvidenceCandidateCount: args.graph.stats.projectEvidenceCandidates,
    filteredSeedAliasCount: args.graph.stats.filteredSeedAliases,
    sourceAnchorFallbackCount: args.graph.stats.sourceAnchorFallbacks,
    underlinkedSourceCount: args.graph.stats.underlinkedSources,
    anchorCandidateRejectedCount: args.graph.stats.anchorCandidatesRejected,
    agentContextPath: buildAgentContextPath(args.settings),
    startedAt: args.startedAt,
    completedAt: args.completedAt,
    estimatedTokens: args.preview.estimatedTokens,
    estimatedExtractionInputTokens: args.preview.estimatedExtractionInputTokens,
    estimatedExtractionOutputTokens: args.preview.estimatedExtractionOutputTokens,
    estimatedEmbeddingTokens: args.preview.estimatedEmbeddingTokens,
    estimatedExtractionCostUsd: args.preview.estimatedExtractionCostUsd,
    estimatedEmbeddingCostUsd: args.preview.estimatedEmbeddingCostUsd,
    estimatedCostUsd: args.preview.estimatedCostUsd,
    warnings: args.graph.warnings
  };
}

function estimateImportCostUsd(
  estimatedTokens: number,
  selectedConversationCount: number,
  settings: PersonalContextGraphSettings
): CostEstimate {
  const extractionInputTokens =
    estimatedTokens +
    selectedConversationCount * EXTRACTION_PROMPT_OVERHEAD_TOKENS_PER_CONVERSATION;
  const extractionOutputTokens = Math.ceil(estimatedTokens * STRUCTURED_OUTPUT_TOKEN_RATIO);
  const embeddingTokens = Math.ceil(estimatedTokens * EMBEDDING_TOKEN_RATIO);
  const extractionPrice = extractionModelPrice(settings);
  const embeddingPrice = embeddingModelPrice(settings.embeddingModel);
  const extractionCostUsd =
    (extractionInputTokens / 1_000_000) * extractionPrice.inputUsdPer1M +
    (extractionOutputTokens / 1_000_000) * extractionPrice.outputUsdPer1M;
  const embeddingCostUsd = (embeddingTokens / 1_000_000) * embeddingPrice;

  return {
    extractionInputTokens,
    extractionOutputTokens,
    embeddingTokens,
    extractionCostUsd,
    embeddingCostUsd,
    totalCostUsd: extractionCostUsd + embeddingCostUsd
  };
}

function extractionModelPrice(settings: PersonalContextGraphSettings): TokenPrice {
  const model = settings.extractionModel.trim();
  const knownPrice = EXTRACTION_MODEL_PRICES[model];
  if (knownPrice) {
    return knownPrice;
  }

  return {
    inputUsdPer1M: settings.estimatedExtractionCostPer1MInputTokensUsd,
    outputUsdPer1M: settings.estimatedExtractionCostPer1MInputTokensUsd * 6
  };
}

function embeddingModelPrice(model: string): number {
  return EMBEDDING_MODEL_PRICES_USD_PER_1M[model.trim()] || EMBEDDING_MODEL_PRICES_USD_PER_1M["text-embedding-3-large"];
}

function sanitizeSettingsSnapshot(
  settings: PersonalContextGraphSettings
): Record<string, unknown> {
  return {
    ...settings,
    openAiApiKey: settings.openAiApiKey ? "[redacted]" : ""
  };
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
