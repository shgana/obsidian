import type { PersonalContextGraphSettings } from "./settings";
import { buildContextGraph } from "./graphBuilder";
import { createGraphFileDrafts, buildAgentContextPath } from "./markdown";
import type {
  AIProvider,
  BuiltContextGraph,
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

export function createImportPreview(
  fileName: string,
  conversations: ParsedConversation[],
  settings: PersonalContextGraphSettings
): ImportPreview {
  const selectedConversations = selectConversations(conversations, settings);
  const transcriptText = selectedConversations.map(conversationToTranscript).join("\n\n");
  const estimatedTokens = estimateTokensFromText(transcriptText);

  return {
    fileName,
    totalConversations: conversations.length,
    selectedConversations: selectedConversations.length,
    totalTurns: selectedConversations.reduce(
      (sum, conversation) => sum + conversation.turns.length,
      0
    ),
    estimatedTokens,
    estimatedCostUsd: estimateCostUsd(estimatedTokens, settings)
  };
}

export async function runImport(
  conversations: ParsedConversation[],
  settings: PersonalContextGraphSettings,
  provider: AIProvider,
  onProgress?: (progress: ImportProgress) => void
): Promise<ImportArtifacts> {
  const startedAt = nowIso();
  const selectedConversations = selectConversations(conversations, settings);
  const preview = createImportPreview("selected conversations", conversations, settings);

  if (settings.costCapUsd > 0 && preview.estimatedCostUsd > settings.costCapUsd) {
    throw new Error(
      `Estimated extraction cost $${preview.estimatedCostUsd.toFixed(
        2
      )} exceeds the configured cap of $${settings.costCapUsd.toFixed(2)}.`
    );
  }

  const inputs: ConversationExtraction[] = [];
  for (let index = 0; index < selectedConversations.length; index += 1) {
    const conversation = selectedConversations[index];
    onProgress?.({
      phase: "extracting",
      message: `Extracting context from ${conversation.title}`,
      completed: index,
      total: selectedConversations.length
    });

    const extraction = await extractConversation(conversation, settings, provider);
    inputs.push({ conversation, extraction });
  }

  onProgress?.({
    phase: "building-graph",
    message: "Building canonical context graph",
    completed: selectedConversations.length,
    total: selectedConversations.length
  });
  const graph = await buildContextGraph(inputs, settings, provider);

  onProgress?.({
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
    agentContextPath: buildAgentContextPath(args.settings),
    startedAt: args.startedAt,
    completedAt: args.completedAt,
    estimatedTokens: args.preview.estimatedTokens,
    estimatedCostUsd: args.preview.estimatedCostUsd,
    warnings: args.graph.warnings
  };
}

function estimateCostUsd(
  estimatedTokens: number,
  settings: PersonalContextGraphSettings
): number {
  return (estimatedTokens / 1_000_000) * settings.estimatedExtractionCostPer1MInputTokensUsd;
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
