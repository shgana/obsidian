import { describe, expect, it } from "vitest";
import { migrateImportRunState, sanitizeImportErrorMessage } from "../src/importRunState";

describe("import run state", () => {
  it("loads empty state from old plugin data", () => {
    expect(migrateImportRunState(undefined)).toEqual({});
    expect(migrateImportRunState({})).toEqual({});
  });

  it("drops malformed fields without breaking plugin load", () => {
    const state = migrateImportRunState({
      lastImportStartedAt: "2026-06-04T12:00:00.000Z",
      lastImportCompletedAt: 123,
      lastImportPhase: "not_a_phase",
      lastImportStatus: "failed",
      lastImportError: "OpenAI request failed",
      lastImportErrorAt: "",
      lastImportFileName: "export.zip",
      lastImportSelectedConversations: Number.NaN,
      lastImportTotalConversations: 20
    });

    expect(state).toEqual({
      lastImportStartedAt: "2026-06-04T12:00:00.000Z",
      lastImportStatus: "failed",
      lastImportError: "OpenAI request failed",
      lastImportFileName: "export.zip",
      lastImportTotalConversations: 20
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
});
