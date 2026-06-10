import { describe, expect, it } from "vitest";
import { MockElement } from "./mocks/obsidian";
import { renderImportStatus, renderReport } from "../src/dashboardView";
import type { ImportCheckpoint, ImportRunState } from "../src/types";

describe("dashboard import status", () => {
  it("shows a neutral message when no import attempt is recorded", () => {
    const container = new MockElement("div");

    renderImportStatus(container as never, undefined);

    expect(allText(container)).toContain("Import Status");
    expect(allText(container)).toContain("No import attempt recorded.");
  });

  it("shows failed phase, error, and stale checkpoint warning", () => {
    const container = new MockElement("div");
    const state: ImportRunState = {
      lastImportStartedAt: "2026-06-04T12:00:00.000Z",
      lastImportUpdatedAt: "2026-06-04T12:01:00.000Z",
      lastImportPhase: "extracting",
      lastImportStatus: "failed",
      lastImportError: "OpenAI request failed",
      lastImportErrorAt: "2026-06-04T12:01:00.000Z",
      lastImportFileName: "export.zip",
      lastImportSelectedConversations: 20,
      lastImportTotalConversations: 300,
      lastImportProgressMessage: "Extracting context from Posture Scoring Method",
      lastImportProgressCompleted: 0,
      lastImportProgressTotal: 20
    };

    renderImportStatus(container as never, state, checkpoint("2026-05-31T00:11:54.384Z"));

    const text = allText(container);
    expect(text).toContain("Status: failed");
    expect(text).toContain("Phase: extracting");
    expect(text).toContain("File: export.zip");
    expect(text).toContain("Conversations: 20 selected of 300");
    expect(text).toContain("Progress: Extracting context from Posture Scoring Method (0/20)");
    expect(text).toContain("Last updated: 2026-06-04T12:01:00.000Z");
    expect(text).toContain("Last error: OpenAI request failed");
    expect(text).toContain("latest import attempt is newer than the saved checkpoint");
  });

  it("shows succeeded metadata without stale warning", () => {
    const container = new MockElement("div");

    renderImportStatus(container as never, {
      lastImportStartedAt: "2026-06-04T12:00:00.000Z",
      lastImportCompletedAt: "2026-06-04T12:03:00.000Z",
      lastImportPhase: "completed",
      lastImportStatus: "succeeded",
      lastImportSelectedConversations: 20,
      lastImportTotalConversations: 300
    }, checkpoint("2026-06-04T12:03:00.000Z"));

    const text = allText(container);
    expect(text).toContain("Status: succeeded");
    expect(text).toContain("Completed: 2026-06-04T12:03:00.000Z");
    expect(text).not.toContain("latest import attempt is newer than the saved checkpoint");
  });
});

describe("dashboard import report", () => {
  it("shows actual usage and cache metadata when available", () => {
    const container = new MockElement("div");
    const report = checkpoint("2026-06-04T12:03:00.000Z").report;
    report.processedConversationCount = 20;
    report.estimatedCostUsd = 1.5;
    report.actualCostUsd = 0.12;
    report.actualInputTokens = 1000;
    report.actualOutputTokens = 200;
    report.actualEmbeddingTokens = 300;
    report.actualTotalTokens = 1500;
    report.cacheHitCount = 40;
    report.cacheMissCount = 5;
    report.apiUsageByPhase = {
      context_extraction: {
        calls: 2,
        cacheHits: 18,
        cacheMisses: 2,
        inputTokens: 1000,
        outputTokens: 200,
        embeddingTokens: 0,
        totalTokens: 1200,
        estimatedCostUsd: 0.1
      }
    };

    renderReport(container as never, report);

    const text = allText(container);
    expect(text).toContain("Estimated API cost: $1.5000");
    expect(text).toContain("Actual estimated API cost: $0.1200");
    expect(text).toContain("Actual tokens: 1500 total");
    expect(text).toContain("Cache: 40 hits, 5 misses");
    expect(text).toContain("context_extraction: 2 calls, 18 cache hits, 1200 tokens, $0.1000");
  });
});

function allText(element: MockElement): string {
  return [element.text, ...element.children.map(allText)].filter(Boolean).join("\n");
}

function checkpoint(createdAt: string): ImportCheckpoint {
  return {
    importId: "import_test",
    createdAt,
    settingsSnapshot: {},
    sourceManifest: [],
    report: {
      importedConversationCount: 0,
      processedConversationCount: 0,
      skippedConversationCount: 0,
      createdFiles: 0,
      updatedFiles: 0,
      deletedFiles: 0,
      skippedFiles: 0,
      nodeCountByType: {} as ImportCheckpoint["report"]["nodeCountByType"],
      edgeCount: 0,
      seededNodeCount: 0,
      mergedCandidateCount: 0,
      newlyPromotedNodeCount: 0,
      sourceOnlyCandidateCount: 0,
      prunedDuplicateNodeCount: 0,
      visibleCanonicalNodeCount: 0,
      isolatedCanonicalNodeCount: 0,
      unmatchedSeedNodeCount: 0,
      demotedCandidateCount: 0,
      rejectedProjectCandidateCount: 0,
      projectEvidenceCandidateCount: 0,
      filteredSeedAliasCount: 0,
      sourceAnchorFallbackCount: 0,
      underlinkedSourceCount: 0,
      anchorCandidateRejectedCount: 0,
      reviewQueueItemCount: 0,
      promotedReviewItemCount: 0,
      suppressedReviewItemCount: 0,
      canonicalSelfModelNodeCount: 0,
      inferredCanonicalNodeCount: 0,
      nounNodeCount: 0,
      selfModelNodeCount: 0,
      nounToSelfModelRatio: 0,
      agentContextPath: "",
      startedAt: createdAt,
      completedAt: createdAt,
      estimatedTokens: 0,
      estimatedExtractionInputTokens: 0,
      estimatedExtractionOutputTokens: 0,
      estimatedEmbeddingTokens: 0,
      estimatedExtractionCostUsd: 0,
      estimatedEmbeddingCostUsd: 0,
      estimatedCostUsd: 0,
      warnings: []
    }
  };
}
