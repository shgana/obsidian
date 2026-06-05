export type ChatRole = "user" | "assistant" | "system" | "tool" | "unknown";

export type ContextNodeType =
  | "topic"
  | "entity"
  | "project"
  | "pattern"
  | "principle"
  | "agent_instruction"
  | "preference"
  | "decision"
  | "task"
  | "artifact"
  | "style_pattern";

export const CONTEXT_NODE_TYPES: ContextNodeType[] = [
  "topic",
  "entity",
  "project",
  "pattern",
  "principle",
  "agent_instruction",
  "preference",
  "decision",
  "task",
  "artifact",
  "style_pattern"
];

export const CONTEXT_NODE_FOLDER: Record<ContextNodeType, string> = {
  topic: "Topics",
  entity: "Entities",
  project: "Projects",
  pattern: "Patterns",
  principle: "Principles",
  agent_instruction: "Agent Instructions",
  preference: "Preferences",
  decision: "Decisions",
  task: "Tasks",
  artifact: "Artifacts",
  style_pattern: "Style Patterns"
};

export const CONTEXT_NODE_LABEL: Record<ContextNodeType, string> = {
  topic: "Topic",
  entity: "Entity",
  project: "Project",
  pattern: "Pattern",
  principle: "Principle",
  agent_instruction: "Agent Instruction",
  preference: "Preference",
  decision: "Decision",
  task: "Task",
  artifact: "Artifact",
  style_pattern: "Style Pattern"
};

export const CONTEXT_NODE_PLURAL_LABEL: Record<ContextNodeType, string> = {
  topic: "Topics",
  entity: "Entities",
  project: "Projects",
  pattern: "Patterns",
  principle: "Principles",
  agent_instruction: "Agent Instructions",
  preference: "Preferences",
  decision: "Decisions",
  task: "Tasks",
  artifact: "Artifacts",
  style_pattern: "Style Patterns"
};

export type SelfModelStability = "stable" | "recurring" | "situational" | "temporary";
export type SelfModelInferenceLevel = "explicit" | "supported_inference";
export type ReviewStatus = "pending" | "approved" | "rejected";

export interface ConversationTurn {
  id: string;
  role: ChatRole;
  authorName?: string;
  text: string;
  createTime?: string;
  updateTime?: string;
}

export interface ParsedConversation {
  source: "chatgpt";
  sourceId: string;
  title: string;
  createTime?: string;
  updateTime?: string;
  turns: ConversationTurn[];
  rawMessageCount: number;
}

export interface Evidence {
  quote: string;
  turnRole?: ChatRole;
  confidence: number;
}

export interface ExtractedContextItem {
  label: string;
  summary: string;
  confidence: number;
  evidence: Evidence[];
  stability?: SelfModelStability;
  inferenceLevel?: SelfModelInferenceLevel;
  appliesTo?: string[];
  agentInstruction?: string;
}

export interface ExtractedContext {
  sourceId: string;
  conversationTitle: string;
  summary: string;
  confidence: number;
  topics: ExtractedContextItem[];
  entities: ExtractedContextItem[];
  projects: ExtractedContextItem[];
  patterns: ExtractedContextItem[];
  principles: ExtractedContextItem[];
  agentInstructions: ExtractedContextItem[];
  preferences: ExtractedContextItem[];
  decisions: ExtractedContextItem[];
  tasks: ExtractedContextItem[];
  artifacts: ExtractedContextItem[];
  stylePatterns: ExtractedContextItem[];
  extractedAt: string;
}

export interface ConversationExtraction {
  conversation: ParsedConversation;
  extraction: ExtractedContext;
}

export interface GraphNode {
  id: string;
  type: ContextNodeType;
  label: string;
  slug: string;
  aliases: string[];
  path: string;
  summary: string;
  confidence: number;
  evidence: NodeEvidence[];
  sourceIds: string[];
  lastSeen?: string;
  embedding?: number[];
  stability?: SelfModelStability;
  inferenceLevel?: SelfModelInferenceLevel;
  appliesTo?: string[];
  agentInstruction?: string;
}

export interface NodeEvidence {
  sourceId: string;
  sourceTitle: string;
  sourcePath: string;
  quote: string;
  confidence: number;
}

export type GraphEdgeType = "evidence_for" | "related_to";

export interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  edgeType: GraphEdgeType;
  confidence: number;
  evidence: NodeEvidence[];
}

export interface BuiltContextGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  reviewQueueItems: ReviewQueueItem[];
  sourcePathsById: Record<string, string>;
  sourceLinksById: Record<string, Partial<Record<ContextNodeType, GraphNode[]>>>;
  nodeLinksById: Record<string, Partial<Record<ContextNodeType, GraphNode[]>>>;
  warnings: string[];
  stats: GraphBuildStats;
}

export interface GraphBuildStats {
  seededNodes: number;
  mergedCandidates: number;
  newlyPromotedNodes: number;
  sourceOnlyCandidates: number;
  prunedDuplicateNodes: number;
  visibleCanonicalNodes: number;
  isolatedCanonicalNodes: number;
  unmatchedSeedNodes: number;
  demotedCandidates: number;
  rejectedProjectCandidates: number;
  projectEvidenceCandidates: number;
  filteredSeedAliases: number;
  sourceAnchorFallbacks: number;
  underlinkedSources: number;
  anchorCandidatesRejected: number;
  reviewQueueItems: number;
  promotedReviewItems: number;
  suppressedReviewItems: number;
  canonicalSelfModelNodes: number;
  inferredCanonicalNodes: number;
  nounNodeCount: number;
  selfModelNodeCount: number;
  nounToSelfModelRatio: number;
}

export interface CanonicalNodeSeed {
  type: ContextNodeType;
  id: string;
  label: string;
  slug: string;
  aliases: string[];
  path: string;
  summary: string;
  confidence: number;
  evidence: NodeEvidence[];
  sourceIds: string[];
  lastSeen?: string;
  stability?: SelfModelStability;
  inferenceLevel?: SelfModelInferenceLevel;
  appliesTo?: string[];
  agentInstruction?: string;
}

export interface ReviewQueueItem {
  id: string;
  type: ContextNodeType;
  label: string;
  slug: string;
  aliases: string[];
  path: string;
  summary: string;
  confidence: number;
  evidence: NodeEvidence[];
  sourceIds: string[];
  lastSeen?: string;
  stability?: SelfModelStability;
  inferenceLevel?: SelfModelInferenceLevel;
  appliesTo?: string[];
  agentInstruction?: string;
  status: ReviewStatus;
}

export interface ReviewQueueSeed extends ReviewQueueItem {
  status: ReviewStatus;
}

export interface CanonicalContextState {
  nodeSeeds: CanonicalNodeSeed[];
  reviewSeeds: ReviewQueueSeed[];
}

export interface ImportPreview {
  fileName: string;
  totalConversations: number;
  selectedConversations: number;
  totalTurns: number;
  estimatedTokens: number;
  estimatedExtractionInputTokens: number;
  estimatedExtractionOutputTokens: number;
  estimatedEmbeddingTokens: number;
  estimatedExtractionCostUsd: number;
  estimatedEmbeddingCostUsd: number;
  estimatedCostUsd: number;
}

export type ImportRunStatus = "idle" | "running" | "succeeded" | "failed" | "cancelled";

export type ImportRunPhase =
  | "idle"
  | "parsing_zip"
  | "preview_ready"
  | "confirmed"
  | "extracting"
  | "building_graph"
  | "rendering_markdown"
  | "writing_vault"
  | "saving_checkpoint"
  | "completed"
  | "failed";

export interface ImportRunState {
  lastImportStartedAt?: string;
  lastImportUpdatedAt?: string;
  lastImportCompletedAt?: string;
  lastImportPhase?: ImportRunPhase;
  lastImportStatus?: ImportRunStatus;
  lastImportError?: string;
  lastImportErrorAt?: string;
  lastImportFileName?: string;
  lastImportSelectedConversations?: number;
  lastImportTotalConversations?: number;
  lastImportProgressMessage?: string;
  lastImportProgressCompleted?: number;
  lastImportProgressTotal?: number;
}

export interface GraphBuildReport {
  importedConversationCount: number;
  processedConversationCount: number;
  skippedConversationCount: number;
  createdFiles: number;
  updatedFiles: number;
  deletedFiles: number;
  skippedFiles: number;
  nodeCountByType: Record<ContextNodeType, number>;
  edgeCount: number;
  seededNodeCount: number;
  mergedCandidateCount: number;
  newlyPromotedNodeCount: number;
  sourceOnlyCandidateCount: number;
  prunedDuplicateNodeCount: number;
  visibleCanonicalNodeCount: number;
  isolatedCanonicalNodeCount: number;
  unmatchedSeedNodeCount: number;
  demotedCandidateCount: number;
  rejectedProjectCandidateCount: number;
  projectEvidenceCandidateCount: number;
  filteredSeedAliasCount: number;
  sourceAnchorFallbackCount: number;
  underlinkedSourceCount: number;
  anchorCandidateRejectedCount: number;
  reviewQueueItemCount: number;
  promotedReviewItemCount: number;
  suppressedReviewItemCount: number;
  canonicalSelfModelNodeCount: number;
  inferredCanonicalNodeCount: number;
  nounNodeCount: number;
  selfModelNodeCount: number;
  nounToSelfModelRatio: number;
  agentContextPath: string;
  startedAt: string;
  completedAt: string;
  estimatedTokens: number;
  estimatedExtractionInputTokens: number;
  estimatedExtractionOutputTokens: number;
  estimatedEmbeddingTokens: number;
  estimatedExtractionCostUsd: number;
  estimatedEmbeddingCostUsd: number;
  estimatedCostUsd: number;
  warnings: string[];
}

export interface ImportCheckpoint {
  importId: string;
  createdAt: string;
  settingsSnapshot: Record<string, unknown>;
  sourceManifest: SourceManifestEntry[];
  report: GraphBuildReport;
}

export interface SourceManifestEntry {
  sourceId: string;
  title: string;
  path: string;
  createTime?: string;
  updateTime?: string;
}

export interface SynthesizeSummaryArgs {
  type: ContextNodeType;
  label: string;
  evidenceQuotes: string[];
}

export interface AIProvider {
  extractContext(conversation: ParsedConversation): Promise<ExtractedContext>;
  extractSelfModel?(
    conversation: ParsedConversation,
    baseExtraction: ExtractedContext
  ): Promise<Partial<ExtractedContext>>;
  embedText(text: string): Promise<number[]>;
  synthesizeSummary(args: SynthesizeSummaryArgs): Promise<string>;
}

export interface FileDraft {
  path: string;
  content: string;
  managed: boolean;
  createOnly?: boolean;
}

export interface WriteSummary {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  warnings: string[];
}
