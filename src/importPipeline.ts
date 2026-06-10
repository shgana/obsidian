import type { PersonalContextGraphSettings } from "./settings";
import { buildContextGraph } from "./graphBuilder";
import { createGraphFileDrafts, buildIdentityPath, buildPrimaryAgentContextPath } from "./markdown";
import { embeddingModelPrice, extractionModelPrice, summarizeApiUsage } from "./cost";
import { cacheHitCount, cacheMissCount } from "./importCache";
import type {
  AIProvider,
  AgentContextSynthesisNode,
  ApiUsageEvent,
  BuiltContextGraph,
  CanonicalContextState,
  CanonicalNodeSeed,
  ConversationExtraction,
  ExtractedContext,
  ExtractedContextItem,
  FileDraft,
  GraphBuildReport,
  ImportCheckpoint,
  ImportCacheStats,
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

const EXTRACTION_PROMPT_OVERHEAD_TOKENS_PER_CONVERSATION = 1800;
const SELF_MODEL_PROMPT_OVERHEAD_TOKENS_PER_CONVERSATION = 1000;
const SYNTHESIS_PROMPT_OVERHEAD_TOKENS_PER_IMPORT = 1800;
const SYNTHESIS_INPUT_TOKEN_RATIO = 0.12;
const SYNTHESIS_OUTPUT_TOKEN_RATIO = 0.08;
const STRUCTURED_OUTPUT_TOKEN_RATIO = 0.35;
const EMBEDDING_TOKEN_RATIO = 0.35;

export interface ImportRunOptions {
  onCacheUpdated?: () => Promise<void> | void;
  getCacheStats?: () => ImportCacheStats | undefined;
}

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
  seedsOrProgress:
    | CanonicalNodeSeed[]
    | CanonicalContextState
    | ((progress: ImportProgress) => void) = [],
  onProgress?: (progress: ImportProgress) => void,
  options: ImportRunOptions = {}
): Promise<ImportArtifacts> {
  const canonicalState = normalizeCanonicalState(seedsOrProgress);
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
    await options.onCacheUpdated?.();
  }

  progress?.({
    phase: "building-graph",
    message: "Building canonical context graph",
    completed: selectedConversations.length,
    total: selectedConversations.length
  });
  const graph = await buildContextGraph(inputs, settings, provider, canonicalState);
  await options.onCacheUpdated?.();

  progress?.({
    phase: "rendering",
    message: "Rendering Markdown graph files",
    completed: selectedConversations.length,
    total: selectedConversations.length
  });
  const agentContextProfileSummary = await synthesizeAgentContextProfile(
    inputs,
    graph,
    settings,
    provider
  );
  await options.onCacheUpdated?.();
  const drafts = createGraphFileDrafts(inputs, graph, settings, agentContextProfileSummary);
  const completedAt = nowIso();
  const report = createBaseReport({
    startedAt,
    completedAt,
    conversations,
    selectedConversations,
    graph,
    preview,
    settings,
    usageEvents: provider.getUsageEvents?.() || [],
    cacheStats: options.getCacheStats?.()
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

async function synthesizeAgentContextProfile(
  inputs: ConversationExtraction[],
  graph: BuiltContextGraph,
  settings: PersonalContextGraphSettings,
  provider: AIProvider
): Promise<string | undefined> {
  if (!settings.synthesizeAgentContextProfile || !provider.synthesizeAgentContextProfile) {
    return undefined;
  }

  try {
    const summary = await provider.synthesizeAgentContextProfile(
      buildAgentContextSynthesisArgs(inputs, graph, settings)
    );
    return summary.trim() || undefined;
  } catch (error) {
    graph.warnings.push(
      `Agent Context synthesis fell back to deterministic summary: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
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
    return extractConversationChunk(conversation, settings, provider);
  }

  const extractions: ExtractedContext[] = [];
  for (const chunk of chunks) {
    extractions.push(await extractConversationChunk(chunk, settings, provider));
  }

  return mergeChunkExtractions(conversation, extractions);
}

async function extractConversationChunk(
  conversation: ParsedConversation,
  settings: PersonalContextGraphSettings,
  provider: AIProvider
): Promise<ExtractedContext> {
  const baseExtraction = await provider.extractContext(conversation);
  if (!settings.enableSelfModelExtraction || !provider.extractSelfModel) {
    return mergeSelfModelExtraction(baseExtraction, {});
  }

  const selfModel = await provider.extractSelfModel(conversation, baseExtraction);
  return mergeSelfModelExtraction(baseExtraction, selfModel);
}

function mergeSelfModelExtraction(
  baseExtraction: ExtractedContext,
  selfModel: Partial<ExtractedContext>
): ExtractedContext {
  return {
    ...baseExtraction,
    summary: mergeText(baseExtraction.summary, selfModel.summary || ""),
    confidence: Math.max(baseExtraction.confidence, selfModel.confidence || 0),
    patterns: mergeItems([
      ...(baseExtraction.patterns || []),
      ...(selfModel.patterns || []),
      ...(baseExtraction.stylePatterns || [])
    ]),
    principles: mergeItems([
      ...(baseExtraction.principles || []),
      ...(selfModel.principles || [])
    ]),
    agentInstructions: mergeItems([
      ...(baseExtraction.agentInstructions || []),
      ...(selfModel.agentInstructions || [])
    ]),
    preferences: mergeItems([
      ...baseExtraction.preferences,
      ...(selfModel.preferences || [])
    ]),
    decisions: mergeItems([
      ...baseExtraction.decisions,
      ...(selfModel.decisions || [])
    ]),
    stylePatterns: mergeItems(selfModel.stylePatterns || [])
  };
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
    patterns: mergeItems(extractions.flatMap((extraction) => extraction.patterns)),
    principles: mergeItems(extractions.flatMap((extraction) => extraction.principles)),
    agentInstructions: mergeItems(extractions.flatMap((extraction) => extraction.agentInstructions)),
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
      summary: matchingItems.map((candidate) => candidate.summary).join(" ").slice(0, 800),
      stability: strongestStability(matchingItems),
      inferenceLevel: strongestInferenceLevel(matchingItems),
      appliesTo: uniqueBy(
        matchingItems.flatMap((candidate) => candidate.appliesTo || []),
        (value) => value.toLowerCase()
      ).slice(0, 8),
      agentInstruction: matchingItems.find((candidate) => candidate.agentInstruction)?.agentInstruction
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
  usageEvents: ApiUsageEvent[];
  cacheStats?: ImportCacheStats;
}): GraphBuildReport {
  const usageSummary = summarizeApiUsage(args.usageEvents, args.settings);
  const cacheStats = args.cacheStats;
  const hasUsageEvents = args.usageEvents.length > 0;
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
    reviewQueueItemCount: args.graph.stats.reviewQueueItems,
    promotedReviewItemCount: args.graph.stats.promotedReviewItems,
    suppressedReviewItemCount: args.graph.stats.suppressedReviewItems,
    canonicalSelfModelNodeCount: args.graph.stats.canonicalSelfModelNodes,
    inferredCanonicalNodeCount: args.graph.stats.inferredCanonicalNodes,
    nounNodeCount: args.graph.stats.nounNodeCount,
    selfModelNodeCount: args.graph.stats.selfModelNodeCount,
    nounToSelfModelRatio: args.graph.stats.nounToSelfModelRatio,
    agentContextPath: buildPrimaryAgentContextPath(args.settings),
    startedAt: args.startedAt,
    completedAt: args.completedAt,
    estimatedTokens: args.preview.estimatedTokens,
    estimatedExtractionInputTokens: args.preview.estimatedExtractionInputTokens,
    estimatedExtractionOutputTokens: args.preview.estimatedExtractionOutputTokens,
    estimatedEmbeddingTokens: args.preview.estimatedEmbeddingTokens,
    estimatedExtractionCostUsd: args.preview.estimatedExtractionCostUsd,
    estimatedEmbeddingCostUsd: args.preview.estimatedEmbeddingCostUsd,
    estimatedCostUsd: args.preview.estimatedCostUsd,
    actualInputTokens: hasUsageEvents ? usageSummary.actualInputTokens : undefined,
    actualOutputTokens: hasUsageEvents ? usageSummary.actualOutputTokens : undefined,
    actualEmbeddingTokens: hasUsageEvents ? usageSummary.actualEmbeddingTokens : undefined,
    actualTotalTokens: hasUsageEvents ? usageSummary.actualTotalTokens : undefined,
    actualCostUsd: hasUsageEvents ? usageSummary.actualCostUsd : undefined,
    cacheHitCount: cacheStats
      ? cacheHitCount(cacheStats)
      : hasUsageEvents
        ? usageSummary.cacheHitCount
        : undefined,
    cacheMissCount: cacheStats
      ? cacheMissCount(cacheStats)
      : hasUsageEvents
        ? usageSummary.cacheMissCount
        : undefined,
    cacheStats,
    apiUsageByPhase: hasUsageEvents ? usageSummary.apiUsageByPhase : undefined,
    warnings: args.graph.warnings
  };
}

function buildAgentContextSynthesisArgs(
  inputs: ConversationExtraction[],
  graph: BuiltContextGraph,
  settings: PersonalContextGraphSettings
) {
  return {
    identityPath: buildIdentityPath(settings),
    nodes: graph.nodes
      .map((node): AgentContextSynthesisNode => ({
        type: node.type,
        label: node.label,
        summary: node.summary,
        confidence: node.confidence,
        evidenceCount: node.evidence.length,
        stability: node.stability,
        inferenceLevel: node.inferenceLevel,
        appliesTo: node.appliesTo,
        agentInstruction: node.agentInstruction,
        lastSeen: node.lastSeen
      }))
      .sort(compareAgentContextNodes)
      .slice(0, 80),
    sourceSummaries: inputs
      .slice()
      .sort((left, right) =>
        (right.conversation.updateTime || right.conversation.createTime || "").localeCompare(
          left.conversation.updateTime || left.conversation.createTime || ""
        )
      )
      .slice(0, 30)
      .map((input) => ({
        sourceId: input.conversation.sourceId,
        title: input.conversation.title,
        summary: input.extraction.summary,
        lastSeen: input.conversation.updateTime || input.conversation.createTime
      })),
    warnings: graph.warnings.slice(0, 20)
  };
}

function compareAgentContextNodes(left: AgentContextSynthesisNode, right: AgentContextSynthesisNode): number {
  const selfModelDelta = selfModelNodeWeight(right.type) - selfModelNodeWeight(left.type);
  if (selfModelDelta !== 0) {
    return selfModelDelta;
  }

  const evidenceDelta = right.evidenceCount - left.evidenceCount;
  if (evidenceDelta !== 0) {
    return evidenceDelta;
  }

  const confidenceDelta = right.confidence - left.confidence;
  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }

  return (right.lastSeen || "").localeCompare(left.lastSeen || "");
}

function selfModelNodeWeight(type: AgentContextSynthesisNode["type"]): number {
  if (type === "agent_instruction") {
    return 50;
  }
  if (type === "pattern" || type === "principle" || type === "preference") {
    return 40;
  }
  if (type === "decision") {
    return 30;
  }
  if (type === "project" || type === "task") {
    return 20;
  }
  return 0;
}

function estimateImportCostUsd(
  estimatedTokens: number,
  selectedConversationCount: number,
  settings: PersonalContextGraphSettings
): CostEstimate {
  const extractionPasses = settings.enableSelfModelExtraction ? 2 : 1;
  const synthesisInputTokens =
    SYNTHESIS_PROMPT_OVERHEAD_TOKENS_PER_IMPORT +
    Math.ceil(estimatedTokens * SYNTHESIS_INPUT_TOKEN_RATIO);
  const synthesisOutputTokens = Math.ceil(estimatedTokens * SYNTHESIS_OUTPUT_TOKEN_RATIO);
  const extractionInputTokens =
    estimatedTokens * extractionPasses +
    selectedConversationCount *
      (EXTRACTION_PROMPT_OVERHEAD_TOKENS_PER_CONVERSATION +
        (settings.enableSelfModelExtraction ? SELF_MODEL_PROMPT_OVERHEAD_TOKENS_PER_CONVERSATION : 0)) +
    synthesisInputTokens;
  const extractionOutputTokens =
    Math.ceil(estimatedTokens * STRUCTURED_OUTPUT_TOKEN_RATIO * extractionPasses) +
    synthesisOutputTokens;
  const embeddingTokens = Math.ceil(estimatedTokens * EMBEDDING_TOKEN_RATIO);
  const extractionPrice = extractionModelPrice(settings.extractionModel, settings);
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

function normalizeCanonicalState(
  value: CanonicalNodeSeed[] | CanonicalContextState | ((progress: ImportProgress) => void)
): CanonicalContextState {
  if (typeof value === "function") {
    return {
      nodeSeeds: [],
      reviewSeeds: []
    };
  }

  if (Array.isArray(value)) {
    return {
      nodeSeeds: value,
      reviewSeeds: []
    };
  }

  return {
    nodeSeeds: value.nodeSeeds || [],
    reviewSeeds: value.reviewSeeds || []
  };
}

function mergeText(left: string, right: string): string {
  if (!right || left.includes(right)) {
    return left;
  }

  if (!left) {
    return right;
  }

  return `${left} ${right}`.slice(0, 1000);
}

function strongestStability(items: ExtractedContextItem[]): ExtractedContextItem["stability"] {
  const rank: Record<NonNullable<ExtractedContextItem["stability"]>, number> = {
    stable: 4,
    recurring: 3,
    situational: 2,
    temporary: 1
  };

  return items
    .map((item) => item.stability)
    .filter((value): value is NonNullable<ExtractedContextItem["stability"]> => Boolean(value))
    .sort((left, right) => rank[right] - rank[left])[0];
}

function strongestInferenceLevel(
  items: ExtractedContextItem[]
): ExtractedContextItem["inferenceLevel"] {
  return items.some((item) => item.inferenceLevel === "explicit")
    ? "explicit"
    : items.find((item) => item.inferenceLevel)?.inferenceLevel;
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
