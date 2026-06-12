import { describe, expect, it } from "vitest";
import { runImport } from "../src/importPipeline";
import {
  CachedAIProvider,
  createEmptyImportCacheState,
  embeddingCacheKey,
  extractionCacheKey,
  migrateImportCacheState,
  selfModelCacheKey
} from "../src/importCache";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { AIProvider, ExtractedContext, ParsedConversation } from "../src/types";

describe("import cache", () => {
  it("migrates missing or partial cache state without breaking plugin load", () => {
    expect(migrateImportCacheState(undefined)).toEqual(createEmptyImportCacheState());
    expect(
      migrateImportCacheState({
        extraction: { cached: "entry" },
        embeddings: { vector: "entry" }
      })
    ).toMatchObject({
      version: 1,
      extraction: { cached: "entry" },
      selfModel: {},
      embeddings: { vector: "entry" },
      nodeSummaries: {},
      agentContext: {}
    });
  });

  it("keys extraction cache by transcript, model, and prompt size settings", () => {
    const settings = { ...DEFAULT_SETTINGS, extractionModel: "gpt-5.4", maxPromptChars: 36000 };
    const base = conversation("conv-key", "Cache key", "Build the graph.");

    expect(extractionCacheKey(base, settings)).not.toBe(
      extractionCacheKey(conversation("conv-key", "Cache key", "Build a different graph."), settings)
    );
    expect(extractionCacheKey(base, settings)).not.toBe(
      extractionCacheKey(base, { ...settings, extractionModel: "gpt-5.4-mini" })
    );
    expect(extractionCacheKey(base, settings)).not.toBe(
      extractionCacheKey(base, { ...settings, maxPromptChars: 12 })
    );
  });

  it("self-model cache key ignores volatile extraction timestamps", () => {
    const settings = { ...DEFAULT_SETTINGS, extractionModel: "gpt-5.4", maxPromptChars: 36000 };
    const parsed = conversation("conv-self-key", "Self key");
    const first = extraction(parsed);
    const second = {
      ...first,
      extractedAt: "2026-06-11T00:00:00.000Z"
    };
    const changedSummary = {
      ...first,
      summary: "Different base summary sent to the self-model prompt."
    };

    expect(selfModelCacheKey(parsed, first, settings)).toBe(
      selfModelCacheKey(parsed, second, settings)
    );
    expect(selfModelCacheKey(parsed, first, settings)).not.toBe(
      selfModelCacheKey(parsed, changedSummary, settings)
    );
  });

  it("reuses cached extraction, self-model, embedding, summary, and Agent Context synthesis on rerun", async () => {
    const cache = createEmptyImportCacheState();
    const counts = createCounts();
    const settings = {
      ...DEFAULT_SETTINGS,
      openAiApiKey: "test",
      costCapUsd: 10,
      minimumCanonicalSources: 1,
      synthesizeNodeSummaryMinEvidence: 1
    };
    const conversations = [conversation("conv-cache", "Cache test", "secret transcript text that should not be stored")];

    await runImport(
      conversations,
      settings,
      new CachedAIProvider(countingProvider(counts), settings, cache)
    );
    const afterFirst = { ...counts };

    const secondProvider = new CachedAIProvider(countingProvider(counts), settings, cache);
    const secondRun = await runImport(conversations, settings, secondProvider);

    expect(counts).toEqual(afterFirst);
    expect(secondProvider.getCacheStats()).toMatchObject({
      extractionHits: 1,
      selfModelHits: 1,
      agentContextHits: 1
    });
    expect(secondRun.report.cacheHitCount).toBeGreaterThan(0);
    expect(secondRun.drafts.find((draft) => draft.path.endsWith("Agent Context.md"))?.content).toContain(
      "Synthesized compact profile."
    );
    expect(JSON.stringify(cache)).not.toContain("secret transcript text that should not be stored");
  });

  it("keeps completed cached conversations after an interrupted import so rerun resumes cheaply", async () => {
    const cache = createEmptyImportCacheState();
    const counts = createCounts();
    const settings = {
      ...DEFAULT_SETTINGS,
      openAiApiKey: "test",
      costCapUsd: 10,
      minimumCanonicalSources: 1,
      synthesizeNodeSummaryMinEvidence: 1
    };
    const conversations = [
      conversation("conv-first", "First"),
      conversation("conv-second", "Second")
    ];

    await expect(
      runImport(
        conversations,
        settings,
        new CachedAIProvider(countingProvider(counts, "conv-second"), settings, cache)
      )
    ).rejects.toThrow("forced failure");

    const firstCountAfterFailure = counts.extractContext;
    await runImport(
      conversations,
      settings,
      new CachedAIProvider(countingProvider(counts), settings, cache)
    );

    expect(firstCountAfterFailure).toBe(2);
    expect(counts.extractContext).toBe(3);
  });

  it("treats malformed cached embeddings as cache misses", async () => {
    const cache = createEmptyImportCacheState();
    const counts = createCounts();
    const settings = { ...DEFAULT_SETTINGS };
    cache.embeddings[embeddingCacheKey("bad", settings.embeddingModel)] = {
      createdAt: "2026-06-10T00:00:00.000Z",
      textHash: "bad",
      model: settings.embeddingModel,
      vector: "not-a-vector" as never
    };
    const provider = new CachedAIProvider(countingProvider(counts), settings, cache);

    await provider.embedText("bad");

    expect(counts.embedText).toBe(1);
    expect(provider.getCacheStats().embeddingMisses).toBe(1);
  });
});

function createCounts(): Record<string, number> {
  return {
    extractContext: 0,
    extractSelfModel: 0,
    embedText: 0,
    synthesizeSummary: 0,
    synthesizeAgentContextProfile: 0
  };
}

function countingProvider(counts: Record<string, number>, failSourceId?: string): AIProvider {
  return {
    async extractContext(parsed): Promise<ExtractedContext> {
      counts.extractContext += 1;
      if (parsed.sourceId === failSourceId) {
        throw new Error("forced failure");
      }
      return extraction(parsed);
    },
    async extractSelfModel(): Promise<Partial<ExtractedContext>> {
      counts.extractSelfModel += 1;
      return {
        summary: "The user prefers inspectable agent memory.",
        confidence: 0.96,
        agentInstructions: [
          {
            label: "Use visible memory",
            summary: "The user wants visible, source-backed memory.",
            confidence: 0.96,
            stability: "stable",
            inferenceLevel: "explicit",
            appliesTo: ["agent memory"],
            agentInstruction: "Use visible, source-backed memory.",
            evidence: [{ quote: "Build this as an Obsidian plugin.", turnRole: "user", confidence: 0.96 }]
          }
        ]
      };
    },
    async embedText(): Promise<number[]> {
      counts.embedText += 1;
      return [1, 0, 0];
    },
    async synthesizeSummary(args): Promise<string> {
      counts.synthesizeSummary += 1;
      return `Synthesized ${args.label}.`;
    },
    async synthesizeAgentContextProfile(): Promise<string> {
      counts.synthesizeAgentContextProfile += 1;
      return "Synthesized compact profile.";
    }
  };
}

function extraction(parsed: ParsedConversation): ExtractedContext {
  return {
    sourceId: parsed.sourceId,
    conversationTitle: parsed.title,
    summary: "The user is designing an Obsidian-based personal context graph.",
    confidence: 0.95,
    topics: [
      {
        label: "Obsidian",
        summary: "Obsidian is being used as the graph UI.",
        confidence: 0.95,
        evidence: [{ quote: "Build this as an Obsidian plugin.", turnRole: "user", confidence: 0.95 }]
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
    extractedAt: "2026-06-10T00:00:00.000Z"
  };
}

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
