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

    const explicitOnlyPreview = createImportPreview(
      "test.zip",
      [conversation("conv-cost", "Cost test", "x".repeat(4000))],
      {
        ...DEFAULT_SETTINGS,
        extractionModel: "gpt-5.4",
        embeddingModel: "text-embedding-3-large",
        enableSelfModelExtraction: false
      }
    );
    expect(preview.estimatedExtractionOutputTokens).toBeGreaterThan(
      explicitOnlyPreview.estimatedExtractionOutputTokens
    );
  });

  it("emits a protected identity stub once and never overwrites it", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      openAiApiKey: "test",
      costCapUsd: 10,
      outputFolder: "Context Graph",
      minimumCanonicalSources: 1,
      agentContextSections: true
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
      minimumCanonicalSources: 1,
      agentContextSections: true
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
      agentContextSections: true,
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

    const agentContext = artifacts.drafts.find(
      (draft) => draft.path === "Context Graph/Agent Context.md"
    );

    expect(agentContext?.content.indexOf("## Identity Card")).toBeLessThan(
      agentContext?.content.indexOf("## Profile Summary") || Number.MAX_SAFE_INTEGER
    );
    expect(agentContext?.content.indexOf("## Profile Summary")).toBeLessThan(
      agentContext?.content.indexOf("## Agent Instructions") || Number.MAX_SAFE_INTEGER
    );
    expect(agentContext?.content.indexOf("## Agent Instructions")).toBeLessThan(
      agentContext?.content.indexOf("## Patterns") || Number.MAX_SAFE_INTEGER
    );
    expect(agentContext?.content.indexOf("## Patterns")).toBeLessThan(
      agentContext?.content.indexOf("## Projects") || Number.MAX_SAFE_INTEGER
    );
    expect(agentContext?.content.indexOf("## Projects")).toBeLessThan(
      agentContext?.content.indexOf("## Topics") || Number.MAX_SAFE_INTEGER
    );
    expect(agentContext?.content).toContain("_Me (Context Graph/Entities/_Me.md)");
    expect(agentContext?.content).toContain("Use inspectable Markdown memory");
    expect(agentContext?.content).toContain("visible, source-backed Markdown context");
    expect(agentContext?.content).toContain("Obsidian");
    expect(artifacts.report.canonicalSelfModelNodeCount).toBe(1);
  });

  it("reports chunk-aware extraction progress for long conversations", async () => {
    const progressEvents: Array<{
      completed: number;
      total: number;
      completedChunks?: number;
      totalChunks?: number;
      message: string;
    }> = [];
    const longConversation: ParsedConversation = {
      source: "chatgpt",
      sourceId: "conv-long",
      title: "Long import",
      turns: Array.from({ length: 4 }, (_, index) => ({
        id: `turn-${index}`,
        role: "user" as const,
        text: `Build this as an Obsidian plugin ${index}. ${"x".repeat(90)}`
      })),
      rawMessageCount: 4
    };

    await runImport(
      [longConversation],
      {
        ...DEFAULT_SETTINGS,
        openAiApiKey: "test",
        costCapUsd: 10,
        outputFolder: "Context Graph",
        minimumCanonicalSources: 1,
        maxPromptChars: 180
      },
      mockProvider,
      (progress) => progressEvents.push(progress)
    );

    const lastProgress = progressEvents[progressEvents.length - 1];
    expect(progressEvents.some((event) => (event.totalChunks || 0) > 1)).toBe(true);
    expect(progressEvents.some((event) => event.message.includes("chunk 1/"))).toBe(true);
    expect(lastProgress.completedChunks).toBe(lastProgress.totalChunks);
  });

  it("renders source notes, typed nodes, and a single default agent context", async () => {
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
    expect(artifacts.drafts.some((draft) => draft.path === "Context Graph/Agent Context.md")).toBe(true);
    expect(artifacts.drafts.some((draft) => draft.path === "Context Graph/Agent Context/README.md")).toBe(false);
    expect(artifacts.drafts.some((draft) => draft.path.includes("/Topics/"))).toBe(true);

    const sourceDraft = artifacts.drafts.find((draft) => draft.path.includes("/Sources/ChatGPT/"));
    expect(sourceDraft?.content).toContain("pcg_managed: true");
    expect(sourceDraft?.content).toContain("pcg_topics:");
    expect(sourceDraft?.content).toContain("  - \"topic_obsidian\"");
    expect(sourceDraft?.content).toContain("[[Context Graph/Topics/Obsidian|Obsidian]]");

    const agentContext = artifacts.drafts.find(
      (draft) => draft.path === "Context Graph/Agent Context.md"
    );
    expect(agentContext?.content).toContain("Obsidian (Context Graph/Topics/Obsidian.md)");
    expect(artifacts.drafts.some((draft) => draft.path === "Context Graph/Review Queue.md")).toBe(true);
    expect(artifacts.report.agentContextPath).toBe("Context Graph/Agent Context.md");
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
    expect(inbox?.content).toContain("- **Priority**: `medium`");
    expect(inbox?.content).not.toContain("[[");
    expect(artifacts.report.reviewQueueItemCount).toBe(1);
    expect(artifacts.report.reviewQueueGroupCount).toBe(1);
  });

  it("summarizes low-priority review candidates instead of rendering review chores", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      openAiApiKey: "test",
      costCapUsd: 10,
      outputFolder: "Context Graph"
    };

    const artifacts = await runImport(
      [conversation("conv-low-review", "Low review test")],
      settings,
      lowPriorityReviewProvider
    );
    const inbox = artifacts.drafts.find((draft) => draft.path === "Context Graph/Review Queue.md");

    expect(inbox?.content).toContain("## Low Priority Summary");
    expect(inbox?.content).not.toContain("### Review: Product lookup response style");
    expect(artifacts.report.reviewQueueItemCount).toBe(1);
    expect(artifacts.report.reviewQueueGroupCount).toBe(0);
    expect(artifacts.report.reviewQueueSummarizedCandidateCount).toBe(1);
  });

  it("still emits sectioned Agent Context files when explicitly enabled", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      openAiApiKey: "test",
      costCapUsd: 10,
      outputFolder: "Context Graph",
      minimumCanonicalSources: 1,
      agentContextSections: true
    };

    const artifacts = await runImport(
      [conversation("conv-legacy", "Obsidian agent graph")],
      settings,
      mockProvider
    );

    expect(artifacts.drafts.some((draft) => draft.path === "Context Graph/Agent Context.md")).toBe(false);
    expect(artifacts.drafts.some((draft) => draft.path === "Context Graph/Agent Context/README.md")).toBe(true);

    const topicSection = artifacts.drafts.find((draft) => draft.path.endsWith("Agent Context/08 Recent Topics.md"));
    expect(topicSection?.content).toContain("Obsidian (Context Graph/Topics/Obsidian.md)");
    expect(topicSection?.content).not.toContain("[[Context Graph/Topics/Obsidian|Obsidian]]");
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

  it("records actual usage and cost in the import report when provider usage is available", async () => {
    const provider: AIProvider = {
      ...mockProvider,
      getUsageEvents() {
        return [
          {
            phase: "context_extraction",
            model: "gpt-5.4",
            inputTokens: 1000,
            outputTokens: 200,
            totalTokens: 1200,
            cached: false
          },
          {
            phase: "embedding",
            model: "text-embedding-3-large",
            embeddingTokens: 300,
            totalTokens: 300,
            cached: false
          }
        ];
      }
    };

    const artifacts = await runImport(
      [conversation("conv-usage", "Usage report")],
      {
        ...DEFAULT_SETTINGS,
        openAiApiKey: "test",
        costCapUsd: 10,
        outputFolder: "Context Graph",
        minimumCanonicalSources: 1,
        synthesizeNodeSummaries: false,
        synthesizeAgentContextProfile: false
      },
      provider
    );

    expect(artifacts.report.actualInputTokens).toBe(1000);
    expect(artifacts.report.actualOutputTokens).toBe(200);
    expect(artifacts.report.actualEmbeddingTokens).toBe(300);
    expect(artifacts.report.actualCostUsd).toBeGreaterThan(0);
    expect(artifacts.report.apiUsageByPhase?.context_extraction?.calls).toBe(1);
    expect(artifacts.report.apiUsageByPhase?.embedding?.calls).toBe(1);
  });

  it("falls back to deterministic Agent Context summary when global synthesis fails", async () => {
    const provider: AIProvider = {
      ...mockProvider,
      async synthesizeAgentContextProfile(): Promise<string> {
        throw new Error("profile synthesis unavailable");
      }
    };

    const artifacts = await runImport(
      [conversation("conv-agent-fallback", "Agent fallback")],
      {
        ...DEFAULT_SETTINGS,
        openAiApiKey: "test",
        costCapUsd: 10,
        outputFolder: "Context Graph",
        minimumCanonicalSources: 1
      },
      provider
    );

    const agentContext = artifacts.drafts.find(
      (draft) => draft.path === "Context Graph/Agent Context.md"
    );
    expect(agentContext?.content).toContain(
      "The user is designing an Obsidian-based personal context graph."
    );
    expect(
      artifacts.report.warnings.some((warning) =>
        warning.includes("Agent Context synthesis fell back")
      )
    ).toBe(true);
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
          confidence: 0.82,
          stability: "recurring",
          inferenceLevel: "supported_inference",
          appliesTo: ["product design", "onboarding"],
          agentInstruction: "Translate proven app mechanics into concrete flow decisions.",
          evidence: [
            {
              quote: "I like Duolingo's lesson-first onboarding better.",
              turnRole: "user",
              confidence: 0.82
            }
          ]
        }
      ]
    };
  }
};

const lowPriorityReviewProvider: AIProvider = {
  ...reviewQueueProvider,
  async extractSelfModel(): Promise<Partial<ExtractedContext>> {
    return {
      summary: "The user made a one-off product lookup request.",
      confidence: 0.74,
      agentInstructions: [
        {
          label: "Product lookup response style",
          summary: "The user may want product lookup responses to be direct and setup-oriented.",
          confidence: 0.74,
          stability: "situational",
          inferenceLevel: "supported_inference",
          appliesTo: ["product lookup"],
          agentInstruction: "Answer terse product lookup requests with direct setup guidance.",
          evidence: [
            {
              quote: "github copilot in xcode",
              turnRole: "user",
              confidence: 0.74
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
