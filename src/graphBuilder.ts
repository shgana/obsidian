import type { PersonalContextGraphSettings } from "./settings";
import {
  CONTEXT_NODE_FOLDER,
  CONTEXT_NODE_TYPES,
  type AIProvider,
  type BuiltContextGraph,
  type ContextNodeType,
  type ConversationExtraction,
  type ExtractedContextItem,
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

export async function buildContextGraph(
  inputs: ConversationExtraction[],
  settings: PersonalContextGraphSettings,
  provider: AIProvider
): Promise<BuiltContextGraph> {
  const graph: BuiltContextGraph = {
    nodes: [],
    edges: [],
    sourcePathsById: {},
    sourceLinksById: {},
    warnings: []
  };

  const nodesByExactKey = new Map<string, GraphNode>();

  for (const input of inputs) {
    const sourcePath = buildSourcePath(input.conversation.title, input.conversation.sourceId, settings);
    graph.sourcePathsById[input.conversation.sourceId] = sourcePath;
    graph.sourceLinksById[input.conversation.sourceId] = {};

    for (const type of CONTEXT_NODE_TYPES) {
      const items = input.extraction[ITEMS_BY_TYPE[type]] as ExtractedContextItem[];
      const acceptedItems = items.filter(
        (item) => item.confidence >= settings.confidenceThreshold && item.evidence.length > 0
      );

      for (const item of acceptedItems) {
        const node = await findOrCreateNode({
          item,
          type,
          sourcePath,
          input,
          nodesByExactKey,
          graph,
          settings,
          provider
        });

        const linksForType = graph.sourceLinksById[input.conversation.sourceId][type] || [];
        linksForType.push(node);
        graph.sourceLinksById[input.conversation.sourceId][type] = uniqueBy(
          linksForType,
          (linkedNode) => linkedNode.id
        );

        const edge = buildEdge(input.conversation.sourceId, node);
        const existingEdge = graph.edges.find((candidate) => candidate.id === edge.id);
        if (!existingEdge) {
          graph.edges.push(edge);
        } else {
          existingEdge.confidence = Math.max(existingEdge.confidence, edge.confidence);
          existingEdge.evidence = uniqueBy(
            [...existingEdge.evidence, ...edge.evidence],
            (evidence) => `${evidence.sourceId}:${evidence.quote}`
          ).slice(0, 12);
        }
      }
    }
  }

  graph.nodes.sort((left, right) => left.path.localeCompare(right.path));
  graph.edges.sort((left, right) => left.id.localeCompare(right.id));
  return graph;
}

interface FindOrCreateNodeArgs {
  item: ExtractedContextItem;
  type: ContextNodeType;
  sourcePath: string;
  input: ConversationExtraction;
  nodesByExactKey: Map<string, GraphNode>;
  graph: BuiltContextGraph;
  settings: PersonalContextGraphSettings;
  provider: AIProvider;
}

async function findOrCreateNode(args: FindOrCreateNodeArgs): Promise<GraphNode> {
  const slug = slugify(args.item.label);
  const exactKey = `${args.type}:${slug}`;
  const exactNode = args.nodesByExactKey.get(exactKey);
  const semanticNode = exactNode
    ? undefined
    : await findSemanticMergeCandidate(args.item, args.type, args.graph, args.settings, args.provider);
  const node =
    exactNode ||
    semanticNode ||
    createNode(args.type, args.item, args.settings.outputFolder, slug);

  if (!exactNode && !semanticNode) {
    args.graph.nodes.push(node);
    args.nodesByExactKey.set(exactKey, node);
  }

  mergeNodeEvidence(node, args.item, args.input, args.sourcePath);
  if (!args.nodesByExactKey.has(exactKey)) {
    args.nodesByExactKey.set(exactKey, node);
  }

  return node;
}

async function findSemanticMergeCandidate(
  item: ExtractedContextItem,
  type: ContextNodeType,
  graph: BuiltContextGraph,
  settings: PersonalContextGraphSettings,
  provider: AIProvider
): Promise<GraphNode | undefined> {
  const candidates = graph.nodes.filter((node) => node.type === type);
  if (candidates.length === 0) {
    return undefined;
  }

  let itemEmbedding: number[];
  try {
    itemEmbedding = await provider.embedText(`${item.label}\n${item.summary}`);
  } catch (error) {
    graph.warnings.push(
      `Semantic merge skipped for "${item.label}": ${
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
        candidate.embedding = await provider.embedText(`${candidate.label}\n${candidate.summary}`);
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

  if (bestNode && bestSimilarity >= settings.semanticMergeThreshold) {
    return bestNode;
  }

  return undefined;
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
    path: joinVaultPath(outputFolder, CONTEXT_NODE_FOLDER[type], `${fileName}.md`),
    summary: item.summary,
    confidence: item.confidence,
    evidence: [],
    sourceIds: []
  };
}

function mergeNodeEvidence(
  node: GraphNode,
  item: ExtractedContextItem,
  input: ConversationExtraction,
  sourcePath: string
): void {
  node.confidence = Math.max(node.confidence, item.confidence);
  node.summary = mergeSummary(node.summary, item.summary);
  node.lastSeen =
    input.conversation.updateTime ||
    input.conversation.createTime ||
    input.extraction.extractedAt ||
    node.lastSeen;
  node.sourceIds = uniqueBy([...node.sourceIds, input.conversation.sourceId], (sourceId) => sourceId);

  const evidence = item.evidence.map<NodeEvidence>((entry) => ({
    sourceId: input.conversation.sourceId,
    sourceTitle: input.conversation.title,
    sourcePath,
    quote: entry.quote,
    confidence: Math.min(item.confidence, entry.confidence)
  }));

  node.evidence = uniqueBy(
    [...node.evidence, ...evidence],
    (entry) => `${entry.sourceId}:${entry.quote}`
  )
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 20);
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

  return `${existing} ${incoming}`.slice(0, 800);
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
