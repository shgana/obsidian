import { describe, expect, it } from "vitest";
import {
  INTERRUPTED_IMPORT_ERROR,
  markInterruptedImportRunState,
  migrateImportRunState,
  sanitizeImportErrorMessage
} from "../src/importRunState";

describe("import run state", () => {
  it("loads empty state from old plugin data", () => {
    expect(migrateImportRunState(undefined)).toEqual({});
    expect(migrateImportRunState({})).toEqual({});
  });

  it("drops malformed fields without breaking plugin load", () => {
    const state = migrateImportRunState({
      lastImportStartedAt: "2026-06-04T12:00:00.000Z",
      lastImportUpdatedAt: "2026-06-04T12:00:10.000Z",
      lastImportCompletedAt: 123,
      lastImportPhase: "not_a_phase",
      lastImportStatus: "failed",
      lastImportError: "OpenAI request failed",
      lastImportErrorAt: "",
      lastImportFileName: "export.zip",
      lastImportSelectedConversations: Number.NaN,
      lastImportTotalConversations: 20,
      lastImportProgressMessage: "Extracting context",
      lastImportProgressCompleted: 0,
      lastImportProgressTotal: "20"
    });

    expect(state).toEqual({
      lastImportStartedAt: "2026-06-04T12:00:00.000Z",
      lastImportUpdatedAt: "2026-06-04T12:00:10.000Z",
      lastImportStatus: "failed",
      lastImportError: "OpenAI request failed",
      lastImportFileName: "export.zip",
      lastImportTotalConversations: 20,
      lastImportProgressMessage: "Extracting context",
      lastImportProgressCompleted: 0
    });
  });

  it("sanitizes secrets and truncates stored errors", () => {
    const message = sanitizeImportErrorMessage(
      new Error(`Bad key sk-proj-abc123_xyz and fallback sk-test123 ${"x".repeat(1200)}`)
    );

    expect(message).toContain("sk-proj-***");
    expect(message).toContain("sk-***");
    expect(message).not.toContain("abc123_xyz");
    expect(message.length).toBe(1000);
  });

  it("marks saved running imports as interrupted on plugin load", () => {
    const interrupted = markInterruptedImportRunState(
      {
        lastImportStartedAt: "2026-06-04T12:00:00.000Z",
        lastImportPhase: "extracting",
        lastImportStatus: "running",
        lastImportProgressMessage: "Extracting context",
        lastImportProgressCompleted: 0,
        lastImportProgressTotal: 20
      },
      "2026-06-04T12:05:00.000Z"
    );

    expect(interrupted).toEqual({
      lastImportStartedAt: "2026-06-04T12:00:00.000Z",
      lastImportUpdatedAt: "2026-06-04T12:05:00.000Z",
      lastImportCompletedAt: "2026-06-04T12:05:00.000Z",
      lastImportPhase: "extracting",
      lastImportStatus: "failed",
      lastImportError: INTERRUPTED_IMPORT_ERROR,
      lastImportErrorAt: "2026-06-04T12:05:00.000Z",
      lastImportProgressMessage: "Extracting context",
      lastImportProgressCompleted: 0,
      lastImportProgressTotal: 20
    });
  });

  it("leaves non-running imports unchanged on plugin load", () => {
    const state = {
      lastImportPhase: "completed",
      lastImportStatus: "succeeded"
    } as const;

    expect(markInterruptedImportRunState(state, "2026-06-04T12:05:00.000Z")).toBe(state);
  });
});
