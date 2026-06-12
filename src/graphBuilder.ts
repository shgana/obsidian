import type { PersonalContextGraphSettings } from "./settings";
import {
  CONTEXT_NODE_FOLDER,
  CONTEXT_NODE_TYPES,
  type AIProvider,
  type BuiltContextGraph,
  type CanonicalContextState,
  type CanonicalNodeSeed,
  type ContextNodeType,
  type ConversationExtraction,
  type ExtractedContextItem,
  type GraphBuildStats,
  type GraphEdge,
  type GraphNode,
  type NodeEvidence,
  type ReviewPriority,
  type ReviewQueueItem,
  type ReviewQueueSeed,
  type ReviewStatus
} from "./types";
import { cosineSimilarity, hashString, sanitizeFileName, slugify, uniqueBy } from "./text";

const ITEMS_BY_TYPE: Record<ContextNodeType, keyof ConversationExtraction["extraction"]> = {
  topic: "topics",
  entity: "entities",
  project: "projects",
  pattern: "patterns",
  principle: "principles",
  agent_instruction: "agentInstructions",
  preference: "preferences",
  decision: "decisions",
  task: "tasks",
  artifact: "artifacts",
  style_pattern: "stylePatterns"
};

const GRAPH_ITEM_LIMITS: Record<ContextNodeType, number> = {
  topic: 6,
  entity: 5,
  project: 4,
  pattern: 8,
  principle: 6,
  agent_instruction: 8,
  preference: 7,
  decision: 7,
  task: 8,
  artifact: 5,
  style_pattern: 5
};

const SOURCE_ANCHOR_TYPES: ContextNodeType[] = ["entity", "topic", "artifact"];
const SOURCE_ANCHOR_MIN_CONFIDENCE = 0.7;
const SELF_MODEL_TYPES = new Set<ContextNodeType>([
  "pattern",
  "principle",
  "agent_instruction",
  "preference",
  "decision"
]);
const NOUN_HEAVY_TYPES = new Set<ContextNodeType>(["topic", "entity", "artifact"]);
const REVIEW_QUEUE_MIN_CONFIDENCE = 0.65;

interface Candidate {
  type: ContextNodeType;
  item: ExtractedContextItem;
  input: ConversationExtraction;
  sourcePath: string;
  sourceId: string;
  embedding?: number[];
  projectClassification?: ProjectCandidateClassification;
}

interface CandidateCluster {
  type: ContextNodeType;
  candidates: Candidate[];
  label: string;
  summary: string;
  embedding?: number[];
}

interface MatchRegistry {
  nodes: GraphNode[];
  nodeIndex: Map<string, GraphNode>;
  seedNodeIds: Set<string>;
  activeNodeIds: Set<string>;
}

interface ReviewRegistry {
  approvedSeeds: CanonicalNodeSeed[];
  retainedItems: ReviewQueueItem[];
  rejectedKeys: Set<string>;
  pendingKeys: Set<string>;
}

type ProjectCandidateKind = "durable_project" | "domain_evidence" | "non_project";
type ProjectDomainKey = string;

const NON_PROJECT_DOMAINS = new Set<ProjectDomainKey>([
  "phone-plan",
  "school-assignment",
  "ai-job-research"
]);

interface ProjectCandidateClassification {
  kind: ProjectCandidateKind;
  domain?: ProjectDomainKey;
}

function normalizeCanonicalState(
  value: CanonicalNodeSeed[] | CanonicalContextState
): CanonicalContextState {
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

function buildReviewRegistry(reviewSeeds: ReviewQueueSeed[]): ReviewRegistry {
  const approvedSeeds: CanonicalNodeSeed[] = [];
  const retainedItems: ReviewQueueItem[] = [];
  const rejectedKeys = new Set<string>();
  const pendingKeys = new Set<string>();

  for (const seed of reviewSeeds) {
    const canonicalSeed = reviewSeedToCanonicalSeed(seed);
    if (seed.status === "approved") {
      approvedSeeds.push(canonicalSeed);
      continue;
    }

    const keys = reviewKeys(
      seed.type,
      seed.label,
      uniqueStrings([...seed.aliases, ...(seed.variantLabels || [])]),
      seed.summary
    );
    for (const key of keys) {
      if (seed.status === "rejected") {
        rejectedKeys.add(key);
      } else {
        pendingKeys.add(key);
      }
    }
    retainedItems.push(reviewSeedToReviewQueueItem(seed));
  }

  return {
    approvedSeeds,
    retainedItems,
    rejectedKeys,
    pendingKeys
  };
}

function reviewSeedToCanonicalSeed(seed: ReviewQueueSeed): CanonicalNodeSeed {
  return {
    type: seed.type,
    id: `${seed.type}_${seed.slug || slugify(seed.label)}`,
    label: seed.label,
    slug: seed.slug || slugify(seed.label),
    aliases: uniqueStrings([...seed.aliases, ...(seed.variantLabels || [])]),
    path: buildNodePath(seed.type, seed.label, seed.path.split("/").slice(0, -2).join("/") || "Context Graph"),
    summary: seed.summary,
    confidence: seed.confidence,
    evidence: seed.evidence,
    sourceIds: seed.sourceIds,
    lastSeen: seed.lastSeen,
    stability: seed.stability,
    inferenceLevel: seed.inferenceLevel,
    appliesTo: seed.appliesTo,
    agentInstruction: seed.agentInstruction
  };
}

function reviewSeedToReviewQueueItem(seed: ReviewQueueSeed): ReviewQueueItem {
  return {
    type: seed.type,
    id: seed.id,
    label: seed.label,
    slug: seed.slug || slugify(seed.label),
    aliases: seed.aliases,
    path: seed.path,
    summary: seed.summary,
    confidence: seed.confidence,
    evidence: seed.evidence,
    sourceIds: seed.sourceIds,
    lastSeen: seed.lastSeen,
    stability: seed.stability,
    inferenceLevel: seed.inferenceLevel,
    appliesTo: seed.appliesTo,
    agentInstruction: seed.agentInstruction,
    status: seed.status,
    reviewPriority: seed.reviewPriority,
    variantLabels: seed.variantLabels || [],
    variantCount: seed.variantCount,
    groupedSourceCount: seed.groupedSourceCount,
    groupedEvidenceCount: seed.groupedEvidenceCount
  };
}

export async function buildContextGraph(
  inputs: ConversationExtraction[],
  settings: PersonalContextGraphSettings,
  provider: AIProvider,
  seedsOrState: CanonicalNodeSeed[] | CanonicalContextState = []
): Promise<BuiltContextGraph> {
  const canonicalState = normalizeCanonicalState(seedsOrState);
  const reviewRegistry = buildReviewRegistry(canonicalState.reviewSeeds);
  const graph: BuiltContextGraph = {
    nodes: [],
    edges: [],
    reviewQueueItems: [...reviewRegistry.retainedItems],
    sourcePathsById: {},
    sourceLinksById: {},
    nodeLinksById: {},
    warnings: [],
    stats: createStats()
  };

  const registry: MatchRegistry = {
    nodes: [],
    nodeIndex: new Map<string, GraphNode>(),
    seedNodeIds: new Set<string>(),
    activeNodeIds: new Set<string>()
  };
  await seedCanonicalNodes(
    graph,
    registry,
    [...canonicalState.nodeSeeds, ...reviewRegistry.approvedSeeds],
    settings,
    provider
  );
  await activateApprovedReviewSeeds(
    graph,
    registry,
    reviewRegistry.approvedSeeds,
    settings,
    provider
  );
  graph.stats.promotedReviewItems = reviewRegistry.approvedSeeds.length;

  const unmatchedCandidates: Candidate[] = [];
  const sourceAnchorCandidatesBySource = new Map<string, Candidate[]>();
  const transactionalSourceIds = new Set<string>();
  const processCandidate = async (
    candidate: Candidate,
    options: { allowUnmatched: boolean; includeAlias: boolean; includeSummary: boolean }
  ): Promise<void> => {
    if (isRejectedReviewCandidate(candidate, reviewRegistry)) {
      graph.stats.suppressedReviewItems += 1;
      graph.stats.demotedCandidates += 1;
      return;
    }

    const existingNode = await findNodeMatch(candidate, registry, graph, settings, provider);
    if (existingNode) {
      activateNode(graph, registry, existingNode);
      mergeCandidateIntoNode(existingNode, candidate, {
        includeAlias: options.includeAlias,
        includeSummary: options.includeSummary
      });
      indexNode(existingNode, registry.nodeIndex);
      addSourceLink(graph, candidate.sourceId, candidate.type, existingNode);
      graph.stats.mergedCandidates += 1;
      return;
    }

    if (options.allowUnmatched) {
      unmatchedCandidates.push(candidate);
      return;
    }

    graph.stats.sourceOnlyCandidates += 1;
    graph.stats.demotedCandidates += 1;
  };

  for (const input of inputs) {
    const sourcePath = buildSourcePath(input.conversation.title, input.conversation.sourceId, settings);
    graph.sourcePathsById[input.conversation.sourceId] = sourcePath;
    graph.sourceLinksById[input.conversation.sourceId] = {};
    const sourceAnchors = collectSourceAnchorCandidates(input, sourcePath);
    sourceAnchorCandidatesBySource.set(input.conversation.sourceId, sourceAnchors.candidates);
    graph.stats.anchorCandidatesRejected += sourceAnchors.rejected;

    const conversationIsTransactional = isTransactionalConversation(input);
    if (conversationIsTransactional) {
      transactionalSourceIds.add(input.conversation.sourceId);
    }

    for (const type of CONTEXT_NODE_TYPES) {
      const items = (input.extraction[ITEMS_BY_TYPE[type]] || []) as ExtractedContextItem[];
      const candidates = prioritizeItems(type, items)
        .map((item) => normalizeItemForGraph(item, input))
        .filter((item) => isEligibleExtractedItem(type, item, settings))
        .map<Candidate>((item) => ({
          type: redirectCandidateType(type, item.label),
          item,
          input,
          sourcePath,
          sourceId: input.conversation.sourceId
        }));

      if (type === "project") {
        const projectCandidates = candidates.map((candidate) => ({
          ...candidate,
          projectClassification: classifyProjectCandidate(candidate)
        }));

        for (const candidate of projectCandidates.filter(
          (entry) => entry.projectClassification?.kind === "durable_project"
        )) {
          await processCandidate(candidate, {
            allowUnmatched: true,
            includeAlias: true,
            includeSummary: true
          });
        }

        for (const candidate of projectCandidates.filter(
          (entry) => entry.projectClassification?.kind === "domain_evidence"
        )) {
          graph.stats.projectEvidenceCandidates += 1;
          await processCandidate(candidate, {
            allowUnmatched: false,
            includeAlias: false,
            includeSummary: false
          });
        }

        for (const candidate of projectCandidates.filter(
          (entry) => entry.projectClassification?.kind === "non_project"
        )) {
          graph.stats.rejectedProjectCandidates += 1;
          graph.stats.sourceOnlyCandidates += 1;
          graph.stats.demotedCandidates += 1;
        }
        continue;
      }

      for (const candidate of candidates) {
        await processCandidate(candidate, {
          allowUnmatched: !conversationIsTransactional,
          includeAlias: true,
          includeSummary: true
        });
      }
    }
  }

  const clusters = await clusterUnmatchedCandidates(
    unmatchedCandidates,
    settings,
    provider,
    graph.warnings
  );

  for (const cluster of clusters) {
    if (shouldPromoteCluster(cluster, settings)) {
      const representative = chooseRepresentative(cluster.candidates);
      const node = createNode(
        cluster.type,
        representative.item,
        settings.outputFolder,
        slugify(representative.item.label)
      );

      registerNodeForMatching(registry, node, false);
      activateNode(graph, registry, node);
      graph.stats.newlyPromotedNodes += 1;
      for (const candidate of cluster.candidates) {
        mergeCandidateIntoNode(node, candidate);
        addSourceLink(graph, candidate.sourceId, candidate.type, node);
      }
      graph.stats.mergedCandidates += Math.max(0, cluster.candidates.length - 1);
      indexNode(node, registry.nodeIndex);
    } else if (isReviewableSelfModelCluster(cluster, reviewRegistry)) {
      graph.reviewQueueItems.push(createReviewQueueItem(cluster, settings.outputFolder));
      graph.stats.sourceOnlyCandidates += cluster.candidates.length;
      graph.stats.demotedCandidates += cluster.candidates.length;
    } else {
      graph.stats.sourceOnlyCandidates += cluster.candidates.length;
      graph.stats.demotedCandidates += cluster.candidates.length;
    }
  }

  await applySourceAnchorFallback(
    graph,
    registry,
    sourceAnchorCandidatesBySource,
    transactionalSourceIds,
    settings,
    provider
  );
  graph.stats.sourceOnlyCandidates += capSourceLinks(graph, settings);
  addCoOccurrenceLinks(graph, settings);
  await addSemanticSimilarityLinks(graph, settings, provider);
  graph.stats.demotedCandidates += applyGraphHygiene(graph, registry);
  rescaleNodeConfidence(graph);
  await synthesizeNodeSummaries(graph, settings, provider);
  rebuildEvidenceEdges(graph);
  finalizeGraphStats(graph, registry);
  graph.nodes.sort((left, right) => left.path.localeCompare(right.path));
  graph.edges.sort((left, right) => left.id.localeCompare(right.id));
  graph.reviewQueueItems = compactReviewQueueItems(graph.reviewQueueItems);
  graph.stats.reviewQueueItems = graph.reviewQueueItems.length;
  graph.stats.reviewQueueGroups = graph.reviewQueueItems.filter(
    (item) => item.reviewPriority !== "low"
  ).length;
  graph.stats.reviewQueueHighPriority = graph.reviewQueueItems.filter(
    (item) => item.reviewPriority === "high"
  ).length;
  graph.stats.reviewQueueMediumPriority = graph.reviewQueueItems.filter(
    (item) => item.reviewPriority === "medium"
  ).length;
  graph.stats.reviewQueueLowPriority = graph.reviewQueueItems.filter(
    (item) => item.reviewPriority === "low"
  ).length;
  graph.stats.reviewQueueMergedVariants = graph.reviewQueueItems.reduce(
    (sum, item) => sum + Math.max(0, (item.variantCount || 1) - 1),
    0
  );
  graph.stats.reviewQueueSummarizedCandidates = graph.reviewQueueItems
    .filter((item) => item.reviewPriority === "low")
    .reduce((sum, item) => sum + (item.variantCount || 1), 0);
  graph.reviewQueueItems.sort((left, right) => {
    const statusDelta = reviewStatusRank(left.status) - reviewStatusRank(right.status);
    if (statusDelta !== 0) {
      return statusDelta;
    }
    const priorityDelta = reviewPriorityRank(left.reviewPriority) - reviewPriorityRank(right.reviewPriority);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return left.label.localeCompare(right.label);
  });
  return graph;
}

function createStats(): GraphBuildStats {
  return {
    seededNodes: 0,
    mergedCandidates: 0,
    newlyPromotedNodes: 0,
    sourceOnlyCandidates: 0,
    prunedDuplicateNodes: 0,
    visibleCanonicalNodes: 0,
    isolatedCanonicalNodes: 0,
    unmatchedSeedNodes: 0,
    demotedCandidates: 0,
    rejectedProjectCandidates: 0,
    projectEvidenceCandidates: 0,
    filteredSeedAliases: 0,
    sourceAnchorFallbacks: 0,
    underlinkedSources: 0,
    anchorCandidatesRejected: 0,
    reviewQueueItems: 0,
    reviewQueueGroups: 0,
    reviewQueueHighPriority: 0,
    reviewQueueMediumPriority: 0,
    reviewQueueLowPriority: 0,
    reviewQueueMergedVariants: 0,
    reviewQueueSummarizedCandidates: 0,
    promotedReviewItems: 0,
    suppressedReviewItems: 0,
    canonicalSelfModelNodes: 0,
    inferredCanonicalNodes: 0,
    nounNodeCount: 0,
    selfModelNodeCount: 0,
    nounToSelfModelRatio: 0
  };
}

async function seedCanonicalNodes(
  graph: BuiltContextGraph,
  registry: MatchRegistry,
  seeds: CanonicalNodeSeed[],
  settings: PersonalContextGraphSettings,
  provider: AIProvider
): Promise<void> {
  const orderedSeeds = [...seeds].sort(compareSeedSurvivorPriority);
  for (const seed of orderedSeeds) {
    const seedResult = seedToNode(seed, settings.outputFolder);
    graph.stats.filteredSeedAliases += seedResult.filteredAliasCount;
    if (!seedResult.node) {
      continue;
    }

    const node = seedResult.node;
    const duplicate = await findNodeMatchForLabel(
      node.type,
      node.label,
      node.summary,
      node.aliases,
      registry,
      graph,
      settings,
      provider
    );

    if (duplicate) {
      mergeSeedIntoNode(duplicate, seed);
      indexNode(duplicate, registry.nodeIndex);
      graph.stats.prunedDuplicateNodes += 1;
      continue;
    }

    registerNodeForMatching(registry, node, true);
  }
}

async function activateApprovedReviewSeeds(
  graph: BuiltContextGraph,
  registry: MatchRegistry,
  seeds: CanonicalNodeSeed[],
  settings: PersonalContextGraphSettings,
  provider: AIProvider
): Promise<void> {
  for (const seed of seeds) {
    const node = await findNodeMatchForLabel(
      seed.type,
      seed.label,
      seed.summary,
      seed.aliases,
      registry,
      graph,
      settings,
      provider
    );
    if (!node) {
      continue;
    }

    activateNode(graph, registry, node);
    for (const evidence of node.evidence) {
      if (!graph.sourcePathsById[evidence.sourceId]) {
        graph.sourcePathsById[evidence.sourceId] = evidence.sourcePath;
      }
      graph.sourceLinksById[evidence.sourceId] = graph.sourceLinksById[evidence.sourceId] || {};
      addSourceLink(graph, evidence.sourceId, node.type, node);
    }
  }
}

function registerNodeForMatching(registry: MatchRegistry, node: GraphNode, fromSeed: boolean): void {
  if (!registry.nodes.some((candidate) => candidate.id === node.id)) {
    registry.nodes.push(node);
  }
  if (fromSeed) {
    registry.seedNodeIds.add(node.id);
  }
  indexNode(node, registry.nodeIndex);
}

function activateNode(
  graph: BuiltContextGraph,
  registry: MatchRegistry,
  node: GraphNode
): void {
  if (registry.activeNodeIds.has(node.id)) {
    return;
  }

  registry.activeNodeIds.add(node.id);
  graph.nodes.push(node);
}

function seedToNode(
  seed: CanonicalNodeSeed,
  outputFolder: string
): { node?: GraphNode; filteredAliasCount: number } {
  const type = redirectCandidateType(seed.type, seed.label);
  const normalizedSeed = normalizeSeedForType(seed, type, outputFolder);
  const aliases = type === "project"
    ? filterProjectSeedAliases(normalizedSeed)
    : uniqueStrings(normalizedSeed.aliases || []);
  if (type === "project" && !isDurableProjectSeed(normalizedSeed)) {
    return {
      filteredAliasCount: seed.aliases.length
    };
  }

  const resetProjectEvidence = type === "project";
  return {
    filteredAliasCount: Math.max(0, seed.aliases.length - aliases.length),
    node: {
      id: normalizedSeed.id,
      type,
      label: normalizedSeed.label,
      slug: normalizedSeed.slug || slugify(normalizedSeed.label),
      aliases,
      path: normalizedSeed.path,
      summary: normalizedSeed.summary,
      confidence: normalizedSeed.confidence,
      evidence: resetProjectEvidence ? [] : [...normalizedSeed.evidence],
      sourceIds: resetProjectEvidence ? [] : uniqueStrings(normalizedSeed.sourceIds || []),
      lastSeen: normalizedSeed.lastSeen,
      stability: normalizedSeed.stability,
      inferenceLevel: normalizedSeed.inferenceLevel,
      appliesTo: normalizedSeed.appliesTo,
      agentInstruction: normalizedSeed.agentInstruction
    }
  };
}

function normalizeSeedForType(
  seed: CanonicalNodeSeed,
  type: ContextNodeType,
  outputFolder: string
): CanonicalNodeSeed {
  const label = canonicalLabelForType(type, seed.label, seed.summary);
  const slug = slugify(label);
  const aliases = uniqueStrings([
    seed.label,
    ...(seed.aliases || [])
  ]).filter((alias) => slugify(alias) !== slug);

  return {
    ...seed,
    type,
    id: `${type}_${slug}`,
    label,
    slug,
    aliases,
    path: buildNodePath(type, label, outputFolder)
  };
}

function compareSeedSurvivorPriority(left: CanonicalNodeSeed, right: CanonicalNodeSeed): number {
  const evidenceDelta = right.evidence.length - left.evidence.length;
  if (evidenceDelta !== 0) {
    return evidenceDelta;
  }

  const sourceDelta = right.sourceIds.length - left.sourceIds.length;
  if (sourceDelta !== 0) {
    return sourceDelta;
  }

  const confidenceDelta = right.confidence - left.confidence;
  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }

  return labelNoiseScore(left.label) - labelNoiseScore(right.label);
}

function prioritizeItems(type: ContextNodeType, items: ExtractedContextItem[]): ExtractedContextItem[] {
  return [...items]
    .sort((left, right) => {
      const confidenceDelta = right.confidence - left.confidence;
      if (confidenceDelta !== 0) {
        return confidenceDelta;
      }

      return right.evidence.length - left.evidence.length;
    })
    .slice(0, GRAPH_ITEM_LIMITS[type]);
}

function normalizeItemForGraph(
  item: ExtractedContextItem,
  input: ConversationExtraction
): ExtractedContextItem {
  return {
    ...item,
    label: normalizeLabel(item.label, input.conversation.title)
  };
}

function isEligibleExtractedItem(
  type: ContextNodeType,
  item: ExtractedContextItem,
  settings: PersonalContextGraphSettings
): boolean {
  if (item.evidence.length === 0) {
    return false;
  }

  const redirectedType = redirectCandidateType(type, item.label);
  const threshold = SELF_MODEL_TYPES.has(redirectedType)
    ? REVIEW_QUEUE_MIN_CONFIDENCE
    : settings.confidenceThreshold;
  return item.confidence >= threshold;
}

function isRejectedReviewCandidate(
  candidate: Candidate,
  reviewRegistry: ReviewRegistry
): boolean {
  return reviewKeys(
    candidate.type,
    candidate.item.label,
    [],
    candidate.item.summary
  ).some((key) => reviewRegistry.rejectedKeys.has(key));
}

function reviewKeys(
  type: ContextNodeType,
  label: string,
  aliases: string[],
  summary = ""
): string[] {
  return matchKeys(type, label, aliases, summary).filter((key) =>
    /:(?:normalized|app-product|filename|project-domain|project-normalized):/.test(key) ||
    key === `${type}:${slugify(label)}`
  );
}

function normalizeLabel(label: string, conversationTitle: string): string {
  const cleanConversationTitle = conversationTitle.replace(/\s+\(chunk\s+\d+\)$/i, "").trim();
  const cleaned = label
    .replace(/\s+\(chunk\s+\d+\)$/gi, "")
    .replace(/\bchunk\s+\d+\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || cleanConversationTitle;
}

async function findNodeMatch(
  candidate: Candidate,
  registry: MatchRegistry,
  graph: BuiltContextGraph,
  settings: PersonalContextGraphSettings,
  provider: AIProvider
): Promise<GraphNode | undefined> {
  return findNodeMatchForLabel(
    candidate.type,
    candidate.item.label,
    candidate.item.summary,
    [],
    registry,
    graph,
    settings,
    provider,
    candidate
  );
}

async function findNodeMatchForLabel(
  type: ContextNodeType,
  label: string,
  summary: string,
  aliases: string[],
  registry: MatchRegistry,
  graph: BuiltContextGraph,
  settings: PersonalContextGraphSettings,
  provider: AIProvider,
  candidate?: Candidate
): Promise<GraphNode | undefined> {
  for (const key of matchKeys(type, label, aliases, summary)) {
    const exactNode = registry.nodeIndex.get(key);
    if (exactNode) {
      if (
        type !== "project" ||
        isProjectMatchAllowed(label, summary, exactNode.label, exactNode.summary)
      ) {
        return exactNode;
      }
    }
  }

  return findSemanticMergeCandidate({
    type,
    label,
    summary,
    matchNodes: registry.nodes,
    warnings: graph.warnings,
    settings,
    provider,
    candidate
  });
}

async function findSemanticMergeCandidate(args: {
  type: ContextNodeType;
  label: string;
  summary: string;
  matchNodes: GraphNode[];
  warnings: string[];
  settings: PersonalContextGraphSettings;
  provider: AIProvider;
  candidate?: Candidate;
}): Promise<GraphNode | undefined> {
  const candidates = args.matchNodes.filter((node) => node.type === args.type);
  if (candidates.length === 0) {
    return undefined;
  }

  let itemEmbedding: number[];
  try {
    itemEmbedding =
      args.candidate?.embedding ||
      (await args.provider.embedText(`${args.label}\n${args.summary}`));
    if (args.candidate) {
      args.candidate.embedding = itemEmbedding;
    }
  } catch (error) {
    args.warnings.push(
      `Semantic merge skipped for "${args.label}": ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }

  let bestNode: GraphNode | undefined;
  let bestSimilarity = 0;
  for (const candidate of candidates) {
    if (!candidate.embedding) {
      try {
        candidate.embedding = await args.provider.embedText(`${candidate.label}\n${candidate.summary}`);
      } catch {
        continue;
      }
    }

    const similarity = cosineSimilarity(itemEmbedding, candidate.embedding);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestNode = candidate;
    }
  }

  if (
    bestNode &&
    bestSimilarity >= args.settings.semanticMergeThreshold &&
    passesSemanticGuard(
      args.type,
      args.label,
      bestNode.label,
      bestSimilarity,
      args.settings,
      args.summary,
      bestNode.summary
    )
  ) {
    return bestNode;
  }

  return undefined;
}

async function clusterUnmatchedCandidates(
  candidates: Candidate[],
  settings: PersonalContextGraphSettings,
  provider: AIProvider,
  warnings: string[]
): Promise<CandidateCluster[]> {
  const clusters: CandidateCluster[] = [];
  for (const candidate of candidates) {
    const cluster = await findClusterMatch(candidate, clusters, settings, provider, warnings);
    if (cluster) {
      cluster.candidates.push(candidate);
      const representative = chooseRepresentative(cluster.candidates);
      cluster.label = representative.item.label;
      cluster.summary = representative.item.summary;
      continue;
    }

    clusters.push({
      type: candidate.type,
      candidates: [candidate],
      label: candidate.item.label,
      summary: candidate.item.summary,
      embedding: candidate.embedding
    });
  }

  return clusters;
}

async function findClusterMatch(
  candidate: Candidate,
  clusters: CandidateCluster[],
  settings: PersonalContextGraphSettings,
  provider: AIProvider,
  warnings: string[]
): Promise<CandidateCluster | undefined> {
  const candidateKeys = new Set(
    matchKeys(candidate.type, candidate.item.label, [], candidate.item.summary)
  );
  const exactCluster = clusters.find(
    (cluster) =>
      cluster.type === candidate.type &&
      matchKeys(cluster.type, cluster.label, [], cluster.summary).some((key) =>
        candidateKeys.has(key)
      )
  );
  if (exactCluster) {
    return exactCluster;
  }

  let candidateEmbedding: number[] | undefined = candidate.embedding;
  try {
    candidateEmbedding =
      candidateEmbedding || (await provider.embedText(`${candidate.item.label}\n${candidate.item.summary}`));
    candidate.embedding = candidateEmbedding;
  } catch (error) {
    warnings.push(
      `Semantic cluster skipped for "${candidate.item.label}": ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }

  let bestCluster: CandidateCluster | undefined;
  let bestSimilarity = 0;
  for (const cluster of clusters.filter((entry) => entry.type === candidate.type)) {
    if (!cluster.embedding) {
      try {
        cluster.embedding = await provider.embedText(`${cluster.label}\n${cluster.summary}`);
      } catch {
        continue;
      }
    }

    const similarity = cosineSimilarity(candidateEmbedding, cluster.embedding);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestCluster = cluster;
    }
  }

  if (
    bestCluster &&
    bestSimilarity >= settings.semanticMergeThreshold &&
    passesSemanticGuard(
      candidate.type,
      candidate.item.label,
      bestCluster.label,
      bestSimilarity,
      settings,
      candidate.item.summary,
      bestCluster.summary
    )
  ) {
    return bestCluster;
  }

  return undefined;
}

function shouldPromoteCluster(
  cluster: CandidateCluster,
  settings: PersonalContextGraphSettings
): boolean {
  const sourceCount = uniqueStrings(cluster.candidates.map((candidate) => candidate.sourceId)).length;
  const maxConfidence = Math.max(
    ...cluster.candidates.map((candidate) => candidate.item.confidence)
  );

  if (SELF_MODEL_TYPES.has(cluster.type)) {
    const representative = chooseRepresentative(cluster.candidates);
    const durableStability =
      representative.item.stability === "stable" ||
      representative.item.stability === "recurring";
    const explicitDurableSingletonTypes = new Set<ContextNodeType>([
      "preference",
      "principle",
      "decision"
    ]);
    if (
      sourceCount === 1 &&
      explicitDurableSingletonTypes.has(cluster.type) &&
      representative.item.inferenceLevel === "explicit" &&
      durableStability &&
      maxConfidence >= settings.singleSourcePromotionThreshold
    ) {
      return true;
    }

    if (
      sourceCount >= settings.minimumCanonicalSources &&
      durableStability &&
      maxConfidence >= settings.confidenceThreshold
    ) {
      return true;
    }

    return false;
  }

  if (sourceCount >= settings.minimumCanonicalSources) {
    return true;
  }

  if (maxConfidence < settings.singleSourcePromotionThreshold) {
    return false;
  }

  if (cluster.type === "entity" || cluster.type === "artifact") {
    return isNamedStableLabel(cluster.label);
  }

  if (cluster.type === "project") {
    return maxConfidence >= settings.singleSourcePromotionThreshold + 0.03 &&
      isDurableProjectLabel(cluster);
  }

  if (cluster.type === "topic") {
    return maxConfidence >= settings.singleSourcePromotionThreshold + 0.03 &&
      isDurableTopicLabel(cluster.label);
  }

  return false;
}

function isReviewableSelfModelCluster(
  cluster: CandidateCluster,
  reviewRegistry: ReviewRegistry
): boolean {
  if (!SELF_MODEL_TYPES.has(cluster.type)) {
    return false;
  }

  const representative = chooseRepresentative(cluster.candidates);
  if (representative.item.confidence < REVIEW_QUEUE_MIN_CONFIDENCE) {
    return false;
  }

  return !reviewKeys(
    cluster.type,
    representative.item.label,
    [],
    representative.item.summary
  ).some((key) => reviewRegistry.pendingKeys.has(key));
}

function createReviewQueueItem(
  cluster: CandidateCluster,
  outputFolder: string
): ReviewQueueItem {
  const representative = chooseRepresentative(cluster.candidates);
  const label = canonicalLabelForType(cluster.type, representative.item.label, representative.item.summary);
  const slug = slugify(label);
  const allEvidence = uniqueBy(
    cluster.candidates.flatMap((candidate) =>
      candidate.item.evidence.map<NodeEvidence>((entry) => ({
        sourceId: candidate.sourceId,
        sourceTitle: candidate.input.conversation.title,
        sourcePath: candidate.sourcePath,
        quote: entry.quote,
        confidence: Math.min(candidate.item.confidence, entry.confidence)
      }))
    ),
    (entry) => `${entry.sourceId}:${entry.quote}`
  ).sort((left, right) => right.confidence - left.confidence);
  const sourceIds = uniqueStrings(cluster.candidates.map((candidate) => candidate.sourceId));
  const variantLabels = uniqueStrings(
    cluster.candidates
      .map((candidate) => candidate.item.label)
      .filter((value) => slugify(value) !== slug)
  );

  return {
    id: `review_${cluster.type}_${slug}`,
    type: cluster.type,
    label,
    slug,
    aliases: variantLabels.slice(0, 8),
    path: buildReviewQueuePath(outputFolder),
    summary: representative.item.summary,
    confidence: representative.item.confidence,
    evidence: allEvidence.slice(0, 12),
    sourceIds,
    lastSeen:
      representative.input.conversation.updateTime ||
      representative.input.conversation.createTime ||
      representative.input.extraction.extractedAt,
    stability: representative.item.stability,
    inferenceLevel: representative.item.inferenceLevel,
    appliesTo: representative.item.appliesTo,
    agentInstruction: representative.item.agentInstruction,
    status: "pending",
    reviewPriority: reviewPriorityForItem({
      type: cluster.type,
      confidence: representative.item.confidence,
      stability: representative.item.stability,
      inferenceLevel: representative.item.inferenceLevel,
      sourceCount: sourceIds.length,
      status: "pending"
    }),
    variantLabels,
    variantCount: cluster.candidates.length,
    groupedSourceCount: sourceIds.length,
    groupedEvidenceCount: allEvidence.length
  };
}

export function buildReviewQueuePath(outputFolder: string): string {
  return joinVaultPath(outputFolder, "Review Queue.md");
}

function compactReviewQueueItems(items: ReviewQueueItem[]): ReviewQueueItem[] {
  const grouped: ReviewQueueItem[] = [];

  for (const item of items) {
    const normalized = normalizeReviewQueueItem(item);
    const existing = grouped.find((candidate) => shouldMergeReviewItems(candidate, normalized));
    if (!existing) {
      grouped.push(normalized);
      continue;
    }

    mergeReviewItemInto(existing, normalized);
  }

  return grouped.map((item) => ({
    ...item,
    reviewPriority: reviewPriorityForItem({
      type: item.type,
      confidence: item.confidence,
      stability: item.stability,
      inferenceLevel: item.inferenceLevel,
      sourceCount: item.sourceIds.length,
      status: item.status
    })
  }));
}

function normalizeReviewQueueItem(item: ReviewQueueItem): ReviewQueueItem {
  const variantLabels = uniqueStrings([
    ...(item.variantLabels || []),
    ...item.aliases
  ]).filter((label) => slugify(label) !== item.slug);

  return {
    ...item,
    reviewPriority: item.reviewPriority || reviewPriorityForItem({
      type: item.type,
      confidence: item.confidence,
      stability: item.stability,
      inferenceLevel: item.inferenceLevel,
      sourceCount: item.sourceIds.length,
      status: item.status
    }),
    variantLabels,
    variantCount: Math.max(item.variantCount || 1, variantLabels.length + 1),
    groupedSourceCount: item.groupedSourceCount || item.sourceIds.length,
    groupedEvidenceCount: item.groupedEvidenceCount || item.evidence.length
  };
}

function mergeReviewItemInto(target: ReviewQueueItem, incoming: ReviewQueueItem): void {
  const previousLabel = target.label;
  const preferred = incoming.confidence > target.confidence ? incoming : target;
  target.label = preferred.label;
  target.slug = preferred.slug;
  target.id = `review_${target.type}_${target.slug}`;
  target.summary = preferred.summary;
  target.confidence = Math.max(target.confidence, incoming.confidence);
  target.status = mergeReviewStatus(target.status, incoming.status);
  target.evidence = uniqueBy(
    [...target.evidence, ...incoming.evidence],
    (entry) => `${entry.sourceId}:${entry.quote}`
  )
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 12);
  target.sourceIds = uniqueStrings([...target.sourceIds, ...incoming.sourceIds]);
  target.lastSeen = maxStringDate(target.lastSeen, incoming.lastSeen);
  target.appliesTo = uniqueStrings([...(target.appliesTo || []), ...(incoming.appliesTo || [])]).slice(0, 8);
  if (!target.agentInstruction && incoming.agentInstruction) {
    target.agentInstruction = incoming.agentInstruction;
  }
  target.stability = strongestStabilityValue(target.stability, incoming.stability);
  target.inferenceLevel = strongestInferenceValue(target.inferenceLevel, incoming.inferenceLevel);
  target.variantLabels = uniqueStrings([
    previousLabel,
    target.label,
    incoming.label,
    ...(target.variantLabels || []),
    ...(incoming.variantLabels || []),
    ...target.aliases,
    ...incoming.aliases
  ]).filter((label) => slugify(label) !== target.slug);
  target.aliases = target.variantLabels.slice(0, 12);
  target.variantCount = Math.max(
    (target.variantCount || 1) + (incoming.variantCount || 1),
    target.variantLabels.length + 1
  );
  target.groupedSourceCount = target.sourceIds.length;
  target.groupedEvidenceCount = (target.groupedEvidenceCount || 0) + (incoming.groupedEvidenceCount || incoming.evidence.length);
}

function shouldMergeReviewItems(left: ReviewQueueItem, right: ReviewQueueItem): boolean {
  if (left.type !== right.type) {
    return false;
  }

  const leftKeys = new Set(reviewKeys(left.type, left.label, left.aliases, left.summary));
  if (reviewKeys(right.type, right.label, right.aliases, right.summary).some((key) => leftKeys.has(key))) {
    return true;
  }

  const leftTokens = reviewSignificantTokens([left.label, ...left.aliases, ...(left.variantLabels || [])].join(" "));
  const rightTokens = reviewSignificantTokens([right.label, ...right.aliases, ...(right.variantLabels || [])].join(" "));
  if (leftTokens.length < 2 || rightTokens.length < 2) {
    return false;
  }

  const overlap = leftTokens.filter((token) => rightTokens.includes(token)).length;
  const union = uniqueStrings([...leftTokens, ...rightTokens]).length;
  return overlap >= 2 && overlap / union >= 0.25;
}

function reviewSignificantTokens(text: string): string[] {
  const reviewStopWords = new Set([
    "agent",
    "answer",
    "candidate",
    "context",
    "instruction",
    "memory",
    "output",
    "pattern",
    "preference",
    "principle",
    "review",
    "user",
    "uses",
    "use",
    "wants"
  ]);
  return significantTokens(text).filter((token) => !reviewStopWords.has(token)).slice(0, 8);
}

function mergeReviewStatus(left: ReviewStatus, right: ReviewStatus): ReviewStatus {
  if (left === "rejected" || right === "rejected") {
    return "rejected";
  }
  if (left === "approved" || right === "approved") {
    return "approved";
  }
  return "pending";
}

function reviewPriorityForItem(args: {
  type: ContextNodeType;
  confidence: number;
  stability?: ExtractedContextItem["stability"];
  inferenceLevel?: ExtractedContextItem["inferenceLevel"];
  sourceCount: number;
  status: ReviewStatus;
}): ReviewPriority {
  if (args.status === "rejected") {
    return "low";
  }
  if (
    args.sourceCount >= 2 ||
    (args.inferenceLevel === "explicit" &&
      (args.stability === "stable" || args.stability === "recurring") &&
      args.confidence >= 0.9)
  ) {
    return "high";
  }
  if (args.stability === "situational" || args.stability === "temporary" || args.confidence < 0.8) {
    return "low";
  }
  return "medium";
}

function reviewPriorityRank(priority?: ReviewPriority): number {
  return {
    high: 0,
    medium: 1,
    low: 2
  }[priority || "medium"];
}

function reviewStatusRank(status: ReviewStatus): number {
  return {
    pending: 0,
    rejected: 1,
    approved: 2
  }[status];
}

function collectSourceAnchorCandidates(
  input: ConversationExtraction,
  sourcePath: string
): { candidates: Candidate[]; rejected: number } {
  const candidates: Candidate[] = [];
  let rejected = 0;

  for (const type of SOURCE_ANCHOR_TYPES) {
    const items = prioritizeItems(
      type,
      (input.extraction[ITEMS_BY_TYPE[type]] || []) as ExtractedContextItem[]
    ).map((item) => normalizeItemForGraph(item, input));

    for (const item of items) {
      const candidate: Candidate = {
        type: redirectCandidateType(type, item.label),
        item,
        input,
        sourcePath,
        sourceId: input.conversation.sourceId
      };

      if (isEligibleSourceAnchorCandidate(candidate)) {
        candidates.push(candidate);
      } else {
        rejected += 1;
      }
    }
  }

  return {
    candidates: uniqueBy(candidates, (candidate) => `${candidate.type}:${slugify(candidate.item.label)}`),
    rejected
  };
}

function isEligibleSourceAnchorCandidate(candidate: Candidate): boolean {
  return candidate.item.confidence >= SOURCE_ANCHOR_MIN_CONFIDENCE &&
    candidate.item.evidence.length > 0 &&
    candidate.item.label.trim().length > 0 &&
    isNamedSourceAnchorLabel(candidate.type, candidate.item.label);
}

async function applySourceAnchorFallback(
  graph: BuiltContextGraph,
  registry: MatchRegistry,
  sourceAnchorCandidatesBySource: Map<string, Candidate[]>,
  transactionalSourceIds: Set<string>,
  settings: PersonalContextGraphSettings,
  provider: AIProvider
): Promise<void> {
  for (const [sourceId, candidates] of sourceAnchorCandidatesBySource.entries()) {
    if (countSourceLinks(graph.sourceLinksById[sourceId] || {}) > 0) {
      continue;
    }

    graph.stats.underlinkedSources += 1;
    const candidate = chooseSourceAnchorCandidate(candidates);
    if (!candidate) {
      continue;
    }

    const existingNode = await findNodeMatch(candidate, registry, graph, settings, provider);
    if (existingNode) {
      activateNode(graph, registry, existingNode);
      mergeCandidateIntoNode(existingNode, candidate);
      indexNode(existingNode, registry.nodeIndex);
      addSourceLink(graph, candidate.sourceId, candidate.type, existingNode);
      graph.stats.mergedCandidates += 1;
      graph.stats.sourceAnchorFallbacks += 1;
      continue;
    }

    if (transactionalSourceIds.has(sourceId)) {
      graph.stats.sourceOnlyCandidates += 1;
      graph.stats.demotedCandidates += 1;
      continue;
    }

    const node = createNode(
      candidate.type,
      candidate.item,
      settings.outputFolder,
      slugify(candidate.item.label)
    );
    registerNodeForMatching(registry, node, false);
    activateNode(graph, registry, node);
    mergeCandidateIntoNode(node, candidate);
    indexNode(node, registry.nodeIndex);
    addSourceLink(graph, candidate.sourceId, candidate.type, node);
    graph.stats.newlyPromotedNodes += 1;
    graph.stats.sourceAnchorFallbacks += 1;
  }
}

function chooseSourceAnchorCandidate(candidates: Candidate[]): Candidate | undefined {
  return [...candidates].sort((left, right) => {
    const typeDelta = sourceAnchorTypePriority(left.type) - sourceAnchorTypePriority(right.type);
    if (typeDelta !== 0) {
      return typeDelta;
    }

    const confidenceDelta = right.item.confidence - left.item.confidence;
    if (confidenceDelta !== 0) {
      return confidenceDelta;
    }

    const evidenceDelta = right.item.evidence.length - left.item.evidence.length;
    if (evidenceDelta !== 0) {
      return evidenceDelta;
    }

    const nameStrengthDelta =
      sourceAnchorNameStrength(right.item.label) - sourceAnchorNameStrength(left.item.label);
    if (nameStrengthDelta !== 0) {
      return nameStrengthDelta;
    }

    return labelNoiseScore(left.item.label) - labelNoiseScore(right.item.label);
  })[0];
}

function sourceAnchorTypePriority(type: ContextNodeType): number {
  if (type === "entity") {
    return 0;
  }
  if (type === "topic") {
    return 1;
  }
  return 2;
}

function countSourceLinks(
  linksByType: Partial<Record<ContextNodeType, GraphNode[]>>
): number {
  return Object.values(linksByType).reduce((sum, links) => sum + (links?.length || 0), 0);
}

function classifyProjectCandidate(candidate: Candidate): ProjectCandidateClassification {
  const text = projectCandidateText(
    candidate.item.summary,
    candidate.input.conversation.title,
    ...candidate.item.evidence.map((entry) => entry.quote)
  );
  return classifyProjectText(candidate.item.label, text);
}

function chooseRepresentative(candidates: Candidate[]): Candidate {
  return [...candidates].sort((left, right) => {
    const confidenceDelta = right.item.confidence - left.item.confidence;
    if (confidenceDelta !== 0) {
      return confidenceDelta;
    }

    const evidenceDelta = right.item.evidence.length - left.item.evidence.length;
    if (evidenceDelta !== 0) {
      return evidenceDelta;
    }

    return labelNoiseScore(left.item.label) - labelNoiseScore(right.item.label);
  })[0];
}

function createNode(
  type: ContextNodeType,
  item: ExtractedContextItem,
  outputFolder: string,
  slug: string
): GraphNode {
  const label = canonicalLabelForType(type, item.label, item.summary);
  const nodeSlug = slugify(label) || slug;
  return {
    id: `${type}_${nodeSlug}`,
    type,
    label,
    slug: nodeSlug,
    aliases: slugify(item.label) === nodeSlug ? [] : [item.label],
    path: buildNodePath(type, label, outputFolder),
    summary: item.summary,
    confidence: item.confidence,
    evidence: [],
    sourceIds: [],
    stability: item.stability,
    inferenceLevel: item.inferenceLevel,
    appliesTo: item.appliesTo,
    agentInstruction: item.agentInstruction
  };
}

function buildNodePath(type: ContextNodeType, label: string, outputFolder: string): string {
  const fileName = sanitizeFileName(label);
  return joinVaultPath(outputFolder, CONTEXT_NODE_FOLDER[type], `${fileName}.md`);
}

function canonicalLabelForType(type: ContextNodeType, label: string, summary: string): string {
  if (type === "project" && durableProjectDomainFromParts(label, summary) === "scann-fitness") {
    return "Scann / Scanis";
  }

  if (type === "project" && durableProjectDomainFromParts(label, summary) === "ai-learning-app") {
    return "AiLingo / AI Learning App";
  }

  return label;
}

function mergeCandidateIntoNode(
  node: GraphNode,
  candidate: Candidate,
  options: { includeAlias?: boolean; includeSummary?: boolean } = {}
): void {
  const includeAlias = options.includeAlias ?? true;
  const includeSummary = options.includeSummary ?? true;
  node.confidence = Math.max(node.confidence, candidate.item.confidence);
  if (includeSummary) {
    node.summary = mergeSummary(node.summary, candidate.item.summary);
  }
  mergeSelfModelMetadata(node, candidate.item);
  node.lastSeen =
    candidate.input.conversation.updateTime ||
    candidate.input.conversation.createTime ||
    candidate.input.extraction.extractedAt ||
    node.lastSeen;
  node.sourceIds = uniqueStrings([...node.sourceIds, candidate.sourceId]);
  if (includeAlias) {
    addAlias(node, candidate.item.label);
  }

  const evidence = candidate.item.evidence.map<NodeEvidence>((entry) => ({
    sourceId: candidate.sourceId,
    sourceTitle: candidate.input.conversation.title,
    sourcePath: candidate.sourcePath,
    quote: entry.quote,
    confidence: Math.min(candidate.item.confidence, entry.confidence)
  }));

  node.evidence = uniqueBy(
    [...node.evidence, ...evidence],
    (entry) => `${entry.sourceId}:${entry.quote}`
  )
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 30);
}

function mergeSeedIntoNode(node: GraphNode, seed: CanonicalNodeSeed): void {
  const normalizedSeed = normalizeSeedForType(seed, redirectCandidateType(seed.type, seed.label), node.path.split("/").slice(0, -2).join("/") || "Context Graph");
  if (node.type === "project") {
    for (const alias of filterProjectSeedAliases(normalizedSeed, node)) {
      addAlias(node, alias);
    }
    node.confidence = Math.max(node.confidence, normalizedSeed.confidence);
    node.lastSeen = maxStringDate(node.lastSeen, normalizedSeed.lastSeen);
    mergeSelfModelMetadata(node, normalizedSeed);
    return;
  }

  node.confidence = Math.max(node.confidence, normalizedSeed.confidence);
  node.summary = mergeSummary(node.summary, normalizedSeed.summary);
  node.lastSeen = maxStringDate(node.lastSeen, normalizedSeed.lastSeen);
  node.sourceIds = uniqueStrings([...node.sourceIds, ...normalizedSeed.sourceIds]);
  mergeSelfModelMetadata(node, normalizedSeed);
  for (const alias of [normalizedSeed.label, ...normalizedSeed.aliases]) {
    addAlias(node, alias);
  }

  node.evidence = uniqueBy(
    [...node.evidence, ...normalizedSeed.evidence],
    (entry) => `${entry.sourceId}:${entry.quote}`
  )
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 30);
}

function mergeSelfModelMetadata(
  node: GraphNode,
  item: Pick<
    ExtractedContextItem | CanonicalNodeSeed,
    "stability" | "inferenceLevel" | "appliesTo" | "agentInstruction"
  >
): void {
  node.stability = strongestStabilityValue(node.stability, item.stability);
  node.inferenceLevel = strongestInferenceValue(node.inferenceLevel, item.inferenceLevel);
  node.appliesTo = uniqueStrings([
    ...(node.appliesTo || []),
    ...(item.appliesTo || [])
  ]).slice(0, 8);
  if (!node.agentInstruction && item.agentInstruction) {
    node.agentInstruction = item.agentInstruction;
  }
}

function strongestStabilityValue(
  left?: ExtractedContextItem["stability"],
  right?: ExtractedContextItem["stability"]
): ExtractedContextItem["stability"] {
  const rank: Record<NonNullable<ExtractedContextItem["stability"]>, number> = {
    stable: 4,
    recurring: 3,
    situational: 2,
    temporary: 1
  };

  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return rank[right] > rank[left] ? right : left;
}

function strongestInferenceValue(
  left?: ExtractedContextItem["inferenceLevel"],
  right?: ExtractedContextItem["inferenceLevel"]
): ExtractedContextItem["inferenceLevel"] {
  return left === "explicit" || right === "explicit" ? "explicit" : left || right;
}

function addAlias(node: GraphNode, label: string): void {
  const alias = label.trim();
  if (!alias || slugify(alias) === node.slug) {
    return;
  }

  node.aliases = uniqueStrings([...node.aliases, alias]).slice(0, 12);
}

function addSourceLink(
  graph: BuiltContextGraph,
  sourceId: string,
  type: ContextNodeType,
  node: GraphNode
): void {
  const linksForType = graph.sourceLinksById[sourceId][type] || [];
  linksForType.push(node);
  graph.sourceLinksById[sourceId][type] = uniqueBy(linksForType, (linkedNode) => linkedNode.id);
}

function capSourceLinks(
  graph: BuiltContextGraph,
  settings: PersonalContextGraphSettings
): number {
  let removed = 0;
  for (const linksByType of Object.values(graph.sourceLinksById)) {
    for (const type of CONTEXT_NODE_TYPES) {
      const links = linksByType[type] || [];
      const sortedLinks = [...links].sort(compareLinkedNodes);
      const capped = sortedLinks.slice(0, settings.maxSourceLinksPerType);
      removed += Math.max(0, sortedLinks.length - capped.length);
      linksByType[type] = capped;
    }
  }

  return removed;
}

function compareLinkedNodes(left: GraphNode, right: GraphNode): number {
  const confidenceDelta = right.confidence - left.confidence;
  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }

  const evidenceDelta = right.evidence.length - left.evidence.length;
  if (evidenceDelta !== 0) {
    return evidenceDelta;
  }

  return left.label.localeCompare(right.label);
}

function rebuildEvidenceEdges(graph: BuiltContextGraph): void {
  graph.edges = [];
  for (const [sourceId, linksByType] of Object.entries(graph.sourceLinksById)) {
    for (const nodes of Object.values(linksByType)) {
      for (const node of nodes || []) {
        const edge = buildEdge(sourceId, node);
        if (!graph.edges.some((candidate) => candidate.id === edge.id)) {
          graph.edges.push(edge);
        }
      }
    }
  }
}

function addCoOccurrenceLinks(
  graph: BuiltContextGraph,
  settings: PersonalContextGraphSettings
): void {
  const cap = Math.max(1, settings.maxCoOccurrenceLinksPerType);
  for (const linksByType of Object.values(graph.sourceLinksById)) {
    const allNodes: GraphNode[] = [];
    for (const type of CONTEXT_NODE_TYPES) {
      for (const node of linksByType[type] || []) {
        if (!allNodes.some((existing) => existing.id === node.id)) {
          allNodes.push(node);
        }
      }
    }

    if (allNodes.length < 2) {
      continue;
    }

    for (const fromNode of allNodes) {
      const grouped = new Map<ContextNodeType, GraphNode[]>();
      for (const otherNode of allNodes) {
        if (otherNode.id === fromNode.id) {
          continue;
        }

        const list = grouped.get(otherNode.type) || [];
        list.push(otherNode);
        grouped.set(otherNode.type, list);
      }

      for (const [type, nodes] of grouped.entries()) {
        const ranked = [...nodes].sort(compareLinkedNodes).slice(0, cap);
        appendNodeLinks(graph, fromNode.id, type, ranked, cap);
      }
    }
  }
}

async function synthesizeNodeSummaries(
  graph: BuiltContextGraph,
  settings: PersonalContextGraphSettings,
  provider: AIProvider
): Promise<void> {
  if (!settings.synthesizeNodeSummaries) {
    return;
  }

  const minEvidence = Math.max(1, settings.synthesizeNodeSummaryMinEvidence);
  const targets: Array<{ node: GraphNode; args: Parameters<AIProvider["synthesizeSummary"]>[0] }> = [];

  for (const node of graph.nodes) {
    if (node.evidence.length < minEvidence) {
      continue;
    }

    const quotes = uniqueStrings(
      node.evidence
        .slice()
        .sort((left, right) => right.confidence - left.confidence)
        .map((entry) => entry.quote.trim())
        .filter(Boolean)
    ).slice(0, 12);

    if (quotes.length === 0) {
      continue;
    }

    targets.push({
      node,
      args: {
        key: node.id,
        type: node.type,
        label: node.label,
        evidenceQuotes: quotes
      }
    });
  }

  if (targets.length === 0) {
    return;
  }

  if (provider.synthesizeSummariesBatch) {
    try {
      const results = await provider.synthesizeSummariesBatch(targets.map((target) => target.args));
      const summariesByKey = new Map(results.map((result) => [result.key, result.summary]));
      for (const target of targets) {
        applySynthesizedSummary(target.node, summariesByKey.get(target.args.key || target.node.id) || "");
      }
      return;
    } catch (error) {
      graph.warnings.push(
        `Batch summary synthesis failed; falling back to individual summaries: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  for (const target of targets) {
    try {
      const synthesized = await provider.synthesizeSummary(target.args);
      applySynthesizedSummary(target.node, synthesized);
    } catch (error) {
      graph.warnings.push(
        `Summary synthesis skipped for "${target.node.label}": ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

function applySynthesizedSummary(node: GraphNode, synthesized: string): void {
  const cleaned = synthesized.replace(/\s+/g, " ").trim();
  if (cleaned) {
    node.summary = cleaned.slice(0, 600);
  }
}

async function addSemanticSimilarityLinks(
  graph: BuiltContextGraph,
  settings: PersonalContextGraphSettings,
  provider: AIProvider
): Promise<void> {
  if (graph.nodes.length < 2) {
    return;
  }

  const threshold = settings.similarityLinkThreshold;
  const cap = Math.max(1, settings.maxSimilarityLinksPerType);

  const embedded: GraphNode[] = [];
  for (const node of graph.nodes) {
    if (!node.embedding) {
      try {
        node.embedding = await provider.embedText(`${node.label}\n${node.summary}`);
      } catch (error) {
        graph.warnings.push(
          `Similarity link skipped for "${node.label}": ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        continue;
      }
    }
    if (node.embedding && node.embedding.length > 0) {
      embedded.push(node);
    }
  }

  for (const node of embedded) {
    const scored: Array<{ other: GraphNode; similarity: number }> = [];
    for (const other of embedded) {
      if (other.id === node.id) {
        continue;
      }

      const similarity = cosineSimilarity(node.embedding!, other.embedding!);
      if (similarity >= threshold) {
        scored.push({ other, similarity });
      }
    }

    scored.sort((left, right) => right.similarity - left.similarity);

    const grouped = new Map<ContextNodeType, GraphNode[]>();
    for (const entry of scored) {
      const list = grouped.get(entry.other.type) || [];
      if (list.length >= cap) {
        continue;
      }
      list.push(entry.other);
      grouped.set(entry.other.type, list);
    }

    for (const [type, links] of grouped.entries()) {
      appendNodeLinks(graph, node.id, type, links, cap);
    }
  }
}

const RESCALE_TOP = 0.99;
const RESCALE_BOTTOM = 0.55;
const RESCALE_SINGLETON = 0.85;

function rescaleNodeConfidence(graph: BuiltContextGraph): void {
  if (graph.nodes.length === 0) {
    return;
  }

  const nodesByType = new Map<ContextNodeType, GraphNode[]>();
  for (const node of graph.nodes) {
    const bucket = nodesByType.get(node.type) || [];
    bucket.push(node);
    nodesByType.set(node.type, bucket);
  }

  for (const nodes of nodesByType.values()) {
    if (nodes.length === 1) {
      nodes[0].confidence = RESCALE_SINGLETON;
      continue;
    }

    const sorted = [...nodes].sort((left, right) => {
      const evidenceDelta = right.evidence.length - left.evidence.length;
      if (evidenceDelta !== 0) {
        return evidenceDelta;
      }

      const sourceDelta = right.sourceIds.length - left.sourceIds.length;
      if (sourceDelta !== 0) {
        return sourceDelta;
      }

      const confidenceDelta = right.confidence - left.confidence;
      if (confidenceDelta !== 0) {
        return confidenceDelta;
      }

      return left.label.localeCompare(right.label);
    });

    const span = RESCALE_TOP - RESCALE_BOTTOM;
    const stepCount = sorted.length - 1;
    for (let index = 0; index < sorted.length; index += 1) {
      const rankFraction = index / stepCount;
      const rescaled = RESCALE_TOP - rankFraction * span;
      sorted[index].confidence = Math.round(rescaled * 100) / 100;
    }
  }
}

function applyGraphHygiene(graph: BuiltContextGraph, registry: MatchRegistry): number {
  const degrees = computeCanonicalDegrees(graph);
  const isolatedIds = new Set(
    graph.nodes
      .filter((node) => (degrees.get(node.id) || 0) === 0)
      .map((node) => node.id)
  );

  if (isolatedIds.size === 0) {
    return 0;
  }

  graph.nodes = graph.nodes.filter((node) => !isolatedIds.has(node.id));
  for (const id of isolatedIds) {
    registry.activeNodeIds.delete(id);
  }

  for (const linksByType of Object.values(graph.sourceLinksById)) {
    for (const type of CONTEXT_NODE_TYPES) {
      const links = linksByType[type] || [];
      linksByType[type] = links.filter((node) => !isolatedIds.has(node.id));
    }
  }

  for (const [nodeId, linksByType] of Object.entries(graph.nodeLinksById)) {
    if (isolatedIds.has(nodeId)) {
      delete graph.nodeLinksById[nodeId];
      continue;
    }

    for (const type of CONTEXT_NODE_TYPES) {
      const links = linksByType[type] || [];
      linksByType[type] = links.filter((node) => !isolatedIds.has(node.id));
    }
  }

  return isolatedIds.size;
}

function finalizeGraphStats(graph: BuiltContextGraph, registry: MatchRegistry): void {
  const visibleSeedNodes = graph.nodes.filter((node) => registry.seedNodeIds.has(node.id)).length;
  graph.stats.seededNodes = visibleSeedNodes;
  graph.stats.unmatchedSeedNodes = Math.max(0, registry.seedNodeIds.size - visibleSeedNodes);
  graph.stats.visibleCanonicalNodes = graph.nodes.length;
  graph.stats.isolatedCanonicalNodes = countIsolatedCanonicalNodes(graph);
  graph.stats.canonicalSelfModelNodes = graph.nodes.filter((node) =>
    SELF_MODEL_TYPES.has(node.type)
  ).length;
  graph.stats.inferredCanonicalNodes = graph.nodes.filter(
    (node) => node.inferenceLevel === "supported_inference"
  ).length;
  graph.stats.nounNodeCount = graph.nodes.filter((node) => NOUN_HEAVY_TYPES.has(node.type)).length;
  graph.stats.selfModelNodeCount = graph.stats.canonicalSelfModelNodes;
  graph.stats.nounToSelfModelRatio =
    graph.stats.selfModelNodeCount === 0
      ? graph.stats.nounNodeCount
      : Math.round((graph.stats.nounNodeCount / graph.stats.selfModelNodeCount) * 100) / 100;
}

function countIsolatedCanonicalNodes(graph: BuiltContextGraph): number {
  const degrees = computeCanonicalDegrees(graph);
  return graph.nodes.filter((node) => (degrees.get(node.id) || 0) === 0).length;
}

function computeCanonicalDegrees(graph: BuiltContextGraph): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const node of graph.nodes) {
    degrees.set(node.id, 0);
  }

  const bump = (nodeId: string): void => {
    if (degrees.has(nodeId)) {
      degrees.set(nodeId, (degrees.get(nodeId) || 0) + 1);
    }
  };

  for (const linksByType of Object.values(graph.sourceLinksById)) {
    for (const nodes of Object.values(linksByType)) {
      for (const node of nodes || []) {
        bump(node.id);
      }
    }
  }

  for (const [nodeId, linksByType] of Object.entries(graph.nodeLinksById)) {
    for (const nodes of Object.values(linksByType)) {
      for (const node of nodes || []) {
        bump(nodeId);
        bump(node.id);
      }
    }
  }

  return degrees;
}

function appendNodeLinks(
  graph: BuiltContextGraph,
  nodeId: string,
  type: ContextNodeType,
  links: GraphNode[],
  maxLinks: number
): void {
  if (links.length === 0) {
    return;
  }

  const existing = graph.nodeLinksById[nodeId]?.[type] || [];
  graph.nodeLinksById[nodeId] = {
    ...graph.nodeLinksById[nodeId],
    [type]: uniqueBy([...existing, ...links], (node) => node.id)
      .sort(compareLinkedNodes)
      .slice(0, maxLinks)
  };
}

function mergeSummary(existing: string, incoming: string): string {
  if (!existing) {
    return incoming;
  }

  if (!incoming || existing.includes(incoming)) {
    return existing;
  }

  if (incoming.includes(existing)) {
    return incoming;
  }

  return `${existing} ${incoming}`.slice(0, 900);
}

function buildEdge(sourceId: string, node: GraphNode): GraphEdge {
  const fromId = `source_${hashString(sourceId)}`;
  return {
    id: `${fromId}->${node.id}`,
    fromId,
    toId: node.id,
    edgeType: "evidence_for",
    confidence: node.confidence,
    evidence: node.evidence.filter((evidence) => evidence.sourceId === sourceId).slice(0, 3)
  };
}

function indexNode(node: GraphNode, nodeIndex: Map<string, GraphNode>): void {
  for (const key of matchKeys(node.type, node.label, node.aliases, node.summary)) {
    nodeIndex.set(key, node);
  }
}

function matchKeys(
  type: ContextNodeType,
  label: string,
  aliases: string[],
  summary = ""
): string[] {
  const values = [label, ...aliases].filter(Boolean);
  const keys = values.flatMap((value) => {
    const slug = slugify(value);
    const normalizedSlug = normalizedLabelSlug(value);
    const filenameSlug = normalizedFilenameLabelSlug(value);
    return uniqueStrings([
      `${type}:${slug}`,
      normalizedSlug && normalizedSlug !== slug ? `${type}:normalized:${normalizedSlug}` : "",
      type !== "project" && normalizedAppProductLabelSlug(value)
        ? `${type}:app-product:${normalizedAppProductLabelSlug(value)}`
        : "",
      type !== "project" && filenameSlug ? `${type}:filename:${filenameSlug}` : ""
    ]);
  });

  if (type === "project") {
    void summary;
    for (const value of values) {
      const domainKey = durableProjectDomainFromParts(value, "");
      if (domainKey) {
        keys.push(`${type}:project-domain:${domainKey}`);
      }

      const normalizedProjectSlug = normalizedProjectLabelSlug(value);
      if (normalizedProjectSlug) {
        keys.push(`${type}:project-normalized:${normalizedProjectSlug}`);
      }
    }
  }

  return uniqueStrings(keys);
}

function passesSemanticGuard(
  type: ContextNodeType,
  leftLabel: string,
  rightLabel: string,
  similarity: number,
  settings: PersonalContextGraphSettings,
  leftSummary = "",
  rightSummary = ""
): boolean {
  if (type === "project") {
    return isProjectMatchAllowed(leftLabel, leftSummary, rightLabel, rightSummary);
  }

  if (similarity >= settings.semanticMergeThreshold + 0.05) {
    return true;
  }

  const leftAppProductSlug = normalizedAppProductLabelSlug(leftLabel);
  const rightAppProductSlug = normalizedAppProductLabelSlug(rightLabel);
  if (leftAppProductSlug && leftAppProductSlug === rightAppProductSlug) {
    return true;
  }

  const leftFilenameSlug = normalizedFilenameLabelSlug(leftLabel);
  const rightFilenameSlug = normalizedFilenameLabelSlug(rightLabel);
  if (leftFilenameSlug && leftFilenameSlug === rightFilenameSlug) {
    return true;
  }

  const leftTokens = significantTokens(leftLabel);
  const rightTokens = significantTokens(rightLabel);
  return leftTokens.some((token) => rightTokens.includes(token));
}

function significantTokens(label: string): string[] {
  const stopWords = new Set([
    "and",
    "the",
    "for",
    "with",
    "from",
    "into",
    "that",
    "this",
    "over",
    "using",
    "based",
    "system",
    "project",
    "logic",
    "feature",
    "app"
  ]);

  return uniqueStrings(slugify(label)
    .split("-")
    .map(normalizeToken)
    .filter((token) => (token.length >= 3 || /^\d+$/.test(token)) && !stopWords.has(token)));
}

function normalizedLabelSlug(label: string): string {
  return significantTokens(label).join("-");
}

function normalizedProjectLabelSlug(label: string): string {
  const projectStopWords = new Set([
    "project",
    "system",
    "pipeline",
    "feature",
    "app",
    "overhaul",
    "improvement",
    "integration",
    "implementation",
    "workflow"
  ]);

  return significantTokens(label)
    .filter((token) => !projectStopWords.has(token))
    .slice(0, 5)
    .join("-");
}

const FILENAME_EXTENSIONS = new Set([
  "swift",
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "md",
  "json",
  "yaml",
  "yml",
  "toml",
  "rs",
  "go",
  "java",
  "kt",
  "h",
  "m",
  "mm",
  "cpp",
  "cc",
  "c",
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "htm",
  "vue",
  "rb",
  "sh",
  "bash",
  "sql",
  "proto",
  "graphql",
  "gql",
  "lua",
  "php",
  "pl",
  "scala"
]);

const FILENAME_VARIANT_SUFFIX_PATTERN =
  /\s+(?:source\s+file|source|implementation|code|impl|file|class|module|function|fn|view|controller)$/i;

export function isFilenameLikeLabel(label: string): boolean {
  return Boolean(normalizedFilenameLabelSlug(label));
}

function redirectCandidateType(type: ContextNodeType, label: string): ContextNodeType {
  if (type === "style_pattern") {
    return "pattern";
  }

  if ((type === "entity" || type === "artifact") && isFilenameLikeLabel(label)) {
    return "artifact";
  }

  return type;
}

const TRANSACTIONAL_TITLE_PATTERN =
  /\b(comparison|critique|chat|exchange|explanation|greetings|guide|how[- ]to|overview|question|recommendation|recommendations|tip|tips|tutorial|walkthrough)\b/i;

const TRANSACTIONAL_TITLE_PREFIX_PATTERN =
  /^(how|what|why|when|where|which|can|is|are|does|do|should|will|would|could|add|configure|create|debug|delete|disable|enable|export|find|fix|generate|group|import|install|move|remove|reorganize|run|search|setup|use)\b/i;

function isTransactionalConversation(input: ConversationExtraction): boolean {
  const title = input.conversation.title.trim();
  const summary = input.extraction.summary.trim();

  const domain = projectDomainKey(`${title} ${summary}`);
  if (domain && isNonProjectDomain(domain)) {
    return true;
  }

  if (
    TRANSACTIONAL_TITLE_PREFIX_PATTERN.test(title) ||
    TRANSACTIONAL_TITLE_PATTERN.test(title)
  ) {
    return true;
  }

  return false;
}

function normalizedFilenameLabelSlug(label: string): string {
  const trimmed = label.trim();
  if (!trimmed || trimmed.startsWith("_")) {
    return "";
  }

  const stripped = trimmed.replace(FILENAME_VARIANT_SUFFIX_PATTERN, "").trim();
  const tokens = stripped.split(/\s+/);
  for (const token of tokens) {
    const match = /^([A-Za-z0-9_]+)\.([A-Za-z0-9]{1,6})$/.exec(token);
    if (match && FILENAME_EXTENSIONS.has(match[2].toLowerCase())) {
      return slugify(match[1]);
    }
  }

  return "";
}

function normalizedAppProductLabelSlug(label: string): string {
  const tokens = slugify(label)
    .split("-")
    .map(normalizeToken)
    .filter(Boolean);
  const hasAny = (...values: string[]) => values.some((value) => tokens.includes(value));
  const hasLearningAppSignal =
    hasAny("ailingo") ||
    hasAny("duolingo") ||
    (hasAny("learning") && hasAny("app", "product", "platform", "design"));
  if (hasLearningAppSignal) {
    return "ai-learning-app";
  }

  if (hasAny("scann", "scannai", "bodyscanner")) {
    return "scann";
  }

  return "";
}

function projectDomainKey(text: string): ProjectDomainKey | undefined {
  const tokens = significantTokens(text);
  const hasAny = (...values: string[]) => values.some((value) => tokens.includes(value));
  const hasAll = (...values: string[]) => values.every((value) => tokens.includes(value));

  if (hasAny("family", "iphone", "phone", "carrier", "verizon", "mobile", "tmobile")) {
    return "phone-plan";
  }

  if (
    hasAny("ailingo", "duolingo") ||
    (hasAny("learning") && hasAny("app", "b2c", "mvp", "product", "startup", "tech", "stack"))
  ) {
    return "ai-learning-app";
  }

  if (hasAny("scann", "scanis", "scannai", "bodyscanner")) {
    return "scann-fitness";
  }

  if (hasAny("job", "displacement") && hasAny("role", "tech", "estimate", "career")) {
    return "ai-job-research";
  }

  if (hasAny("assignment", "homework", "class", "course") || hasAll("top", "five")) {
    return "school-assignment";
  }

  if (
    hasAny("neck", "posture", "slouch", "backwaist", "angle") &&
    hasAny("score", "calibration", "metric", "base", "posture")
  ) {
    return "scann-fitness";
  }

  if (
    hasAny("bodyscanner", "scann", "scannai", "scan", "physique", "fitness", "workout") &&
    hasAny("evaluation", "benchmark", "openai", "gpt", "workout", "fitness", "scan", "body")
  ) {
    return "scann-fitness";
  }

  if (hasAll("maintain", "weight") && hasAny("benchmark", "logic", "goal")) {
    return "scann-fitness";
  }

  return undefined;
}

function isNonProjectDomain(domain: ProjectDomainKey): boolean {
  return NON_PROJECT_DOMAINS.has(domain);
}

function projectCandidateText(...values: string[]): string {
  return values.filter(Boolean).join(" ");
}

function isProjectMatchAllowed(
  leftLabel: string,
  leftSummary: string,
  rightLabel: string,
  rightSummary: string
): boolean {
  const leftDomain = durableProjectDomainFromParts(leftLabel, leftSummary);
  const rightDomain = durableProjectDomainFromParts(rightLabel, rightSummary);
  return Boolean(leftDomain && rightDomain && leftDomain === rightDomain);
}

function isDurableProjectSeed(seed: CanonicalNodeSeed): boolean {
  return classifyProjectText(seed.label, "").kind === "durable_project";
}

function filterProjectSeedAliases(seed: CanonicalNodeSeed, targetNode?: GraphNode): string[] {
  const seedDomain = durableProjectDomainFromParts(targetNode?.label || seed.label, "");

  return uniqueStrings(seed.aliases || []).filter((alias) => {
    const classification = classifyProjectText(alias, "");
    return classification.kind === "durable_project" &&
      Boolean(seedDomain && classification.domain === seedDomain);
  });
}

function classifyProjectText(label: string, summary: string): ProjectCandidateClassification {
  const domain = projectDomainFromParts(label, summary);
  if (!domain || isNonProjectDomain(domain)) {
    return {
      kind: "non_project",
      domain
    };
  }

  if (isProjectEvidenceOnlyLabel(label, summary)) {
    return {
      kind: "domain_evidence",
      domain
    };
  }

  if (isDurableProjectWorkstreamLabel(label, summary, domain)) {
    return {
      kind: "durable_project",
      domain
    };
  }

  return {
    kind: "domain_evidence",
    domain
  };
}

function projectDomainFromParts(label: string, summary: string): ProjectDomainKey | undefined {
  const labelDomain = projectDomainKey(label);
  if (labelDomain) {
    return labelDomain;
  }

  const summaryDomain = projectDomainKey(summary);
  if (summaryDomain) {
    return summaryDomain;
  }

  if (looksLikeGenericDurableProject(label, summary)) {
    const genericSlug = normalizedProjectLabelSlug(label) || slugify(label);
    return genericSlug ? `custom:${genericSlug}` : undefined;
  }

  return undefined;
}

function durableProjectDomainFromParts(label: string, summary: string): ProjectDomainKey | undefined {
  const domain = projectDomainFromParts(label, summary);
  return domain && !isNonProjectDomain(domain) ? domain : undefined;
}

function isProjectEvidenceOnlyLabel(label: string, summary: string): boolean {
  const domain = projectDomainKey(label) || projectDomainKey(summary);
  const text = label;
  if (
    domain === "scann-fitness" &&
    /\b(accuracy|benchmark|benchmarking|evaluation|funding|logic|pitch|posture|score|scoring|slide|slides)\b/i.test(text) &&
    !/\b(scann|scanis|bodyscanner)\b/i.test(text)
  ) {
    return true;
  }

  return /\b(analysis|assignment|breakdown|deck|deliverable|funding|outline|pitch|planning|query|reference|research|resume|slide|slides|stack|ux|writeup)\b/i.test(text);
}

function looksLikeGenericDurableProject(label: string, summary: string): boolean {
  const cleanLabel = label.trim();
  if (
    !cleanLabel ||
    cleanLabel.length > 90 ||
    isNarrowActionLabel(cleanLabel) ||
    isProjectEvidenceOnlyLabel(cleanLabel, summary)
  ) {
    return false;
  }

  const labelTokens = significantTokens(cleanLabel);
  if (labelTokens.length < 2) {
    return false;
  }

  const text = `${cleanLabel} ${summary}`;
  return /\b(agent|app|graph|platform|plugin|product|service|system|tool|vault|workflow|workstream)\b/i.test(text);
}

function isDurableProjectWorkstreamLabel(
  label: string,
  summary: string,
  domain: ProjectDomainKey
): boolean {
  const text = `${label} ${summary}`;
  if (isNarrowActionLabel(label)) {
    return false;
  }

  if (domain === "ai-learning-app") {
    return /\b(app|duolingo|learning|mvp|product)\b/i.test(text) &&
      !isProjectEvidenceOnlyLabel(label, summary);
  }

  if (domain === "scann-fitness") {
    return /\b(app|bodyscanner|evaluation|fitness|pipeline|project|scan|scann|system|workout)\b/i.test(text) &&
      !isProjectEvidenceOnlyLabel(label, summary);
  }

  if (domain === "posture-scoring") {
    return /\b(app|method|posture|score|scoring|system)\b/i.test(text) &&
      !isProjectEvidenceOnlyLabel(label, summary);
  }

  if (domain.startsWith("custom:")) {
    return looksLikeGenericDurableProject(label, summary);
  }

  return false;
}

function normalizeToken(token: string): string {
  if (token === "scoring" || token === "scores") {
    return "score";
  }
  if (token === "features") {
    return "feature";
  }
  if (token === "benchmarks") {
    return "benchmark";
  }
  if (token === "weights") {
    return "weight";
  }
  if (token === "tmobile") {
    return "mobile";
  }
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("s") && token.length > 4 && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function isNamedStableLabel(label: string): boolean {
  const tokens = significantTokens(label);
  if (tokens.length === 0 || label.length > 90) {
    return false;
  }

  if (/\.[a-z0-9]{1,8}$/i.test(label) || /\b[A-Z]{2,}\b/.test(label) || /[a-z][A-Z]/.test(label)) {
    return true;
  }

  if (/\d/.test(label) || /^[A-Z]/.test(label.trim())) {
    return !isNarrowActionLabel(label);
  }

  return tokens.length >= 3 && !isNarrowActionLabel(label);
}

function isNamedSourceAnchorLabel(type: ContextNodeType, label: string): boolean {
  if (!isNamedStableLabel(label) || isNarrowActionLabel(label)) {
    return false;
  }

  if (type === "entity") {
    return sourceAnchorNameStrength(label) >= 1;
  }

  return sourceAnchorNameStrength(label) >= 1 &&
    !/\b(note|topic|discussion|context|question)\b/i.test(label);
}

function sourceAnchorNameStrength(label: string): number {
  let score = 0;
  if (/\.[a-z0-9]{1,8}$/i.test(label) || /[a-z][A-Z]/.test(label)) {
    score += 3;
  }
  if (/\b[A-Z]{2,}\b/.test(label)) {
    score += 2;
  }
  if (/\bThe\s+[A-Z][a-z]+\b/.test(label)) {
    score += 2;
  }
  if (/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/.test(label)) {
    score += 1;
  }
  if (/\d/.test(label)) {
    score += 1;
  }
  return score;
}

function isDurableProjectLabel(cluster: CandidateCluster): boolean {
  const combinedText = [
    cluster.label,
    cluster.summary,
    ...cluster.candidates.map((candidate) => candidate.item.summary)
  ].join(" ");

  const domain = durableProjectDomainFromParts(cluster.label, combinedText);
  if (domain) {
    return isDurableProjectWorkstreamLabel(cluster.label, combinedText, domain);
  }

  const tokens = significantTokens(combinedText);
  return tokens.length >= 3 &&
    !isNarrowActionLabel(cluster.label) &&
    tokens.some((token) =>
      ["agent", "automation", "backend", "database", "frontend", "graph", "platform", "plugin", "product", "vault", "workflow"].includes(token)
    );
}

function isDurableTopicLabel(label: string): boolean {
  const tokens = significantTokens(label);
  return tokens.length >= 3 && label.length <= 80 && !isNarrowActionLabel(label);
}

function isNarrowActionLabel(label: string): boolean {
  return /^(add|adjust|ask|build|check|choose|compute|create|define|design|derive|determine|evaluate|explain|fetch|generate|implement|incorporate|map|move|prioritize|provide|refine|remove|replace|request|save|store|tailor|update|upload|use)\b/i.test(label.trim());
}

function labelNoiseScore(label: string): number {
  let score = 0;
  if (/\bchunk\b/i.test(label)) {
    score += 10;
  }
  if (label.length > 80) {
    score += 3;
  }
  if (/[^a-z0-9 ._-]/i.test(label)) {
    score += 2;
  }
  return score;
}

function maxStringDate(left?: string, right?: string): string | undefined {
  return [left, right].filter((value): value is string => Boolean(value)).sort().at(-1);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function buildSourcePath(
  title: string,
  sourceId: string,
  settings: Pick<PersonalContextGraphSettings, "outputFolder">
): string {
  const titlePart = sanitizeFileName(title);
  const idPart = hashString(sourceId).slice(0, 8);
  return joinVaultPath(settings.outputFolder, "Sources", "ChatGPT", `${titlePart} - ${idPart}.md`);
}

export function joinVaultPath(...parts: string[]): string {
  return parts
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}
