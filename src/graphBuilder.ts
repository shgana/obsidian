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

interface MatchRegistry {
  nodes: GraphNode[];
  nodeIndex: Map<string, GraphNode>;
  seedNodeIds: Set<string>;
  activeNodeIds: Set<string>;
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

  const registry: MatchRegistry = {
    nodes: [],
    nodeIndex: new Map<string, GraphNode>(),
    seedNodeIds: new Set<string>(),
    activeNodeIds: new Set<string>()
  };
  await seedCanonicalNodes(graph, registry, seeds, settings, provider);

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
        const existingNode = await findNodeMatch(candidate, registry, graph, settings, provider);
        if (existingNode) {
          activateNode(graph, registry, existingNode);
          mergeCandidateIntoNode(existingNode, candidate);
          indexNode(existingNode, registry.nodeIndex);
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

      registerNodeForMatching(registry, node, false);
      activateNode(graph, registry, node);
      graph.stats.newlyPromotedNodes += 1;
      for (const candidate of cluster.candidates) {
        mergeCandidateIntoNode(node, candidate);
        addSourceLink(graph, candidate.sourceId, candidate.type, node);
      }
      graph.stats.mergedCandidates += Math.max(0, cluster.candidates.length - 1);
      indexNode(node, registry.nodeIndex);
    } else {
      graph.stats.sourceOnlyCandidates += cluster.candidates.length;
      graph.stats.demotedCandidates += cluster.candidates.length;
    }
  }

  graph.stats.sourceOnlyCandidates += capSourceLinks(graph, settings);
  addSparseProjectLinks(graph, settings);
  graph.stats.demotedCandidates += applyGraphHygiene(graph, registry);
  rebuildEvidenceEdges(graph);
  finalizeGraphStats(graph, registry);
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
    prunedDuplicateNodes: 0,
    visibleCanonicalNodes: 0,
    isolatedCanonicalNodes: 0,
    unmatchedSeedNodes: 0,
    demotedCandidates: 0
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
    const node = seedToNode(seed);
    const duplicate = await findNodeMatchForLabel(
      seed.type,
      seed.label,
      seed.summary,
      seed.aliases,
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
      return exactNode;
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
    passesSemanticGuard(args.type, args.label, bestNode.label, bestSimilarity, args.settings)
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
    passesSemanticGuard(candidate.type, candidate.item.label, bestCluster.label, bestSimilarity, settings)
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
  const totalProjectLinkCap = Math.max(4, settings.maxProjectLinksPerType * 3);
  for (const linksByType of Object.values(graph.sourceLinksById)) {
    const projects = linksByType.project || [];
    if (projects.length === 0) {
      continue;
    }

    for (const project of projects) {
      const selected: Array<{ type: ContextNodeType; node: GraphNode }> = [];
      const selectedByType = new Map<ContextNodeType, number>();
      const candidates = PROJECT_LINK_TYPES.flatMap((type) =>
        (linksByType[type] || [])
          .filter((node) => node.id !== project.id)
          .map((node) => ({ type, node }))
      ).sort((left, right) => compareLinkedNodes(left.node, right.node));

      for (const candidate of candidates) {
        if (selected.length >= totalProjectLinkCap) {
          break;
        }

        const countForType = selectedByType.get(candidate.type) || 0;
        if (countForType >= settings.maxProjectLinksPerType) {
          continue;
        }

        selected.push(candidate);
        selectedByType.set(candidate.type, countForType + 1);
      }

      for (const type of PROJECT_LINK_TYPES) {
        const linkedNodes = selected
          .filter((entry) => entry.type === type)
          .map((entry) => entry.node);
        appendNodeLinks(graph, project.id, type, linkedNodes, settings.maxProjectLinksPerType);
      }
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
    return uniqueStrings([
      `${type}:${slug}`,
      normalizedSlug && normalizedSlug !== slug ? `${type}:normalized:${normalizedSlug}` : ""
    ]);
  });

  if (type === "project") {
    for (const value of [...values, summary]) {
      const familyKey = projectFamilyKey(value);
      if (familyKey) {
        keys.push(`${type}:project-family:${familyKey}`);
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
  settings: PersonalContextGraphSettings
): boolean {
  if (type === "project") {
    const leftFamily = projectFamilyKey(leftLabel);
    const rightFamily = projectFamilyKey(rightLabel);
    if (leftFamily && leftFamily === rightFamily) {
      return true;
    }

    if (similarity < settings.semanticMergeThreshold + 0.08) {
      const leftTokens = significantTokens(leftLabel);
      const rightTokens = significantTokens(rightLabel);
      return leftTokens.filter((token) => rightTokens.includes(token)).length >= 2;
    }
  }

  if (similarity >= settings.semanticMergeThreshold + 0.05) {
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

function projectFamilyKey(label: string): string | undefined {
  const tokens = significantTokens(label);
  const hasAny = (...values: string[]) => values.some((value) => tokens.includes(value));
  const hasAll = (...values: string[]) => values.every((value) => tokens.includes(value));

  if (hasAny("family", "iphone", "phone", "carrier", "verizon", "mobile", "tmobile")) {
    return "family-phone-plan";
  }

  if (hasAny("duolingo") || (hasAny("learning") && hasAny("startup", "tech", "stack"))) {
    return "duolingo-ai-learning-app";
  }

  if (hasAny("job", "displacement") && hasAny("role", "tech", "estimate", "career")) {
    return "ai-job-displacement";
  }

  if (
    hasAny("neck", "posture", "slouch", "backwaist", "angle") &&
    hasAny("score", "calibration", "metric", "base", "posture")
  ) {
    return "posture-scoring-system";
  }

  if (
    hasAny("bodyscanner", "scann", "scannai", "scan", "physique", "fitness", "workout") &&
    hasAny("evaluation", "benchmark", "openai", "gpt", "workout", "fitness", "scan", "body")
  ) {
    return "fitness-scan-ai-system";
  }

  if (hasAll("maintain", "weight") && hasAny("benchmark", "logic", "goal")) {
    return "maintain-weight-benchmarking";
  }

  return undefined;
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

function isDurableProjectLabel(cluster: CandidateCluster): boolean {
  const combinedText = [
    cluster.label,
    cluster.summary,
    ...cluster.candidates.map((candidate) => candidate.item.summary)
  ].join(" ");

  if (projectFamilyKey(combinedText)) {
    return true;
  }

  const tokens = significantTokens(combinedText);
  return tokens.length >= 3 &&
    !isNarrowActionLabel(cluster.label) &&
    tokens.some((token) =>
      ["product", "platform", "workflow", "backend", "frontend", "database", "automation"].includes(token)
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
