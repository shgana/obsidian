import { buildContextGraph } from "../src/graphBuilder";
import { DEFAULT_SETTINGS } from "../src/settings";
import type {
  AIProvider,
  CanonicalNodeSeed,
  ConversationExtraction,
  ExtractedContext,
  ParsedConversation
} from "../src/types";

const provider: AIProvider = {
  async extractContext(): Promise<ExtractedContext> {
    throw new Error("not used");
  },
  async embedText(text: string): Promise<number[]> {
    if (text.toLowerCase().includes("obsidian")) {
      return [1, 0, 0];
    }

    return [0, 1, 0];
  }
};

describe("context graph builder", () => {
  it("creates conservative typed nodes and source-to-node edges", async () => {
    const graph = await buildContextGraph(
      [
        extractionInput("conv-1", "Graph UI", "Obsidian", 0.91),
        extractionInput("conv-2", "Agent memory", "Obsidian.md", 0.88)
      ],
      DEFAULT_SETTINGS,
      provider
    );

    const topicNodes = graph.nodes.filter((node) => node.type === "topic");
    expect(topicNodes).toHaveLength(1);
    expect(topicNodes[0].sourceIds).toEqual(["conv-1", "conv-2"]);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.every((edge) => edge.edgeType === "evidence_for")).toBe(true);
  });

  it("filters low-confidence items", async () => {
    const graph = await buildContextGraph(
      [extractionInput("conv-low", "Weak note", "Speculative Topic", 0.4)],
      DEFAULT_SETTINGS,
      provider
    );

    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it("does not promote medium-confidence single-source items", async () => {
    const graph = await buildContextGraph(
      [extractionInput("conv-medium", "Medium note", "Medium Topic", 0.82)],
      DEFAULT_SETTINGS,
      provider
    );

    expect(graph.nodes).toHaveLength(0);
  });

  it("removes chunk markers from canonical labels", async () => {
    const graph = await buildContextGraph(
      [extractionInput("conv-chunk", "AI Accuracy Improvement", "AI Accuracy Improvement (chunk 2)", 0.95)],
      DEFAULT_SETTINGS,
      provider
    );

    expect(graph.nodes[0].label).toBe("AI Accuracy Improvement");
    expect(graph.nodes[0].path).not.toContain("chunk");
  });

  it("adds typed related context links from projects", async () => {
    const input = extractionInput("conv-project", "Project note", "Obsidian", 0.95);
    input.extraction.projects = [
      {
        label: "Personal context graph",
        summary: "A project to build a context graph.",
        confidence: 0.95,
        evidence: [
          {
            quote: "Build a personal context graph.",
            turnRole: "user",
            confidence: 0.95
          }
        ]
      }
    ];
    input.extraction.tasks = [
      {
        label: "Import ChatGPT data",
        summary: "Import ChatGPT data into Obsidian.",
        confidence: 0.94,
        evidence: [
          {
            quote: "Import ChatGPT data.",
            turnRole: "user",
            confidence: 0.94
          }
        ]
      }
    ];

    const graph = await buildContextGraph([input], DEFAULT_SETTINGS, provider);
    const project = graph.nodes.find((node) => node.type === "project");

    expect(project).toBeDefined();
    expect(graph.nodeLinksById[project!.id].task?.[0].label).toBe("Import ChatGPT data");
    expect(graph.edges.every((edge) => edge.edgeType === "evidence_for")).toBe(true);
  });

  it("absorbs medium-confidence items into existing seeded canonical nodes", async () => {
    const seed: CanonicalNodeSeed = {
      type: "topic",
      id: "topic_obsidian",
      label: "Obsidian",
      slug: "obsidian",
      aliases: [],
      path: "Context Graph/Topics/Obsidian.md",
      summary: "Obsidian is the graph UI.",
      confidence: 0.94,
      evidence: [],
      sourceIds: ["seed-source"]
    };

    const graph = await buildContextGraph(
      [extractionInput("conv-medium", "Medium note", "Obsidian.md", 0.82)],
      DEFAULT_SETTINGS,
      provider,
      [seed]
    );

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].label).toBe("Obsidian");
    expect(graph.nodes[0].aliases).toContain("Obsidian.md");
    expect(graph.nodes[0].sourceIds).toContain("conv-medium");
    expect(graph.stats.mergedCandidates).toBe(1);
  });

  it("promotes repeated medium-confidence clusters but keeps single medium items source-only", async () => {
    const repeatedGraph = await buildContextGraph(
      [
        extractionInput("conv-a", "A", "Semantic topic", 0.82),
        extractionInput("conv-b", "B", "Semantic topic", 0.81)
      ],
      DEFAULT_SETTINGS,
      provider
    );
    const singleGraph = await buildContextGraph(
      [extractionInput("conv-c", "C", "One-off topic", 0.82)],
      DEFAULT_SETTINGS,
      provider
    );

    expect(repeatedGraph.nodes).toHaveLength(1);
    expect(repeatedGraph.nodes[0].sourceIds).toEqual(["conv-a", "conv-b"]);
    expect(singleGraph.nodes).toHaveLength(0);
    expect(singleGraph.stats.sourceOnlyCandidates).toBe(1);
  });

  it("prunes duplicate seeded canonical nodes by merging aliases and evidence", async () => {
    const seeds: CanonicalNodeSeed[] = [
      seed("topic", "AI scan evaluation", 0.92, ["conv-1"]),
      seed("topic", "AI scan evaluation", 0.95, ["conv-2"])
    ];

    const graph = await buildContextGraph([], DEFAULT_SETTINGS, provider, seeds);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].confidence).toBe(0.95);
    expect(graph.nodes[0].sourceIds.sort()).toEqual(["conv-1", "conv-2"]);
    expect(graph.stats.seededNodes).toBe(1);
    expect(graph.stats.prunedDuplicateNodes).toBe(1);
  });

  it("caps visible source links per type", async () => {
    const input = extractionInput("conv-many", "Many topics", "Topic 0", 0.96);
    input.extraction.topics = Array.from({ length: 5 }, (_, index) => ({
      label: `Topic ${index}`,
      summary: `Topic ${index} summary.`,
      confidence: 0.98 - index * 0.005,
      evidence: [
        {
          quote: `Topic ${index} evidence.`,
          turnRole: "user",
          confidence: 0.98 - index * 0.005
        }
      ]
    }));

    const graph = await buildContextGraph(
      [input],
      { ...DEFAULT_SETTINGS, maxSourceLinksPerType: 2 },
      {
        ...provider,
        async embedText(text: string): Promise<number[]> {
          const index = Number.parseInt(/Topic (\d)/.exec(text)?.[1] || "0", 10);
          return Array.from({ length: 5 }, (_, vectorIndex) => (vectorIndex === index ? 1 : 0));
        }
      }
    );

    expect(graph.nodes).toHaveLength(5);
    expect(graph.sourceLinksById["conv-many"].topic).toHaveLength(2);
    expect(graph.stats.sourceOnlyCandidates).toBe(3);
  });
});

function seed(
  type: CanonicalNodeSeed["type"],
  label: string,
  confidence: number,
  sourceIds: string[]
): CanonicalNodeSeed {
  return {
    type,
    id: `${type}_${label.toLowerCase().replace(/\s+/g, "-")}`,
    label,
    slug: label.toLowerCase().replace(/\s+/g, "-"),
    aliases: [],
    path: `Context Graph/Topics/${label}.md`,
    summary: `${label} summary.`,
    confidence,
    evidence: sourceIds.map((sourceId) => ({
      sourceId,
      sourceTitle: sourceId,
      sourcePath: `Context Graph/Sources/ChatGPT/${sourceId}.md`,
      quote: `${label} evidence ${sourceId}`,
      confidence
    })),
    sourceIds
  };
}

function extractionInput(
  sourceId: string,
  title: string,
  topicLabel: string,
  confidence: number
): ConversationExtraction {
  const conversation: ParsedConversation = {
    source: "chatgpt",
    sourceId,
    title,
    turns: [
      {
        id: `${sourceId}-turn`,
        role: "user",
        text: `Let's use ${topicLabel} for agent memory.`
      }
    ],
    rawMessageCount: 1
  };

  return {
    conversation,
    extraction: {
      sourceId,
      conversationTitle: title,
      summary: `Discussion about ${topicLabel}.`,
      confidence,
      topics: [
        {
          label: topicLabel,
          summary: `${topicLabel} is relevant to the user's graph UI work.`,
          confidence,
          evidence: [
            {
              quote: `Let's use ${topicLabel} for agent memory.`,
              turnRole: "user",
              confidence
            }
          ]
        }
      ],
      entities: [],
      projects: [],
      preferences: [],
      decisions: [],
      tasks: [],
      artifacts: [],
      stylePatterns: [],
      extractedAt: "2026-05-06T00:00:00.000Z"
    }
  };
}
