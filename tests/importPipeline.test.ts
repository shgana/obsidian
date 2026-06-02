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

  it("emits a protected identity stub once and never overwrites it", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      openAiApiKey: "test",
      costCapUsd: 10,
      outputFolder: "Context Graph",
      minimumCanonicalSources: 1
    };

    const artifacts = await runImport(
      [conversation("conv-id", "Identity test")],
      settings,
      mockProvider
    );

    const identity = artifacts.drafts.find((draft) => draft.path.endsWith("Entities/_Me.md"));
    expect(identity).toBeDefined();
    expect(identity!.createOnly).toBe(true);
    expect(identity!.content).toContain("pcg_protected: true");
    expect(identity!.content).toContain("# Me");
  });

  it("emits sectioned Agent Context files when agentContextSections is enabled", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      openAiApiKey: "test",
      costCapUsd: 10,
      outputFolder: "Context Graph",
      minimumCanonicalSources: 1
    };

    const artifacts = await runImport(
      [conversation("conv-sect", "Section test")],
      settings,
      mockProvider
    );

    const readme = artifacts.drafts.find(
      (draft) => draft.path === "Context Graph/Agent Context/README.md"
    );
    const identitySection = artifacts.drafts.find(
      (draft) => draft.path.endsWith("Agent Context/00 Identity.md")
    );
    const topicsSection = artifacts.drafts.find(
      (draft) => draft.path.endsWith("Agent Context/08 Recent Topics.md")
    );

    expect(readme?.content).toContain("Sectioned retrieval surface");
    expect(readme?.content).not.toContain("[[");
    expect(identitySection?.content).toContain("_Me (Context Graph/Entities/_Me.md)");
    expect(topicsSection?.content).toContain("Obsidian");
    expect(topicsSection?.content).toContain("Obsidian (Context Graph/Topics/Obsidian.md)");
    expect(topicsSection?.content).not.toContain("[[Context Graph/Topics/Obsidian|Obsidian]]");
  });

  it("can explicitly link sectioned Agent Context into the graph", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      openAiApiKey: "test",
      costCapUsd: 10,
      outputFolder: "Context Graph",
      minimumCanonicalSources: 1,
      linkAgentContextToGraph: true
    };

    const artifacts = await runImport(
      [conversation("conv-sect-links", "Section link test")],
      settings,
      mockProvider
    );

    const readme = artifacts.drafts.find(
      (draft) => draft.path === "Context Graph/Agent Context/README.md"
    );
    const topicsSection = artifacts.drafts.find(
      (draft) => draft.path.endsWith("Agent Context/08 Recent Topics.md")
    );

    expect(readme?.content).toContain("[[Context Graph/Agent Context/01 Agent Instructions|Agent Instructions]]");
    expect(topicsSection?.content).toContain("[[Context Graph/Topics/Obsidian|Obsidian]]");
  });

  it("runs self-model extraction and prioritizes agent instructions before topic context", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      openAiApiKey: "test",
      costCapUsd: 10,
      outputFolder: "Context Graph",
      minimumCanonicalSources: 1
    };

    const artifacts = await runImport(
      [conversation("conv-self-model", "Self model test")],
      settings,
      selfModelProvider
    );

    const readme = artifacts.drafts.find(
      (draft) => draft.path === "Context Graph/Agent Context/README.md"
    );
    const agentInstructionSection = artifacts.drafts.find(
      (draft) => draft.path === "Context Graph/Agent Context/01 Agent Instructions.md"
    );
    const topicSection = artifacts.drafts.find(
      (draft) => draft.path === "Context Graph/Agent Context/08 Recent Topics.md"
    );

    expect(readme?.content.indexOf("01 Agent Instructions")).toBeLessThan(
      readme?.content.indexOf("08 Recent Topics") || Number.MAX_SAFE_INTEGER
    );
    expect(agentInstructionSection?.content).toContain("Use inspectable Markdown memory");
    expect(agentInstructionSection?.content).toContain("**Agent instruction:** Prefer visible, source-backed Markdown context over hidden memory.");
    expect(topicSection?.content).toContain("Obsidian");
    expect(artifacts.report.canonicalSelfModelNodeCount).toBe(1);
  });

  it("renders source notes, typed nodes, and a sectioned agent context", async () => {
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
    expect(artifacts.drafts.some((draft) => draft.path.endsWith("Agent Context.md"))).toBe(false);
    expect(artifacts.drafts.some((draft) => draft.path === "Context Graph/Agent Context/README.md")).toBe(true);
    expect(artifacts.drafts.some((draft) => draft.path.includes("/Topics/"))).toBe(true);

    const sourceDraft = artifacts.drafts.find((draft) => draft.path.includes("/Sources/ChatGPT/"));
    expect(sourceDraft?.content).toContain("pcg_managed: true");
    expect(sourceDraft?.content).toContain("pcg_topics:");
    expect(sourceDraft?.content).toContain("  - \"topic_obsidian\"");
    expect(sourceDraft?.content).toContain("[[Context Graph/Topics/Obsidian|Obsidian]]");

    const topicsSection = artifacts.drafts.find(
      (draft) => draft.path === "Context Graph/Agent Context/08 Recent Topics.md"
    );
    expect(topicsSection?.content).toContain("Obsidian (Context Graph/Topics/Obsidian.md)");
    expect(artifacts.drafts.some((draft) => draft.path === "Context Graph/Review Queue.md")).toBe(true);
    expect(artifacts.report.agentContextPath).toBe("Context Graph/Agent Context/README.md");
    expect(artifacts.checkpoint.sourceManifest).toHaveLength(1);
    expect("conversations" in artifacts.checkpoint).toBe(false);
  });

  it("renders review candidates into a single Review Queue inbox note", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      openAiApiKey: "test",
      costCapUsd: 10,
      outputFolder: "Context Graph"
    };

    const artifacts = await runImport(
      [conversation("conv-review-inbox", "Review inbox test")],
      settings,
      reviewQueueProvider
    );

    const reviewDrafts = artifacts.drafts.filter((draft) => draft.path.includes("Review Queue"));
    const inbox = artifacts.drafts.find((draft) => draft.path === "Context Graph/Review Queue.md");

    expect(reviewDrafts).toHaveLength(1);
    expect(inbox?.content).toContain('pcg_type: "review_queue"');
    expect(inbox?.content).toContain("### Review: Reference-driven UX design");
    expect(inbox?.content).toContain("- **Status**: `pending`");
    expect(inbox?.content).not.toContain("[[");
    expect(artifacts.report.reviewQueueItemCount).toBe(1);
  });

  it("still emits a legacy Agent Context.md when sectioned mode is disabled", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      openAiApiKey: "test",
      costCapUsd: 10,
      outputFolder: "Context Graph",
      minimumCanonicalSources: 1,
      agentContextSections: false
    };

    const artifacts = await runImport(
      [conversation("conv-legacy", "Obsidian agent graph")],
      settings,
      mockProvider
    );

    expect(artifacts.drafts.some((draft) => draft.path === "Context Graph/Agent Context.md")).toBe(true);
    expect(artifacts.drafts.some((draft) => draft.path === "Context Graph/Agent Context/README.md")).toBe(false);

    const agentDraft = artifacts.drafts.find((draft) => draft.path.endsWith("Agent Context.md"));
    expect(agentDraft?.content).toContain("Obsidian (Context Graph/Topics/Obsidian.md)");
    expect(agentDraft?.content).not.toContain("[[Context Graph/Topics/Obsidian|Obsidian]]");
  });

  it("renders source-only context for transactional conversations without promoting filler entities", async () => {
    const artifacts = await runImport(
      [conversation("conv-residency", "Greetings exchange", "Are you familiar with The Residency?")],
      {
        ...DEFAULT_SETTINGS,
        openAiApiKey: "test",
        costCapUsd: 10,
        outputFolder: "Context Graph"
      },
      residencyProvider
    );

    const sourceDraft = artifacts.drafts.find((draft) => draft.path.includes("/Sources/ChatGPT/"));

    expect(artifacts.report.sourceAnchorFallbackCount).toBe(0);
    expect(sourceDraft?.content).toContain("Chalice Chat AI interview");
    expect(
      artifacts.drafts.some((draft) => draft.path === "Context Graph/Entities/The Residency.md")
    ).toBe(false);
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
      patterns: [],
      principles: [],
      agentInstructions: [],
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
  },
  async synthesizeSummary(): Promise<string> {
    return "";
  }
};

const selfModelProvider: AIProvider = {
  ...mockProvider,
  async extractSelfModel(): Promise<Partial<ExtractedContext>> {
    return {
      summary: "The user wants source-backed agent memory.",
      confidence: 0.96,
      agentInstructions: [
        {
          label: "Use inspectable Markdown memory",
          summary: "The user wants agents to rely on visible, source-backed Markdown context.",
          confidence: 0.96,
          stability: "stable",
          inferenceLevel: "explicit",
          appliesTo: ["agent memory", "Obsidian"],
          agentInstruction: "Prefer visible, source-backed Markdown context over hidden memory.",
          evidence: [
            {
              quote: "Build this as an Obsidian plugin.",
              turnRole: "user",
              confidence: 0.96
            }
          ]
        }
      ]
    };
  }
};

const reviewQueueProvider: AIProvider = {
  ...mockProvider,
  async extractContext(conversation): Promise<ExtractedContext> {
    const extraction = await mockProvider.extractContext(conversation);
    return {
      ...extraction,
      topics: [],
      confidence: 0.8
    };
  },
  async extractSelfModel(): Promise<Partial<ExtractedContext>> {
    return {
      summary: "The user uses proven consumer apps as UX references.",
      confidence: 0.8,
      patterns: [
        {
          label: "Reference-driven UX design",
          summary: "The user draws UX mechanics from proven consumer apps.",
          confidence: 0.78,
          stability: "recurring",
          inferenceLevel: "supported_inference",
          appliesTo: ["product design", "onboarding"],
          agentInstruction: "Translate proven app mechanics into concrete flow decisions.",
          evidence: [
            {
              quote: "I like Duolingo's lesson-first onboarding better.",
              turnRole: "user",
              confidence: 0.78
            }
          ]
        }
      ]
    };
  }
};

const residencyProvider: AIProvider = {
  async extractContext(conversation): Promise<ExtractedContext> {
    return {
      sourceId: conversation.sourceId,
      conversationTitle: conversation.title,
      summary: "The user asked about The Residency and preparation for its AI interview process.",
      confidence: 0.68,
      topics: [
        {
          label: "Chalice Chat AI interview",
          summary: "The user wanted tips for a Chalice Chat AI interview.",
          confidence: 0.71,
          evidence: [
            {
              quote: "can you search tips on the Chalice Chat from the residency",
              turnRole: "user",
              confidence: 0.71
            }
          ]
        }
      ],
      entities: [
        {
          label: "The Residency",
          summary: "A startup incubator program discussed by the user.",
          confidence: 0.76,
          evidence: [
            {
              quote: "the startup incubator program called the Residency",
              turnRole: "user",
              confidence: 0.76
            }
          ]
        }
      ],
      projects: [],
      patterns: [],
      principles: [],
      agentInstructions: [],
      preferences: [],
      decisions: [],
      tasks: [],
      artifacts: [],
      stylePatterns: [],
      extractedAt: "2026-05-09T00:00:00.000Z"
    };
  },
  async embedText(): Promise<number[]> {
    return [1, 0, 0];
  },
  async synthesizeSummary(): Promise<string> {
    return "";
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
