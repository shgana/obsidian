export type ChatRole = "user" | "assistant" | "system" | "tool" | "unknown";

export type ContextNodeType =
  | "topic"
  | "entity"
  | "project"
  | "preference"
  | "decision"
  | "task"
  | "artifact"
  | "style_pattern";

export const CONTEXT_NODE_TYPES: ContextNodeType[] = [
  "topic",
  "entity",
  "project",
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
  preference: "Preferences",
  decision: "Decisions",
  task: "Tasks",
  artifact: "Artifacts",
  style_pattern: "Style Patterns"
};

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
}

export interface ExtractedContext {
  sourceId: string;
  conversationTitle: string;
  summary: string;
  confidence: number;
  topics: ExtractedContextItem[];
  entities: ExtractedContextItem[];
  projects: ExtractedContextItem[];
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

export interface AIProvider {
  extractContext(conversation: ParsedConversation): Promise<ExtractedContext>;
  embedText(text: string): Promise<number[]>;
}

export interface FileDraft {
  path: string;
  content: string;
  managed: boolean;
}

export interface WriteSummary {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  warnings: string[];
}
