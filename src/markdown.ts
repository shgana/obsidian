import type { PersonalContextGraphSettings } from "./settings";
import {
  CONTEXT_NODE_LABEL,
  CONTEXT_NODE_PLURAL_LABEL,
  CONTEXT_NODE_TYPES,
  type BuiltContextGraph,
  type ContextNodeType,
  type ConversationExtraction,
  type ExtractedContextItem,
  type FileDraft,
  type GraphNode,
  type NodeEvidence
} from "./types";
import { conversationToTranscript } from "./conversationText";
import { hashString, slugify, truncate } from "./text";
import { joinVaultPath } from "./graphBuilder";

export function createGraphFileDrafts(
  inputs: ConversationExtraction[],
  graph: BuiltContextGraph,
  settings: PersonalContextGraphSettings
): FileDraft[] {
  const drafts: FileDraft[] = [];

  drafts.push(buildIdentityDraft(settings));

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
      content: renderNodeNote(node, graph),
      managed: true
    });
  }

  drafts.push({
    path: buildAgentContextPath(settings),
    content: renderAgentContext(inputs, graph, settings),
    managed: true
  });

  if (settings.agentContextSections) {
    for (const section of buildAgentContextSectionDrafts(inputs, graph, settings)) {
      drafts.push(section);
    }
  }

  return drafts;
}

export function buildIdentityPath(
  settings: Pick<PersonalContextGraphSettings, "outputFolder">
): string {
  return joinVaultPath(settings.outputFolder, "Entities", "_Me.md");
}

function buildIdentityDraft(
  settings: Pick<PersonalContextGraphSettings, "outputFolder">
): FileDraft {
  const content = [
    yamlFrontmatter({
      pcg_type: "identity",
      pcg_id: "identity_me",
      pcg_source: "personal-context-graph",
      pcg_managed: true,
      pcg_protected: true,
      pcg_aliases: ["About Me", "Identity", "Me"]
    }),
    "# Me",
    "",
    "> This is your identity card. The plugin created it on first import and will never overwrite it again as long as `pcg_protected: true` stays in the frontmatter. Edit freely — agents read this first to understand who you are.",
    "",
    "## Identity",
    "- **Name**: ",
    "- **Role**: ",
    "- **Location / Timezone**: ",
    "- **Working hours**: ",
    "",
    "## Active Focus (Top 3)",
    "- ",
    "- ",
    "- ",
    "",
    "## Working Style & Preferences",
    "- ",
    "",
    "## Key People",
    "- ",
    "",
    "## Communication Preferences",
    "- ",
    "",
    "## Tools & Stack",
    "- ",
    "",
    "## How agents should help me",
    "- "
  ].join("\n");

  return {
    path: buildIdentityPath(settings),
    content,
    managed: true,
    createOnly: true
  };
}

export function buildAgentContextPath(
  settings: Pick<PersonalContextGraphSettings, "outputFolder">
): string {
  return joinVaultPath(settings.outputFolder, "Agent Context.md");
}

function renderSourceNote(input: ConversationExtraction, graph: BuiltContextGraph): string {
  const linksByType = graph.sourceLinksById[input.conversation.sourceId] || {};
  const typedFrontmatter = Object.fromEntries(
    CONTEXT_NODE_TYPES.flatMap((type) => [
      [frontmatterKeyForType(type), (linksByType[type] || []).map((node) => node.id)],
      [`${frontmatterKeyForType(type)}_paths`, (linksByType[type] || []).map((node) => node.path)]
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
    "## Source-Only Context",
    renderSourceOnlyContext(input, linksByType),
    "",
    "## Extracted Evidence",
    renderSourceEvidence(input, graph),
    "",
    "## Transcript",
    conversationToTranscript(input.conversation)
  ].join("\n");
}

function renderNodeNote(node: GraphNode, graph: BuiltContextGraph): string {
  const sourceLinks = node.evidence.map((evidence) =>
    evidence.sourcePath
  );
  const relatedLinks = graph.nodeLinksById[node.id] || {};

  return [
    yamlFrontmatter({
      pcg_type: node.type,
      pcg_id: node.id,
      pcg_source: "personal-context-graph",
      pcg_managed: true,
      pcg_confidence: round(node.confidence),
      pcg_last_seen: node.lastSeen,
      pcg_evidence_count: node.evidence.length,
      pcg_aliases: node.aliases,
      pcg_source_ids: node.sourceIds,
      pcg_source_paths: uniqueStrings(sourceLinks)
    }),
    `# ${CONTEXT_NODE_LABEL[node.type]}: ${node.label}`,
    "",
    "## Summary",
    node.summary,
    "",
    "## Evidence",
    renderEvidenceList(node.evidence),
    "",
    "## Related Context",
    renderTypedLinks(relatedLinks),
    "",
    "## Source Conversations",
    uniqueStrings(sourceLinks)
      .map((link) => `- ${link}`)
      .join("\n")
  ].join("\n");
}

function renderAgentContext(
  inputs: ConversationExtraction[],
  graph: BuiltContextGraph,
  settings: PersonalContextGraphSettings
): string {
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
      renderTopNodes(graph.nodes.filter((node) => node.type === type), settings.linkAgentContextToGraph),
      ""
    ]),
    "## Source Conversations",
    inputs
      .map((input) => {
        const path = graph.sourcePathsById[input.conversation.sourceId];
        const label = settings.linkAgentContextToGraph
          ? wikiLink(path, input.conversation.title)
          : `${input.conversation.title} (${path})`;
        return `- ${label}: ${input.extraction.summary}`;
      })
      .join("\n")
  ].join("\n");
}

interface AgentContextSection {
  type: ContextNodeType | "identity" | "sources";
  title: string;
  fileName: string;
  description: string;
}

const AGENT_CONTEXT_SECTIONS: AgentContextSection[] = [
  {
    type: "identity",
    title: "Identity",
    fileName: "00 Identity.md",
    description: "Pointer to your protected `_Me.md` identity card."
  },
  {
    type: "project",
    title: "Active Projects",
    fileName: "01 Active Projects.md",
    description: "Durable workstreams the user is actively building."
  },
  {
    type: "decision",
    title: "Decisions",
    fileName: "02 Decisions.md",
    description: "Choices the user has made or accepted, ranked by recency."
  },
  {
    type: "preference",
    title: "Preferences",
    fileName: "03 Preferences.md",
    description: "Stable preferences and requirements stated by the user."
  },
  {
    type: "task",
    title: "Tasks",
    fileName: "04 Tasks.md",
    description: "Outstanding asks and follow-ups from the user."
  },
  {
    type: "topic",
    title: "Recent Topics",
    fileName: "05 Recent Topics.md",
    description: "Topics the user has been thinking about, ranked by recency."
  },
  {
    type: "entity",
    title: "Entities",
    fileName: "06 Entities.md",
    description: "Named people, products, organizations, files, and frameworks."
  },
  {
    type: "artifact",
    title: "Artifacts",
    fileName: "07 Artifacts.md",
    description: "Concrete deliverables produced or shared in conversations."
  },
  {
    type: "style_pattern",
    title: "Style Patterns",
    fileName: "08 Style Patterns.md",
    description: "How the user prefers to communicate and work."
  },
  {
    type: "sources",
    title: "Source Conversations",
    fileName: "09 Sources.md",
    description: "Pointers to the underlying source conversations."
  }
];

function buildAgentContextSectionDrafts(
  inputs: ConversationExtraction[],
  graph: BuiltContextGraph,
  settings: PersonalContextGraphSettings
): FileDraft[] {
  const drafts: FileDraft[] = [];
  const folder = joinVaultPath(settings.outputFolder, "Agent Context");

  drafts.push({
    path: joinVaultPath(folder, "README.md"),
    content: renderAgentContextReadme(settings),
    managed: true
  });

  for (const section of AGENT_CONTEXT_SECTIONS) {
    drafts.push({
      path: joinVaultPath(folder, section.fileName),
      content: renderAgentContextSection(section, inputs, graph, settings),
      managed: true
    });
  }

  return drafts;
}

function renderAgentContextReadme(
  settings: Pick<PersonalContextGraphSettings, "outputFolder">
): string {
  const lines = [
    yamlFrontmatter({
      pcg_type: "agent_context_index",
      pcg_id: "agent_context_index",
      pcg_source: "personal-context-graph",
      pcg_managed: true
    }),
    "# Agent Context",
    "",
    "Sectioned retrieval surface for agents. Read `00 Identity.md` first, then load only the sections you need for the task at hand.",
    "",
    "## Sections"
  ];

  for (const section of AGENT_CONTEXT_SECTIONS) {
    const sectionPath = joinVaultPath(settings.outputFolder, "Agent Context", section.fileName);
    lines.push(`- ${wikiLink(sectionPath, section.title)} — ${section.description}`);
  }

  return lines.join("\n");
}

function renderAgentContextSection(
  section: AgentContextSection,
  inputs: ConversationExtraction[],
  graph: BuiltContextGraph,
  settings: PersonalContextGraphSettings
): string {
  const lines: string[] = [
    yamlFrontmatter({
      pcg_type: `agent_context_section`,
      pcg_id: `agent_context_${section.title.toLowerCase().replace(/\s+/g, "_")}`,
      pcg_source: "personal-context-graph",
      pcg_managed: true
    }),
    `# ${section.title}`,
    "",
    section.description,
    ""
  ];

  if (section.type === "identity") {
    const identityPath = buildIdentityPath(settings);
    lines.push(`## Identity Card`);
    lines.push(`${wikiLink(identityPath, "_Me")} — your protected identity card. Edit there to teach agents who you are.`);
    lines.push("");
    return lines.join("\n");
  }

  if (section.type === "sources") {
    lines.push("## Conversations");
    if (inputs.length === 0) {
      lines.push("None yet.");
      lines.push("");
      return lines.join("\n");
    }

    const sortedInputs = [...inputs].sort((left, right) =>
      compareDateDesc(latestInputDate(left), latestInputDate(right))
    );

    for (const input of sortedInputs) {
      const path = graph.sourcePathsById[input.conversation.sourceId];
      const label = wikiLink(path, input.conversation.title);
      const dateMarker = formatDateMarker(latestInputDate(input));
      lines.push(`- ${label}${dateMarker}: ${input.extraction.summary}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  const nodes = graph.nodes
    .filter((node) => node.type === section.type)
    .sort((left, right) => {
      const recencyDelta = compareDateDesc(left.lastSeen, right.lastSeen);
      if (recencyDelta !== 0) {
        return recencyDelta;
      }

      const evidenceDelta = right.evidence.length - left.evidence.length;
      if (evidenceDelta !== 0) {
        return evidenceDelta;
      }

      return right.confidence - left.confidence;
    });

  if (nodes.length === 0) {
    lines.push("None extracted yet.");
    lines.push("");
    return lines.join("\n");
  }

  for (const node of nodes) {
    const dateMarker = formatDateMarker(node.lastSeen);
    lines.push(`### ${wikiLink(node.path, node.label)}${dateMarker}`);
    if (node.summary) {
      lines.push(node.summary);
    }
    const relatedLinks = graph.nodeLinksById[node.id] || {};
    const relatedRendered = renderTypedLinks(relatedLinks);
    if (relatedRendered && !/No high-confidence/.test(relatedRendered)) {
      lines.push("");
      lines.push("**Related:**");
      lines.push(relatedRendered);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function latestInputDate(input: ConversationExtraction): string | undefined {
  return (
    input.conversation.updateTime ||
    input.conversation.createTime ||
    input.extraction.extractedAt
  );
}

function compareDateDesc(left?: string, right?: string): number {
  if (!left && !right) {
    return 0;
  }

  if (!left) {
    return 1;
  }

  if (!right) {
    return -1;
  }

  return right.localeCompare(left);
}

function formatDateMarker(value?: string): string {
  if (!value) {
    return "";
  }

  const date = value.slice(0, 10);
  return ` _(${date})_`;
}

function renderProfileSummary(inputs: ConversationExtraction[]): string {
  const summaries = inputs
    .sort((left, right) => right.extraction.confidence - left.extraction.confidence)
    .slice(0, 12)
    .map((input) => `- ${input.extraction.summary}`);

  return summaries.length > 0 ? summaries.join("\n") : "No high-confidence context extracted yet.";
}

function renderTopNodes(nodes: GraphNode[], useWikiLinks: boolean): string {
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
      const label = useWikiLinks ? wikiLink(node.path, node.label) : `${node.label} (${node.path})`;
      return `- ${label} (${round(node.confidence)}, ${
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

const EXTRACTION_ITEMS_BY_TYPE: Record<
  ContextNodeType,
  keyof ConversationExtraction["extraction"]
> = {
  topic: "topics",
  entity: "entities",
  project: "projects",
  preference: "preferences",
  decision: "decisions",
  task: "tasks",
  artifact: "artifacts",
  style_pattern: "stylePatterns"
};

function renderSourceOnlyContext(
  input: ConversationExtraction,
  linksByType: Partial<Record<ContextNodeType, GraphNode[]>>
): string {
  const lines: string[] = [];

  for (const type of CONTEXT_NODE_TYPES) {
    const promotedSlugs = new Set(
      (linksByType[type] || []).flatMap((node) => [
        node.slug,
        ...node.aliases.map((alias) => slugify(alias))
      ])
    );
    const items = input.extraction[EXTRACTION_ITEMS_BY_TYPE[type]] as ExtractedContextItem[];
    const sourceOnlyItems = items
      .filter((item) => !promotedSlugs.has(slugify(item.label.replace(/\s+\(chunk\s+\d+\)$/i, ""))))
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, 8);

    if (sourceOnlyItems.length === 0) {
      continue;
    }

    lines.push(`### ${CONTEXT_NODE_PLURAL_LABEL[type]}`);
    for (const item of sourceOnlyItems) {
      const evidence = item.evidence[0]?.quote;
      lines.push(
        `- ${item.label} (${round(item.confidence)}): ${item.summary}${
          evidence ? ` Evidence: "${truncate(evidence, 180)}"` : ""
        }`
      );
    }
    lines.push("");
  }

  return lines.join("\n").trim() || "No source-only context retained.";
}

function renderEvidenceList(evidence: NodeEvidence[]): string {
  if (evidence.length === 0) {
    return "No evidence captured.";
  }

  return evidence
    .map(
      (entry) =>
        `- ${entry.sourceTitle} (${entry.sourcePath}) (${round(entry.confidence)}): "${truncate(
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
  if (type === "entity") {
    return "pcg_entities";
  }

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
