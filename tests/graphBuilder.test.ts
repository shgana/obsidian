import { buildContextGraph } from "../src/graphBuilder";
import { DEFAULT_SETTINGS } from "../src/settings";
import type {
  AIProvider,
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
});

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
