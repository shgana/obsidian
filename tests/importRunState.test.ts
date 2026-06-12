import { describe, expect, it } from "vitest";
import {
  INTERRUPTED_IMPORT_ERROR,
  applyImportRunStatePatch,
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
      lastImportProgressTotal: "20",
      lastImportProgressCompletedChunks: 2,
      lastImportProgressTotalChunks: 10,
      lastImportPhaseTimings: [
        {
          phase: "extracting",
          startedAt: "2026-06-04T12:00:00.000Z",
          completedAt: "2026-06-04T12:00:10.000Z",
          durationMs: 10000
        }
      ]
    });

    expect(state).toEqual({
      lastImportStartedAt: "2026-06-04T12:00:00.000Z",
      lastImportUpdatedAt: "2026-06-04T12:00:10.000Z",
      lastImportStatus: "failed",
      lastImportError: "OpenAI request failed",
      lastImportFileName: "export.zip",
      lastImportTotalConversations: 20,
      lastImportProgressMessage: "Extracting context",
      lastImportProgressCompleted: 0,
      lastImportProgressCompletedChunks: 2,
      lastImportProgressTotalChunks: 10,
      lastImportPhaseTimings: [
        {
          phase: "extracting",
          startedAt: "2026-06-04T12:00:00.000Z",
          completedAt: "2026-06-04T12:00:10.000Z",
          durationMs: 10000
        }
      ]
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
        lastImportProgressTotal: 20,
        lastImportPhaseStartedAt: "2026-06-04T12:00:00.000Z"
      },
      "2026-06-04T12:05:00.000Z"
    );

    expect(interrupted).toEqual({
      lastImportStartedAt: "2026-06-04T12:00:00.000Z",
      lastImportUpdatedAt: "2026-06-04T12:05:00.000Z",
      lastImportCompletedAt: "2026-06-04T12:05:00.000Z",
      lastImportDurationMs: 300000,
      lastImportPhaseStartedAt: "2026-06-04T12:00:00.000Z",
      lastImportPhase: "extracting",
      lastImportStatus: "failed",
      lastImportError: INTERRUPTED_IMPORT_ERROR,
      lastImportErrorAt: "2026-06-04T12:05:00.000Z",
      lastImportProgressMessage: "Extracting context",
      lastImportProgressCompleted: 0,
      lastImportProgressTotal: 20,
      lastImportPhaseTimings: [
        {
          phase: "extracting",
          startedAt: "2026-06-04T12:00:00.000Z",
          completedAt: "2026-06-04T12:05:00.000Z",
          durationMs: 300000,
          progressCompleted: 0,
          progressTotal: 20
        }
      ]
    });
  });

  it("records phase timings across phase transitions and completion", () => {
    let state = applyImportRunStatePatch(
      {},
      {
        lastImportStartedAt: "2026-06-04T12:00:00.000Z",
        lastImportPhase: "parsing_zip",
        lastImportStatus: "running"
      },
      "2026-06-04T12:00:00.000Z"
    );

    state = applyImportRunStatePatch(
      state,
      {
        lastImportPhase: "extracting",
        lastImportProgressCompleted: 1,
        lastImportProgressTotal: 20,
        lastImportProgressCompletedChunks: 3,
        lastImportProgressTotalChunks: 50
      },
      "2026-06-04T12:01:00.000Z"
    );

    state = applyImportRunStatePatch(
      state,
      {
        lastImportPhase: "completed",
        lastImportStatus: "succeeded",
        lastImportCompletedAt: "2026-06-04T12:03:00.000Z"
      },
      "2026-06-04T12:03:00.000Z"
    );

    expect(state.lastImportDurationMs).toBe(180000);
    expect(state.lastImportPhaseTimings).toEqual([
      {
        phase: "parsing_zip",
        startedAt: "2026-06-04T12:00:00.000Z",
        completedAt: "2026-06-04T12:01:00.000Z",
        durationMs: 60000
      },
      {
        phase: "extracting",
        startedAt: "2026-06-04T12:01:00.000Z",
        completedAt: "2026-06-04T12:03:00.000Z",
        durationMs: 120000,
        progressCompleted: 1,
        progressTotal: 20,
        progressCompletedChunks: 3,
        progressTotalChunks: 50
      },
      {
        phase: "completed",
        startedAt: "2026-06-04T12:03:00.000Z",
        completedAt: "2026-06-04T12:03:00.000Z",
        durationMs: 0,
        progressCompleted: 1,
        progressTotal: 20,
        progressCompletedChunks: 3,
        progressTotalChunks: 50
      }
    ]);
  });

  it("leaves non-running imports unchanged on plugin load", () => {
    const state = {
      lastImportPhase: "completed",
      lastImportStatus: "succeeded"
    } as const;

    expect(markInterruptedImportRunState(state, "2026-06-04T12:05:00.000Z")).toBe(state);
  });
});
