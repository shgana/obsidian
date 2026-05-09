import { createImportPreview, runImport } from "../src/importPipeline";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { AIProvider, ExtractedContext, ParsedConversation } from "../src/types";

describe("import pipeline", () => {
  it("estimates API cost with model-aware input, output, and embedding charges", () => {
    const preview = createImportPreview(
      "test.zip",
      [conversation("conv-cost", "Cost test", "x".repeat(4000))],
      {
        ...DEFAULT_SETTINGS,
        extractionModel: "gpt-5.4",
        embeddingModel: "text-embedding-3-large"
      }
    );

    expect(preview.estimatedTokens).toBeGreaterThanOrEqual(1000);
    expect(preview.estimatedExtractionInputTokens).toBeGreaterThan(preview.estimatedTokens);
    expect(preview.estimatedExtractionOutputTokens).toBeGreaterThan(0);
    expect(preview.estimatedEmbeddingTokens).toBeGreaterThan(0);
    expect(preview.estimatedExtractionCostUsd).toBeGreaterThan(0);
    expect(preview.estimatedEmbeddingCostUsd).toBeGreaterThan(0);
    expect(preview.estimatedCostUsd).toBeCloseTo(
      preview.estimatedExtractionCostUsd + preview.estimatedEmbeddingCostUsd,
      8
    );
  });

  it("renders source notes, typed nodes, and agent context drafts", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      openAiApiKey: "test",
      costCapUsd: 10,
      outputFolder: "Context Graph",
      minimumCanonicalSources: 1
    };

    const artifacts = await runImport(
      [conversation("conv-1", "Obsidian agent graph")],
      settings,
      mockProvider
    );

    expect(artifacts.report.processedConversationCount).toBe(1);
    expect(artifacts.drafts.every((draft) => draft.path.startsWith("Context Graph/"))).toBe(true);
    expect(artifacts.drafts.some((draft) => draft.path.endsWith("Agent Context.md"))).toBe(true);
    expect(artifacts.drafts.some((draft) => draft.path.includes("/Topics/"))).toBe(true);

    const sourceDraft = artifacts.drafts.find((draft) => draft.path.includes("/Sources/ChatGPT/"));
    expect(sourceDraft?.content).toContain("pcg_managed: true");
    expect(sourceDraft?.content).toContain("pcg_topics:");
    expect(sourceDraft?.content).toContain("  - \"topic_obsidian\"");
    expect(sourceDraft?.content).toContain("[[Context Graph/Topics/Obsidian|Obsidian]]");

    const agentDraft = artifacts.drafts.find((draft) => draft.path.endsWith("Agent Context.md"));
    expect(agentDraft?.content).toContain("Obsidian (Context Graph/Topics/Obsidian.md)");
    expect(agentDraft?.content).not.toContain("[[Context Graph/Topics/Obsidian|Obsidian]]");
    expect(artifacts.checkpoint.sourceManifest).toHaveLength(1);
    expect("conversations" in artifacts.checkpoint).toBe(false);
  });

  it("enforces cost caps before provider extraction", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      openAiApiKey: "test",
      costCapUsd: 0.000001,
      estimatedExtractionCostPer1MInputTokensUsd: 100
    };
    const provider: AIProvider = {
      ...mockProvider,
      async extractContext(): Promise<ExtractedContext> {
        throw new Error("provider should not be called");
      }
    };

    await expect(
      runImport([conversation("conv-big", "Big", "x".repeat(5000))], settings, provider)
    ).rejects.toThrow(/exceeds the configured cap/);
  });
});

const mockProvider: AIProvider = {
  async extractContext(conversation): Promise<ExtractedContext> {
    return {
      sourceId: conversation.sourceId,
      conversationTitle: conversation.title,
      summary: "The user is designing an Obsidian-based personal context graph.",
      confidence: 0.95,
      topics: [
        {
          label: "Obsidian",
          summary: "Obsidian is being used as the human-readable graph UI.",
          confidence: 0.95,
          evidence: [
            {
              quote: "Build this as an Obsidian plugin.",
              turnRole: "user",
              confidence: 0.95
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
    };
  },
  async embedText(): Promise<number[]> {
    return [1, 0, 0];
  }
};

function conversation(sourceId: string, title: string, body = "Build this as an Obsidian plugin."): ParsedConversation {
  return {
    source: "chatgpt",
    sourceId,
    title,
    turns: [
      {
        id: `${sourceId}-1`,
        role: "user",
        text: body
      }
    ],
    rawMessageCount: 1
  };
}
