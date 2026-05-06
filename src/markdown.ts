import type { PersonalContextGraphSettings } from "./settings";
import {
  CONTEXT_NODE_LABEL,
  CONTEXT_NODE_PLURAL_LABEL,
  CONTEXT_NODE_TYPES,
  type BuiltContextGraph,
  type ContextNodeType,
  type ConversationExtraction,
  type FileDraft,
  type GraphNode,
  type NodeEvidence
} from "./types";
import { conversationToTranscript } from "./conversationText";
import { hashString, truncate } from "./text";
import { joinVaultPath } from "./graphBuilder";

export function createGraphFileDrafts(
  inputs: ConversationExtraction[],
  graph: BuiltContextGraph,
  settings: PersonalContextGraphSettings
): FileDraft[] {
  const drafts: FileDraft[] = [];

  for (const input of inputs) {
    drafts.push({
      path: graph.sourcePathsById[input.conversation.sourceId],
      content: renderSourceNote(input, graph),
      managed: true
    });
  }

  for (const node of graph.nodes) {
    drafts.push({
      path: node.path,
      content: renderNodeNote(node),
      managed: true
    });
  }

  drafts.push({
    path: buildAgentContextPath(settings),
    content: renderAgentContext(inputs, graph),
    managed: true
  });

  return drafts;
}

export function buildAgentContextPath(
  settings: Pick<PersonalContextGraphSettings, "outputFolder">
): string {
  return joinVaultPath(settings.outputFolder, "Agent Context.md");
}

function renderSourceNote(input: ConversationExtraction, graph: BuiltContextGraph): string {
  const linksByType = graph.sourceLinksById[input.conversation.sourceId] || {};
  const typedFrontmatter = Object.fromEntries(
    CONTEXT_NODE_TYPES.map((type) => [
      frontmatterKeyForType(type),
      (linksByType[type] || []).map((node) => wikiLink(node.path, node.label))
    ])
  );

  return [
    yamlFrontmatter({
      pcg_type: "source_conversation",
      pcg_id: `source_${hashString(input.conversation.sourceId)}`,
      pcg_source: "chatgpt",
      pcg_source_id: input.conversation.sourceId,
      pcg_managed: true,
      pcg_confidence: round(input.extraction.confidence),
      pcg_last_seen: input.conversation.updateTime || input.conversation.createTime,
      pcg_evidence_count: countLinkedNodes(linksByType),
      ...typedFrontmatter
    }),
    `# ${input.conversation.title}`,
    "",
    "## Summary",
    input.extraction.summary || "No summary extracted.",
    "",
    "## Context Links",
    renderTypedLinks(linksByType),
    "",
    "## Extracted Evidence",
    renderSourceEvidence(input, graph),
    "",
    "## Transcript",
    conversationToTranscript(input.conversation)
  ].join("\n");
}

function renderNodeNote(node: GraphNode): string {
  const sourceLinks = node.evidence.map((evidence) =>
    wikiLink(evidence.sourcePath, evidence.sourceTitle)
  );

  return [
    yamlFrontmatter({
      pcg_type: node.type,
      pcg_id: node.id,
      pcg_source: "personal-context-graph",
      pcg_managed: true,
      pcg_confidence: round(node.confidence),
      pcg_last_seen: node.lastSeen,
      pcg_evidence_count: node.evidence.length,
      pcg_sources: uniqueStrings(sourceLinks)
    }),
    `# ${CONTEXT_NODE_LABEL[node.type]}: ${node.label}`,
    "",
    "## Summary",
    node.summary,
    "",
    "## Evidence",
    renderEvidenceList(node.evidence),
    "",
    "## Source Conversations",
    uniqueStrings(sourceLinks)
      .map((link) => `- ${link}`)
      .join("\n")
  ].join("\n");
}

function renderAgentContext(inputs: ConversationExtraction[], graph: BuiltContextGraph): string {
  return [
    yamlFrontmatter({
      pcg_type: "agent_context",
      pcg_id: "agent_context",
      pcg_source: "personal-context-graph",
      pcg_managed: true,
      pcg_confidence: round(average(inputs.map((input) => input.extraction.confidence))),
      pcg_last_seen: latestDate(inputs),
      pcg_evidence_count: graph.edges.length
    }),
    "# Agent Context",
    "",
    "## Profile Summary",
    renderProfileSummary(inputs),
    "",
    ...CONTEXT_NODE_TYPES.flatMap((type) => [
      `## ${CONTEXT_NODE_PLURAL_LABEL[type]}`,
      renderTopNodes(graph.nodes.filter((node) => node.type === type)),
      ""
    ]),
    "## Source Conversations",
    inputs
      .map((input) => {
        const path = graph.sourcePathsById[input.conversation.sourceId];
        return `- ${wikiLink(path, input.conversation.title)}: ${input.extraction.summary}`;
      })
      .join("\n")
  ].join("\n");
}

function renderProfileSummary(inputs: ConversationExtraction[]): string {
  const summaries = inputs
    .sort((left, right) => right.extraction.confidence - left.extraction.confidence)
    .slice(0, 12)
    .map((input) => `- ${input.extraction.summary}`);

  return summaries.length > 0 ? summaries.join("\n") : "No high-confidence context extracted yet.";
}

function renderTopNodes(nodes: GraphNode[]): string {
  const topNodes = nodes
    .sort((left, right) => {
      const confidenceDelta = right.confidence - left.confidence;
      if (confidenceDelta !== 0) {
        return confidenceDelta;
      }

      return right.evidence.length - left.evidence.length;
    })
    .slice(0, 20);

  if (topNodes.length === 0) {
    return "None extracted yet.";
  }

  return topNodes
    .map((node) => {
      const evidencePreview = node.evidence[0]
        ? ` Evidence: "${truncate(node.evidence[0].quote, 160)}"`
        : "";
      return `- ${wikiLink(node.path, node.label)} (${round(node.confidence)}, ${
        node.evidence.length
      } evidence item${node.evidence.length === 1 ? "" : "s"}): ${node.summary}${evidencePreview}`;
    })
    .join("\n");
}

function renderTypedLinks(
  linksByType: Partial<Record<ContextNodeType, GraphNode[]>>
): string {
  const lines = CONTEXT_NODE_TYPES.map((type) => {
    const links = linksByType[type] || [];
    if (links.length === 0) {
      return undefined;
    }

    return `- ${CONTEXT_NODE_PLURAL_LABEL[type]}: ${links
      .map((node) => wikiLink(node.path, node.label))
      .join(", ")}`;
  }).filter(Boolean);

  return lines.length > 0 ? lines.join("\n") : "No high-confidence links extracted.";
}

function renderSourceEvidence(input: ConversationExtraction, graph: BuiltContextGraph): string {
  const linksByType = graph.sourceLinksById[input.conversation.sourceId] || {};
  const lines: string[] = [];

  for (const type of CONTEXT_NODE_TYPES) {
    const nodes = linksByType[type] || [];
    if (nodes.length === 0) {
      continue;
    }

    lines.push(`### ${CONTEXT_NODE_PLURAL_LABEL[type]}`);
    for (const node of nodes) {
      const evidence = node.evidence.find(
        (entry) => entry.sourceId === input.conversation.sourceId
      );
      lines.push(
        `- ${wikiLink(node.path, node.label)} (${round(node.confidence)}): ${
          evidence ? truncate(evidence.quote, 220) : node.summary
        }`
      );
    }
    lines.push("");
  }

  return lines.join("\n").trim() || "No high-confidence evidence extracted.";
}

function renderEvidenceList(evidence: NodeEvidence[]): string {
  if (evidence.length === 0) {
    return "No evidence captured.";
  }

  return evidence
    .map(
      (entry) =>
        `- ${wikiLink(entry.sourcePath, entry.sourceTitle)} (${round(entry.confidence)}): "${truncate(
          entry.quote,
          240
        )}"`
    )
    .join("\n");
}

function countLinkedNodes(linksByType: Partial<Record<ContextNodeType, GraphNode[]>>): number {
  return CONTEXT_NODE_TYPES.reduce((count, type) => count + (linksByType[type]?.length || 0), 0);
}

function yamlFrontmatter(values: Record<string, unknown>): string {
  const lines = ["---"];

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${yamlScalar(item)}`);
        }
      }
      continue;
    }

    lines.push(`${key}: ${yamlScalar(value)}`);
  }

  lines.push("---");
  return lines.join("\n");
}

function yamlScalar(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(String(value));
}

function wikiLink(path: string, label: string): string {
  return `[[${path.replace(/\.md$/i, "")}|${label.replace(/\|/g, "-")}]]`;
}

function frontmatterKeyForType(type: ContextNodeType): string {
  if (type === "style_pattern") {
    return "pcg_style_patterns";
  }

  return `pcg_${type}s`;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function latestDate(inputs: ConversationExtraction[]): string | undefined {
  return inputs
    .flatMap((input) => [
      input.conversation.updateTime,
      input.conversation.createTime,
      input.extraction.extractedAt
    ])
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
