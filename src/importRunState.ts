import type { ImportRunState } from "./types";

export const INTERRUPTED_IMPORT_ERROR =
  "Import was interrupted before completion. Reloading or disabling the plugin stops in-progress imports; rerun the import ZIP.";

export function migrateImportRunState(value: unknown): ImportRunState {
  if (!value || typeof value !== "object") {
    return {};
  }

  const state = value as Record<string, unknown>;
  return compactImportRunState({
    lastImportStartedAt: asOptionalString(state.lastImportStartedAt),
    lastImportUpdatedAt: asOptionalString(state.lastImportUpdatedAt),
    lastImportCompletedAt: asOptionalString(state.lastImportCompletedAt),
    lastImportPhase: asImportRunPhase(state.lastImportPhase),
    lastImportStatus: asImportRunStatus(state.lastImportStatus),
    lastImportError: asOptionalString(state.lastImportError),
    lastImportErrorAt: asOptionalString(state.lastImportErrorAt),
    lastImportFileName: asOptionalString(state.lastImportFileName),
    lastImportSelectedConversations: asOptionalNumber(state.lastImportSelectedConversations),
    lastImportTotalConversations: asOptionalNumber(state.lastImportTotalConversations),
    lastImportProgressMessage: asOptionalString(state.lastImportProgressMessage),
    lastImportProgressCompleted: asOptionalNumber(state.lastImportProgressCompleted),
    lastImportProgressTotal: asOptionalNumber(state.lastImportProgressTotal)
  });
}

export function markInterruptedImportRunState(
  state: ImportRunState,
  interruptedAt: string
): ImportRunState {
  if (state.lastImportStatus !== "running") {
    return state;
  }

  return compactImportRunState({
    ...state,
    lastImportUpdatedAt: interruptedAt,
    lastImportCompletedAt: interruptedAt,
    lastImportStatus: "failed",
    lastImportError: INTERRUPTED_IMPORT_ERROR,
    lastImportErrorAt: interruptedAt
  });
}

export function sanitizeImportErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/sk-proj-[A-Za-z0-9_-]+/g, "sk-proj-***")
    .replace(/sk-(?!proj-)[A-Za-z0-9_-]+/g, "sk-***")
    .slice(0, 1000);
}

function compactImportRunState(state: ImportRunState): ImportRunState {
  return Object.fromEntries(Object.entries(state).filter(([, value]) => value !== undefined)) as ImportRunState;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asImportRunStatus(value: unknown): ImportRunState["lastImportStatus"] {
  return value === "idle" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : undefined;
}

function asImportRunPhase(value: unknown): ImportRunState["lastImportPhase"] {
  return value === "idle" ||
    value === "parsing_zip" ||
    value === "preview_ready" ||
    value === "confirmed" ||
    value === "extracting" ||
    value === "building_graph" ||
    value === "rendering_markdown" ||
    value === "writing_vault" ||
    value === "saving_checkpoint" ||
    value === "completed" ||
    value === "failed"
    ? value
    : undefined;
}
