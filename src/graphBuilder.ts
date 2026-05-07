import type { PersonalContextGraphSettings } from "./settings";
import {
  CONTEXT_NODE_FOLDER,
  CONTEXT_NODE_TYPES,
  type AIProvider,
  type BuiltContextGraph,
  type CanonicalNodeSeed,
  type ContextNodeType,
  type ConversationExtraction,
  type ExtractedContextItem,
  type GraphBuildStats,
  type GraphEdge,
  type GraphNode,
  type NodeEvidence
} from "./types";
import { cosineSimilarity, hashString, sanitizeFileName, slugify, uniqueBy } from "./text";

const ITEMS_BY_TYPE: Record<ContextNodeType, keyof ConversationExtraction["extraction"]> = {
  topic: "topics",
  entity: "entities",
  project: "projects",
  preference: "preferences",
  decision: "decisions",
  task: "tasks",
  artifact: "artifacts",
  style_pattern: "stylePatterns"
};

const GRAPH_ITEM_LIMITS: Record<ContextNodeType, number> = {
  topic: 10,
  entity: 8,
  project: 5,
  preference: 7,
  decision: 7,
  task: 8,
  artifact: 7,
  style_pattern: 5
};

const PROJECT_LINK_TYPES: ContextNodeType[] = [
  "topic",
  "preference",
  "decision",
  "task",
  "artifact",
  "entity",
  "style_pattern"
];

interface Candidate {
  type: ContextNodeType;
  item: ExtractedContextItem;
  input: ConversationExtraction;
  sourcePath: string;
  sourceId: string;
  embedding?: number[];
}

interface CandidateCluster {
  type: ContextNodeType;
  candidates: Candidate[];
  label: string;
  summary: string;
  embedding?: number[];
}

export async function buildContextGraph(
  inputs: ConversationExtraction[],
  settings: PersonalContextGraphSettings,
  provider: AIProvider,
  seeds: CanonicalNodeSeed[] = []
): Promise<BuiltContextGraph> {
  const graph: BuiltContextGraph = {
    nodes: [],
    edges: [],
    sourcePathsById: {},
    sourceLinksById: {},
    nodeLinksById: {},
    warnings: [],
    stats: createStats()
  };

  const nodeIndex = new Map<string, GraphNode>();
  await seedCanonicalNodes(graph, nodeIndex, seeds, settings, provider);

  const unmatchedCandidates: Candidate[] = [];
  for (const input of inputs) {
    const sourcePath = buildSourcePath(input.conversation.title, input.conversation.sourceId, settings);
    graph.sourcePathsById[input.conversation.sourceId] = sourcePath;
    graph.sourceLinksById[input.conversation.sourceId] = {};

    for (const type of CONTEXT_NODE_TYPES) {
      const items = input.extraction[ITEMS_BY_TYPE[type]] as ExtractedContextItem[];
      const candidates = prioritizeItems(type, items)
        .map((item) => normalizeItemForGraph(item, input))
        .filter((item) => item.confidence >= settings.confidenceThreshold && item.evidence.length > 0)
        .map<Candidate>((item) => ({
          type,
          item,
          input,
          sourcePath,
          sourceId: input.conversation.sourceId
        }));

      for (const candidate of candidates) {
        const existingNode = await findNodeMatch(candidate, graph, nodeIndex, settings, provider);
        if (existingNode) {
          mergeCandidateIntoNode(existingNode, candidate);
          indexNode(existingNode, nodeIndex);
          addSourceLink(graph, candidate.sourceId, candidate.type, existingNode);
          graph.stats.mergedCandidates += 1;
        } else {
          unmatchedCandidates.push(candidate);
        }
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

      graph.nodes.push(node);
      graph.stats.newlyPromotedNodes += 1;
      for (const candidate of cluster.candidates) {
        mergeCandidateIntoNode(node, candidate);
        addSourceLink(graph, candidate.sourceId, candidate.type, node);
      }
      graph.stats.mergedCandidates += Math.max(0, cluster.candidates.length - 1);
      indexNode(node, nodeIndex);
    } else {
      graph.stats.sourceOnlyCandidates += cluster.candidates.length;
    }
  }

  graph.stats.sourceOnlyCandidates += capSourceLinks(graph, settings);
  rebuildEvidenceEdges(graph);
  addSparseProjectLinks(graph, settings);
  graph.nodes.sort((left, right) => left.path.localeCompare(right.path));
  graph.edges.sort((left, right) => left.id.localeCompare(right.id));
  return graph;
}

function createStats(): GraphBuildStats {
  return {
    seededNodes: 0,
    mergedCandidates: 0,
    newlyPromotedNodes: 0,
    sourceOnlyCandidates: 0,
    prunedDuplicateNodes: 0
  };
}

async function seedCanonicalNodes(
  graph: BuiltContextGraph,
  nodeIndex: Map<string, GraphNode>,
  seeds: CanonicalNodeSeed[],
  settings: PersonalContextGraphSettings,
  provider: AIProvider
): Promise<void> {
  const orderedSeeds = [...seeds].sort(compareSeedSurvivorPriority);
  for (const seed of orderedSeeds) {
    const node = seedToNode(seed);
    const duplicate = await findNodeMatchForLabel(
      seed.type,
      seed.label,
      seed.summary,
      seed.aliases,
      graph,
      nodeIndex,
      settings,
      provider
    );

    if (duplicate) {
      mergeSeedIntoNode(duplicate, seed);
      indexNode(duplicate, nodeIndex);
      graph.stats.prunedDuplicateNodes += 1;
      continue;
    }

    graph.nodes.push(node);
    indexNode(node, nodeIndex);
    graph.stats.seededNodes += 1;
  }
}

function seedToNode(seed: CanonicalNodeSeed): GraphNode {
  return {
    id: seed.id,
    type: seed.type,
    label: seed.label,
    slug: seed.slug || slugify(seed.label),
    aliases: uniqueStrings(seed.aliases || []),
    path: seed.path,
    summary: seed.summary,
    confidence: seed.confidence,
    evidence: [...seed.evidence],
    sourceIds: uniqueStrings(seed.sourceIds || []),
    lastSeen: seed.lastSeen
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
  graph: BuiltContextGraph,
  nodeIndex: Map<string, GraphNode>,
  settings: PersonalContextGraphSettings,
  provider: AIProvider
): Promise<GraphNode | undefined> {
  return findNodeMatchForLabel(
    candidate.type,
    candidate.item.label,
    candidate.item.summary,
    [],
    graph,
    nodeIndex,
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
  graph: BuiltContextGraph,
  nodeIndex: Map<string, GraphNode>,
  settings: PersonalContextGraphSettings,
  provider: AIProvider,
  candidate?: Candidate
): Promise<GraphNode | undefined> {
  for (const key of matchKeys(type, label, aliases)) {
    const exactNode = nodeIndex.get(key);
    if (exactNode) {
      return exactNode;
    }
  }

  return findSemanticMergeCandidate({
    type,
    label,
    summary,
    graph,
    settings,
    provider,
    candidate
  });
}

async function findSemanticMergeCandidate(args: {
  type: ContextNodeType;
  label: string;
  summary: string;
  graph: BuiltContextGraph;
  settings: PersonalContextGraphSettings;
  provider: AIProvider;
  candidate?: Candidate;
}): Promise<GraphNode | undefined> {
  const candidates = args.graph.nodes.filter((node) => node.type === args.type);
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
    args.graph.warnings.push(
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
    passesSemanticGuard(args.label, bestNode.label, bestSimilarity, args.settings)
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
  const exactSlug = slugify(candidate.item.label);
  const exactCluster = clusters.find(
    (cluster) => cluster.type === candidate.type && slugify(cluster.label) === exactSlug
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
    passesSemanticGuard(candidate.item.label, bestCluster.label, bestSimilarity, settings)
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

  return (
    sourceCount >= settings.minimumCanonicalSources ||
    maxConfidence >= settings.singleSourcePromotionThreshold
  );
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
  const fileName = sanitizeFileName(item.label);
  return {
    id: `${type}_${slug}`,
    type,
    label: item.label,
    slug,
    aliases: [],
    path: joinVaultPath(outputFolder, CONTEXT_NODE_FOLDER[type], `${fileName}.md`),
    summary: item.summary,
    confidence: item.confidence,
    evidence: [],
    sourceIds: []
  };
}

function mergeCandidateIntoNode(node: GraphNode, candidate: Candidate): void {
  node.confidence = Math.max(node.confidence, candidate.item.confidence);
  node.summary = mergeSummary(node.summary, candidate.item.summary);
  node.lastSeen =
    candidate.input.conversation.updateTime ||
    candidate.input.conversation.createTime ||
    candidate.input.extraction.extractedAt ||
    node.lastSeen;
  node.sourceIds = uniqueStrings([...node.sourceIds, candidate.sourceId]);
  addAlias(node, candidate.item.label);

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
  node.confidence = Math.max(node.confidence, seed.confidence);
  node.summary = mergeSummary(node.summary, seed.summary);
  node.lastSeen = maxStringDate(node.lastSeen, seed.lastSeen);
  node.sourceIds = uniqueStrings([...node.sourceIds, ...seed.sourceIds]);
  for (const alias of [seed.label, ...seed.aliases]) {
    addAlias(node, alias);
  }

  node.evidence = uniqueBy(
    [...node.evidence, ...seed.evidence],
    (entry) => `${entry.sourceId}:${entry.quote}`
  )
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 30);
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

function addSparseProjectLinks(
  graph: BuiltContextGraph,
  settings: PersonalContextGraphSettings
): void {
  for (const linksByType of Object.values(graph.sourceLinksById)) {
    const projects = linksByType.project || [];
    if (projects.length === 0) {
      continue;
    }

    for (const project of projects) {
      for (const type of PROJECT_LINK_TYPES) {
        const linkedNodes = (linksByType[type] || [])
          .filter((node) => node.id !== project.id)
          .sort(compareLinkedNodes)
          .slice(0, settings.maxProjectLinksPerType);
        appendNodeLinks(graph, project.id, type, linkedNodes, settings.maxProjectLinksPerType);
      }
    }
  }
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
  for (const key of matchKeys(node.type, node.label, node.aliases)) {
    nodeIndex.set(key, node);
  }
}

function matchKeys(type: ContextNodeType, label: string, aliases: string[]): string[] {
  return uniqueStrings([label, ...aliases].map((value) => `${type}:${slugify(value)}`));
}

function passesSemanticGuard(
  leftLabel: string,
  rightLabel: string,
  similarity: number,
  settings: PersonalContextGraphSettings
): boolean {
  if (similarity >= settings.semanticMergeThreshold + 0.05) {
    return true;
  }

  const leftTokens = significantTokens(leftLabel);
  const rightTokens = significantTokens(rightLabel);
  return leftTokens.some((token) => rightTokens.includes(token));
}

function significantTokens(label: string): string[] {
  const stopWords = new Set([
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
    "logic"
  ]);

  return slugify(label)
    .split("-")
    .filter((token) => token.length >= 3 && !stopWords.has(token));
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
