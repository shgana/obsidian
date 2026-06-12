import type { ImportRunPhaseTiming, ImportRunState } from "./types";

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
    lastImportDurationMs: asOptionalNumber(state.lastImportDurationMs),
    lastImportPhaseStartedAt: asOptionalString(state.lastImportPhaseStartedAt),
    lastImportPhase: asImportRunPhase(state.lastImportPhase),
    lastImportStatus: asImportRunStatus(state.lastImportStatus),
    lastImportError: asOptionalString(state.lastImportError),
    lastImportErrorAt: asOptionalString(state.lastImportErrorAt),
    lastImportFileName: asOptionalString(state.lastImportFileName),
    lastImportSelectedConversations: asOptionalNumber(state.lastImportSelectedConversations),
    lastImportTotalConversations: asOptionalNumber(state.lastImportTotalConversations),
    lastImportProgressMessage: asOptionalString(state.lastImportProgressMessage),
    lastImportProgressCompleted: asOptionalNumber(state.lastImportProgressCompleted),
    lastImportProgressTotal: asOptionalNumber(state.lastImportProgressTotal),
    lastImportProgressCompletedChunks: asOptionalNumber(state.lastImportProgressCompletedChunks),
    lastImportProgressTotalChunks: asOptionalNumber(state.lastImportProgressTotalChunks),
    lastImportPhaseTimings: asPhaseTimings(state.lastImportPhaseTimings)
  });
}

export function applyImportRunStatePatch(
  currentState: ImportRunState,
  patch: Partial<ImportRunState>,
  updatedAt: string
): ImportRunState {
  const previousPhase = currentState.lastImportPhase;
  const nextPhase = patch.lastImportPhase ?? previousPhase;
  const phaseChanged = Boolean(nextPhase && previousPhase && nextPhase !== previousPhase);
  const isNewAttempt = Boolean(patch.lastImportStartedAt);
  const shouldFinalize =
    patch.lastImportStatus === "succeeded" ||
    patch.lastImportStatus === "failed" ||
    patch.lastImportStatus === "cancelled";
  const completedAt =
    patch.lastImportCompletedAt ||
    (shouldFinalize ? patch.lastImportErrorAt || updatedAt : undefined);
  const startedAt = patch.lastImportStartedAt || currentState.lastImportStartedAt;

  let nextState: ImportRunState = compactImportRunState({
    ...currentState,
    ...patch,
    lastImportUpdatedAt: updatedAt
  });

  let timings = isNewAttempt ? [] : [...(currentState.lastImportPhaseTimings || [])];
  if (phaseChanged || isNewAttempt) {
    timings = closeOpenPhaseTiming(timings, updatedAt);
  }

  if (nextPhase && (phaseChanged || isNewAttempt || timings.length === 0)) {
    const phaseStartedAt =
      isNewAttempt
        ? patch.lastImportStartedAt || updatedAt
        : phaseChanged
          ? updatedAt
        : currentState.lastImportPhaseStartedAt ||
          currentState.lastImportStartedAt ||
          patch.lastImportStartedAt ||
          updatedAt;
    timings.push({
      phase: nextPhase,
      startedAt: phaseStartedAt
    });
    nextState.lastImportPhaseStartedAt = phaseStartedAt;
  }

  timings = updateCurrentPhaseProgress(timings, nextState);

  if (completedAt) {
    timings = closeOpenPhaseTiming(timings, completedAt);
    nextState.lastImportCompletedAt = completedAt;
    nextState.lastImportDurationMs = durationMs(startedAt, completedAt);
  }

  nextState.lastImportPhaseTimings = timings.length > 0 ? timings : undefined;
  return compactImportRunState(nextState);
}

export function markInterruptedImportRunState(
  state: ImportRunState,
  interruptedAt: string
): ImportRunState {
  if (state.lastImportStatus !== "running") {
    return state;
  }

  return applyImportRunStatePatch(state, {
    lastImportCompletedAt: interruptedAt,
    lastImportStatus: "failed",
    lastImportError: INTERRUPTED_IMPORT_ERROR,
    lastImportErrorAt: interruptedAt
  }, interruptedAt);
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

function asPhaseTimings(value: unknown): ImportRunPhaseTiming[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const timings = value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const record = item as Record<string, unknown>;
      const phase = asImportRunPhase(record.phase);
      const startedAt = asOptionalString(record.startedAt);
      if (!phase || !startedAt) {
        return undefined;
      }
      return compactPhaseTiming({
        phase,
        startedAt,
        completedAt: asOptionalString(record.completedAt),
        durationMs: asOptionalNumber(record.durationMs),
        progressCompleted: asOptionalNumber(record.progressCompleted),
        progressTotal: asOptionalNumber(record.progressTotal),
        progressCompletedChunks: asOptionalNumber(record.progressCompletedChunks),
        progressTotalChunks: asOptionalNumber(record.progressTotalChunks)
      });
    })
    .filter((item): item is ImportRunPhaseTiming => Boolean(item));

  return timings.length > 0 ? timings : undefined;
}

function closeOpenPhaseTiming(
  timings: ImportRunPhaseTiming[],
  completedAt: string
): ImportRunPhaseTiming[] {
  if (timings.length === 0) {
    return timings;
  }

  return timings.map((timing, index) => {
    if (index !== timings.length - 1 || timing.completedAt) {
      return timing;
    }
    return compactPhaseTiming({
      ...timing,
      completedAt,
      durationMs: durationMs(timing.startedAt, completedAt)
    });
  });
}

function updateCurrentPhaseProgress(
  timings: ImportRunPhaseTiming[],
  state: ImportRunState
): ImportRunPhaseTiming[] {
  if (timings.length === 0) {
    return timings;
  }

  return timings.map((timing, index) => {
    if (index !== timings.length - 1) {
      return timing;
    }
    return compactPhaseTiming({
      ...timing,
      progressCompleted: state.lastImportProgressCompleted,
      progressTotal: state.lastImportProgressTotal,
      progressCompletedChunks: state.lastImportProgressCompletedChunks,
      progressTotalChunks: state.lastImportProgressTotalChunks
    });
  });
}

function compactPhaseTiming(timing: ImportRunPhaseTiming): ImportRunPhaseTiming {
  return Object.fromEntries(Object.entries(timing).filter(([, value]) => value !== undefined)) as ImportRunPhaseTiming;
}

function durationMs(startedAt?: string, completedAt?: string): number | undefined {
  if (!startedAt || !completedAt) {
    return undefined;
  }

  const duration = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
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
