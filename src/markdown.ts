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
  type NodeEvidence,
  type ParsedConversation,
  type ReviewCategory,
  type ReviewQueueItem
} from "./types";
import { conversationToTranscript } from "./conversationText";
import { hashString, slugify, truncate } from "./text";
import { buildReviewQueuePath, joinVaultPath } from "./graphBuilder";

const AGENT_CONTEXT_NODE_ORDER: ContextNodeType[] = [
  "agent_instruction",
  "pattern",
  "principle",
  "preference",
  "project",
  "decision",
  "task",
  "topic",
  "entity",
  "artifact"
];

const REVIEW_CATEGORY_LABEL: Record<ReviewCategory, string> = {
  communication_style: "Communication Style",
  technical_workflow: "Technical Workflow",
  product_strategy: "Product Strategy",
  scann_logic: "Scann Logic",
  ailingo_ux: "AiLingo UX",
  writing_resume_pitch: "Writing, Resume, Pitch",
  visual_design: "Visual Design",
  lookup_behavior: "Lookup Behavior",
  other: "Other"
};
const REVIEW_CATEGORY_ORDER: ReviewCategory[] = [
  "communication_style",
  "technical_workflow",
  "product_strategy",
  "scann_logic",
  "ailingo_ux",
  "writing_resume_pitch",
  "visual_design",
  "lookup_behavior",
  "other"
];
const REVIEW_RENDER_CAPS = {
  high: 5,
  medium: 3
};

export function createGraphFileDrafts(
  inputs: ConversationExtraction[],
  graph: BuiltContextGraph,
  settings: PersonalContextGraphSettings,
  agentContextProfileSummary?: string
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
    path: buildReviewQueuePath(settings.outputFolder),
    content: renderReviewQueueInbox(graph.reviewQueueItems),
    managed: true
  });

  if (settings.agentContextSections) {
    for (const section of buildAgentContextSectionDrafts(inputs, graph, settings)) {
      drafts.push(section);
    }
  } else {
    drafts.push({
      path: buildAgentContextPath(settings),
      content: renderAgentContext(inputs, graph, settings, agentContextProfileSummary),
      managed: true
    });
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
    "## Building Style",
    "- ",
    "",
    "## Product Taste",
    "- ",
    "",
    "## Recurring Projects",
    "- ",
    "",
    "## Constraints & Boundaries",
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

export function buildPrimaryAgentContextPath(
  settings: Pick<PersonalContextGraphSettings, "outputFolder" | "agentContextSections">
): string {
  if (settings.agentContextSections) {
    return joinVaultPath(settings.outputFolder, "Agent Context", "README.md");
  }
  return buildAgentContextPath(settings);
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
      pcg_source_class: graph.sourceClassesById[input.conversation.sourceId],
      pcg_managed: true,
      pcg_confidence: round(input.extraction.confidence),
      pcg_last_seen: input.conversation.updateTime || input.conversation.createTime,
      pcg_evidence_count: countLinkedNodes(linksByType),
      ...typedFrontmatter
    }),
    `# ${input.conversation.title}`,
    "",
    "## Summary",
    sanitizeRenderedMarkdownText(input.extraction.summary || "No summary extracted."),
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
    sanitizedConversationTranscript(input.conversation)
  ].join("\n");
}

function sanitizedConversationTranscript(conversation: ParsedConversation): string {
  return conversation.turns
    .map((turn) => {
      const timestamp = turn.createTime ? ` ${turn.createTime}` : "";
      const author = turn.authorName ? `/${sanitizeRenderedMarkdownText(turn.authorName)}` : "";
      return `### ${turn.role}${author}${timestamp}\n${sanitizeRenderedMarkdownText(turn.text)}`;
    })
    .join("\n\n");
}

function sanitizeRenderedMarkdownText(value: string): string {
  let sanitized = value;
  sanitized = sanitized.replace(/\[\[[\s\S]*?(?:turn\d+product|product_entity|turnProduct)[\s\S]*?\]\]/gi, (match) => {
    const labels = productLabelsFromWidget(match);
    return labels.length > 0 ? labels.join("; ") : "[product list omitted]";
  });
  sanitized = sanitized.replace(/"product_entity"\s*:\s*"[^"]*"/gi, "");
  sanitized = sanitized.replace(/\bturn\d+product\w*\b/gi, "");
  sanitized = sanitized.replace(/\bturnProduct\w*\b/gi, "");
  sanitized = sanitized.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  sanitized = sanitized.replace(/\[[0-9]+(?::[0-9]+)?\]/g, "");
  sanitized = sanitized.replace(/\[\[/g, "[\\[");
  sanitized = sanitized.replace(/\]\]/g, "\\]]");
  sanitized = sanitized.replace(/[ \t]{2,}/g, " ");
  sanitized = sanitized.replace(/\n{3,}/g, "\n\n");
  return sanitized.trim();
}

function productLabelsFromWidget(widget: string): string[] {
  const labels = new Set<string>();
  const labelPatterns = [
    /"title"\s*:\s*"([^"]+)"/gi,
    /"name"\s*:\s*"([^"]+)"/gi,
    /"label"\s*:\s*"([^"]+)"/gi
  ];

  for (const pattern of labelPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(widget)) !== null) {
      const label = match[1]
        .replace(/\\u[\dA-Fa-f]{4}/g, "")
        .replace(/\\"/g, "\"")
        .trim();
      if (label && !/^turn\d+product/i.test(label) && label !== "product_entity") {
        labels.add(label);
      }
    }
  }

  return [...labels].slice(0, 8);
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
      pcg_source_paths: uniqueStrings(sourceLinks),
      pcg_stability: node.stability,
      pcg_inference_level: node.inferenceLevel,
      pcg_applies_to: node.appliesTo || [],
      pcg_agent_instruction: node.agentInstruction
    }),
    `# ${CONTEXT_NODE_LABEL[node.type]}: ${node.label}`,
    "",
    "## Summary",
    sanitizeRenderedMarkdownText(node.summary),
    "",
    ...renderSelfModelNodeSections(node),
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

function renderSelfModelNodeSections(
  node: Pick<
    GraphNode | ReviewQueueItem,
    "agentInstruction" | "stability" | "inferenceLevel" | "appliesTo"
  >
): string[] {
  const lines: string[] = [];
  if (node.agentInstruction) {
    lines.push("## Agent Instruction");
    lines.push(sanitizeRenderedMarkdownText(node.agentInstruction));
    lines.push("");
  }

  const metadata: string[] = [];
  if (node.stability) {
    metadata.push(`- **Stability**: ${node.stability}`);
  }
  if (node.inferenceLevel) {
    metadata.push(`- **Inference level**: ${node.inferenceLevel}`);
  }
  if (node.appliesTo && node.appliesTo.length > 0) {
    metadata.push(`- **Applies to**: ${node.appliesTo.join(", ")}`);
  }

  if (metadata.length > 0) {
    lines.push("## Self-Model Metadata");
    lines.push(metadata.join("\n"));
    lines.push("");
  }

  return lines;
}

function renderReviewQueueInbox(items: ReviewQueueItem[]): string {
  const sortedItems = [...items].sort((left, right) => {
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
  const categoryGroups = groupReviewItemsByCategory(sortedItems);
  const renderedItems = categoryGroups.flatMap(([, groupedItems]) =>
    renderedReviewItemsForCategory(groupedItems)
  );
  const summarizedItems = categoryGroups.flatMap(([, groupedItems]) =>
    summarizedReviewItemsForCategory(groupedItems)
  );
  const lowPriorityItems = sortedItems.filter((item) => item.reviewPriority === "low");

  const lines = [
    yamlFrontmatter({
      pcg_type: "review_queue",
      pcg_id: "review_queue",
      pcg_source: "personal-context-graph",
      pcg_managed: true,
      pcg_review_format: "inbox_v2",
      pcg_review_item_count: sortedItems.length,
      pcg_review_group_count: renderedItems.length,
      pcg_review_summarized_group_count: summarizedItems.length,
      pcg_review_low_priority_count: lowPriorityItems.length
    }),
    "# Review Queue",
    "",
    "Optional review surface for uncertain self-model memory. Change high/medium group status to `approved` or `rejected`; leave uncertain groups as `pending`.",
    ""
  ];

  if (sortedItems.length === 0) {
    lines.push("No review items.");
    return lines.join("\n");
  }

  for (const [category, categoryItems] of categoryGroups) {
    const renderedForCategory = renderedReviewItemsForCategory(categoryItems);
    const summarizedForCategory = summarizedReviewItemsForCategory(categoryItems);
    if (renderedForCategory.length === 0 && summarizedForCategory.length === 0) {
      continue;
    }

    lines.push(`## ${REVIEW_CATEGORY_LABEL[category]}`);
    lines.push("");
    for (const item of renderedForCategory) {
      lines.push(...renderReviewQueueInboxItem(item));
      lines.push("");
    }

    if (summarizedForCategory.length > 0) {
      lines.push("### Overflow Summary");
      lines.push("");
      lines.push(renderReviewOverflowSummary(summarizedForCategory));
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

function renderReviewQueueInboxItem(item: ReviewQueueItem): string[] {
  return [
    `### Review: ${item.label}`,
    `- **ID**: \`${item.id}\``,
    `- **Status**: \`${item.status}\``,
    item.reviewPriority ? `- **Priority**: \`${item.reviewPriority}\`` : undefined,
    item.reviewCategory ? `- **Category**: \`${item.reviewCategory}\`` : undefined,
    `- **Target type**: \`${item.type}\``,
    `- **Confidence**: ${round(item.confidence)}`,
    item.variantCount && item.variantCount > 1 ? `- **Variant count**: ${item.variantCount}` : undefined,
    item.variantLabels && item.variantLabels.length > 0
      ? `- **Variant labels**: ${item.variantLabels.join("; ")}`
      : undefined,
    item.groupedSourceCount ? `- **Grouped sources**: ${item.groupedSourceCount}` : undefined,
    item.groupedEvidenceCount ? `- **Grouped evidence**: ${item.groupedEvidenceCount}` : undefined,
    item.lastSeen ? `- **Last seen**: ${item.lastSeen}` : undefined,
    item.stability ? `- **Stability**: \`${item.stability}\`` : undefined,
    item.inferenceLevel ? `- **Inference level**: \`${item.inferenceLevel}\`` : undefined,
    item.aliases.length > 0 ? `- **Aliases**: ${item.aliases.join("; ")}` : undefined,
    item.appliesTo && item.appliesTo.length > 0
      ? `- **Applies to**: ${item.appliesTo.join("; ")}`
      : undefined,
    item.sourceIds.length > 0 ? `- **Source IDs**: ${item.sourceIds.join("; ")}` : undefined,
    "",
    "#### Summary",
    sanitizeRenderedMarkdownText(item.summary),
    "",
    item.agentInstruction ? "#### Agent Instruction" : undefined,
    item.agentInstruction ? sanitizeRenderedMarkdownText(item.agentInstruction) : undefined,
    item.agentInstruction ? "" : undefined,
    "#### Evidence",
    renderEvidenceList(item.evidence)
  ].filter((line): line is string => line !== undefined);
}

function groupReviewItemsByCategory(items: ReviewQueueItem[]): Array<[ReviewCategory, ReviewQueueItem[]]> {
  const groups = new Map<ReviewCategory, ReviewQueueItem[]>();
  for (const item of items) {
    const category = item.reviewCategory || "other";
    const group = groups.get(category) || [];
    group.push(item);
    groups.set(category, group);
  }

  return REVIEW_CATEGORY_ORDER
    .map((category): [ReviewCategory, ReviewQueueItem[]] => [category, groups.get(category) || []])
    .filter(([, categoryItems]) => categoryItems.length > 0);
}

function renderedReviewItemsForCategory(items: ReviewQueueItem[]): ReviewQueueItem[] {
  const high = items.filter((item) => item.reviewPriority === "high").slice(0, REVIEW_RENDER_CAPS.high);
  const medium = items.filter((item) => item.reviewPriority === "medium").slice(0, REVIEW_RENDER_CAPS.medium);
  return [...high, ...medium].sort((left, right) => {
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
}

function summarizedReviewItemsForCategory(items: ReviewQueueItem[]): ReviewQueueItem[] {
  const high = items.filter((item) => item.reviewPriority === "high");
  const medium = items.filter((item) => item.reviewPriority === "medium");
  const low = items.filter((item) => item.reviewPriority === "low");
  return [
    ...high.slice(REVIEW_RENDER_CAPS.high),
    ...medium.slice(REVIEW_RENDER_CAPS.medium),
    ...low
  ];
}

function renderReviewOverflowSummary(items: ReviewQueueItem[]): string {
  const highCount = items.filter((item) => item.reviewPriority === "high").length;
  const mediumCount = items.filter((item) => item.reviewPriority === "medium").length;
  const lowCount = items.filter((item) => item.reviewPriority === "low").length;
  const variantCount = items.reduce((sum, item) => sum + (item.variantCount || 1), 0);
  const examples = items
    .slice(0, 6)
    .map((item) => sanitizeRenderedMarkdownText(item.label))
    .join("; ");

  return [
    `- **Hidden groups**: ${items.length} (${highCount} high, ${mediumCount} medium, ${lowCount} low).`,
    `- **Hidden variants**: ${variantCount}.`,
    examples ? `- **Examples**: ${examples}.` : undefined
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function reviewStatusRank(status: ReviewQueueItem["status"]): number {
  return {
    pending: 0,
    rejected: 1,
    approved: 2
  }[status];
}

function reviewPriorityRank(priority: ReviewQueueItem["reviewPriority"]): number {
  return {
    high: 0,
    medium: 1,
    low: 2
  }[priority || "medium"];
}

function groupReviewItemsByType(items: ReviewQueueItem[]): Array<[ContextNodeType, ReviewQueueItem[]]> {
  const groups = new Map<ContextNodeType, ReviewQueueItem[]>();
  for (const item of items) {
    const group = groups.get(item.type) || [];
    group.push(item);
    groups.set(item.type, group);
  }
  return [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0]));
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function renderReviewQueueNote(item: ReviewQueueItem): string {
  const sourceLinks = item.evidence.map((evidence) => evidence.sourcePath);
  return [
    yamlFrontmatter({
      pcg_type: "review_item",
      pcg_id: item.id,
      pcg_source: "personal-context-graph",
      pcg_managed: true,
      pcg_protected: true,
      pcg_review_status: item.status,
      pcg_target_type: item.type,
      pcg_confidence: round(item.confidence),
      pcg_last_seen: item.lastSeen,
      pcg_evidence_count: item.evidence.length,
      pcg_aliases: item.aliases,
      pcg_source_ids: item.sourceIds,
      pcg_source_paths: uniqueStrings(sourceLinks),
      pcg_stability: item.stability,
      pcg_inference_level: item.inferenceLevel,
      pcg_applies_to: item.appliesTo || [],
      pcg_agent_instruction: item.agentInstruction,
      pcg_review_priority: item.reviewPriority,
      pcg_review_category: item.reviewCategory,
      pcg_variant_labels: item.variantLabels || [],
      pcg_variant_count: item.variantCount,
      pcg_grouped_source_count: item.groupedSourceCount,
      pcg_grouped_evidence_count: item.groupedEvidenceCount
    }),
    `# Review: ${item.label}`,
    "",
    "## Review",
    `- **Status**: ${item.status}`,
    `- **Target type**: ${CONTEXT_NODE_LABEL[item.type]}`,
    "- **How to review**: Change `pcg_review_status` in frontmatter to `approved` or `rejected`.",
    "",
    "## Summary",
    sanitizeRenderedMarkdownText(item.summary),
    "",
    ...renderSelfModelNodeSections(item),
    "",
    "## Evidence",
    renderEvidenceList(item.evidence),
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
  settings: PersonalContextGraphSettings,
  agentContextProfileSummary?: string
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
    "## Identity Card",
    `${formatReference(buildIdentityPath(settings), "_Me", settings.linkAgentContextToGraph)} — protected user-owned profile note. Read this before applying inferred memory.`,
    "",
    "## Profile Summary",
    agentContextProfileSummary?.trim() || renderProfileSummary(inputs),
    "",
    ...AGENT_CONTEXT_NODE_ORDER.flatMap((type) => [
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

const SELF_MODEL_SECTION_TYPES = new Set<ContextNodeType>([
  "agent_instruction",
  "pattern",
  "principle",
  "preference",
  "decision"
]);

const AGENT_CONTEXT_SECTIONS: AgentContextSection[] = [
  {
    type: "identity",
    title: "Identity",
    fileName: "00 Identity.md",
    description: "Pointer to your protected `_Me.md` identity card."
  },
  {
    type: "agent_instruction",
    title: "Agent Instructions",
    fileName: "01 Agent Instructions.md",
    description: "Operational guidance agents should follow when helping the user."
  },
  {
    type: "pattern",
    title: "Patterns",
    fileName: "02 Patterns.md",
    description: "Recurring user behavior, thinking styles, and builder workflows."
  },
  {
    type: "principle",
    title: "Principles",
    fileName: "03 Principles.md",
    description: "Durable rules and product/building principles inferred from evidence."
  },
  {
    type: "preference",
    title: "Preferences",
    fileName: "04 Preferences.md",
    description: "Stable preferences and requirements stated or strongly evidenced by the user."
  },
  {
    type: "project",
    title: "Active Projects",
    fileName: "05 Active Projects.md",
    description: "Durable workstreams the user is actively building."
  },
  {
    type: "decision",
    title: "Decisions",
    fileName: "06 Decisions.md",
    description: "Choices the user has made or accepted, ranked by recency."
  },
  {
    type: "task",
    title: "Tasks",
    fileName: "07 Tasks.md",
    description: "Outstanding asks and follow-ups from the user."
  },
  {
    type: "topic",
    title: "Recent Topics",
    fileName: "08 Recent Topics.md",
    description: "Topics the user has been thinking about, ranked by recency."
  },
  {
    type: "entity",
    title: "Entities",
    fileName: "09 Entities.md",
    description: "Named people, products, organizations, platforms, and frameworks."
  },
  {
    type: "artifact",
    title: "Artifacts",
    fileName: "10 Artifacts.md",
    description: "Concrete deliverables and code/doc files produced or shared in conversations."
  },
  {
    type: "sources",
    title: "Source Conversations",
    fileName: "11 Sources.md",
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
  settings: Pick<PersonalContextGraphSettings, "outputFolder" | "linkAgentContextToGraph">
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
    lines.push(
      `- ${formatReference(sectionPath, section.title, settings.linkAgentContextToGraph)} — ${section.description}`
    );
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
    lines.push(`${formatReference(identityPath, "_Me", settings.linkAgentContextToGraph)} — your protected identity card. Edit there to teach agents who you are.`);
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
      const label = formatReference(path, input.conversation.title, settings.linkAgentContextToGraph);
      const dateMarker = formatDateMarker(latestInputDate(input));
      lines.push(`- ${label}${dateMarker}: ${input.extraction.summary}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  const nodes = graph.nodes
    .filter((node) => node.type === section.type)
    .sort((left, right) => {
      const selfModelDelta = selfModelRank(right) - selfModelRank(left);
      if (selfModelDelta !== 0) {
        return selfModelDelta;
      }

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
    lines.push(`### ${formatReference(node.path, node.label, settings.linkAgentContextToGraph)}${dateMarker}`);
    if (node.summary) {
      lines.push(sanitizeRenderedMarkdownText(node.summary));
    }
    if (node.agentInstruction) {
      lines.push("");
      lines.push(`**Agent instruction:** ${sanitizeRenderedMarkdownText(node.agentInstruction)}`);
    }
    if (node.appliesTo && node.appliesTo.length > 0) {
      lines.push("");
      lines.push(`**Applies to:** ${node.appliesTo.join(", ")}`);
    }
    const relatedLinks = graph.nodeLinksById[node.id] || {};
    const relatedRendered = renderTypedLinks(relatedLinks, settings.linkAgentContextToGraph);
    if (relatedRendered && !/No high-confidence/.test(relatedRendered)) {
      lines.push("");
      lines.push("**Related:**");
      lines.push(relatedRendered);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function selfModelRank(node: GraphNode): number {
  const stabilityRank = {
    stable: 4,
    recurring: 3,
    situational: 2,
    temporary: 1
  }[node.stability || "temporary"];
  const inferenceRank = node.inferenceLevel === "explicit" ? 2 : node.inferenceLevel ? 1 : 0;
  return (SELF_MODEL_SECTION_TYPES.has(node.type) ? 100 : 0) +
    stabilityRank * 10 +
    inferenceRank +
    node.evidence.length;
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
  const summaries = uniqueStrings(
    inputs
      .sort((left, right) => right.extraction.confidence - left.extraction.confidence)
      .map((input) => input.extraction.summary.trim())
      .filter(Boolean)
  )
    .slice(0, 6)
    .map((summary) => `- ${summary}`);

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
        ? ` Evidence: "${truncate(sanitizeRenderedMarkdownText(node.evidence[0].quote), 160)}"`
        : "";
      const label = useWikiLinks ? wikiLink(node.path, node.label) : `${node.label} (${node.path})`;
      return `- ${label} (${round(node.confidence)}, ${
        node.evidence.length
      } evidence item${node.evidence.length === 1 ? "" : "s"}): ${sanitizeRenderedMarkdownText(node.summary)}${evidencePreview}`;
    })
    .join("\n");
}

function renderTypedLinks(
  linksByType: Partial<Record<ContextNodeType, GraphNode[]>>,
  useWikiLinks = true
): string {
  const lines = CONTEXT_NODE_TYPES.map((type) => {
    const links = linksByType[type] || [];
    if (links.length === 0) {
      return undefined;
    }

    return `- ${CONTEXT_NODE_PLURAL_LABEL[type]}: ${links
      .map((node) => formatReference(node.path, node.label, useWikiLinks))
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
          evidence
            ? truncate(sanitizeRenderedMarkdownText(evidence.quote), 220)
            : sanitizeRenderedMarkdownText(node.summary)
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
  pattern: "patterns",
  principle: "principles",
  agent_instruction: "agentInstructions",
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
    const items = (input.extraction[EXTRACTION_ITEMS_BY_TYPE[type]] || []) as ExtractedContextItem[];
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
        `- ${sanitizeRenderedMarkdownText(item.label)} (${round(item.confidence)}): ${sanitizeRenderedMarkdownText(item.summary)}${
          evidence ? ` Evidence: "${truncate(sanitizeRenderedMarkdownText(evidence), 180)}"` : ""
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
        `- ${sanitizeRenderedMarkdownText(entry.sourceTitle)} (${entry.sourcePath}) (${round(entry.confidence)}): "${truncate(
          sanitizeRenderedMarkdownText(entry.quote),
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

function formatReference(path: string, label: string, useWikiLinks: boolean): string {
  return useWikiLinks ? wikiLink(path, label) : `${label} (${path})`;
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
