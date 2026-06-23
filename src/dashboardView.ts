import { ItemView, Setting, type WorkspaceLeaf } from "obsidian";
import type { GraphBuildReport, ImportCheckpoint, ImportRunState } from "./types";

export const VIEW_TYPE_CONTEXT_GRAPH_DASHBOARD = "personal-context-graph-dashboard";

export interface DashboardHost {
  checkpoint?: ImportCheckpoint;
  importRunState?: ImportRunState;
  openImportModal(): void;
  rebuildGeneratedGraph(): Promise<void>;
  exportAgentContextPack(): Promise<void>;
  clearImportCache(): Promise<void>;
}

export class ContextGraphDashboardView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly host: DashboardHost) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_CONTEXT_GRAPH_DASHBOARD;
  }

  getDisplayText(): string {
    return "Context Graph";
  }

  getIcon(): string {
    return "brain-circuit";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  render(): void {
    const container = this.contentEl;
    container.empty();
    container.createEl("h2", { text: "Personal Context Graph" });

    new Setting(container)
      .addButton((button) =>
        button.setButtonText("Import ChatGPT ZIP").setCta().onClick(() => this.host.openImportModal())
      )
      .addButton((button) =>
        button.setButtonText("Rebuild graph").onClick(() => void this.host.rebuildGeneratedGraph())
      )
      .addButton((button) =>
        button
          .setButtonText("Export agent context")
          .onClick(() => void this.host.exportAgentContextPack())
      )
      .addButton((button) =>
        button
          .setButtonText("Clear cache")
          .onClick(() => void this.host.clearImportCache())
      );

    renderImportStatus(container, this.host.importRunState, this.host.checkpoint);

    const report = this.host.checkpoint?.report;
    if (!report) {
      container.createEl("p", {
        text: "No import has run yet."
      });
      return;
    }

    renderReport(container, report);
  }
}

export function renderImportStatus(
  container: HTMLElement,
  state: ImportRunState | undefined,
  checkpoint?: ImportCheckpoint,
  now: Date = new Date()
): void {
  container.createEl("h3", { text: "Import Status" });

  if (!state || Object.keys(state).length === 0) {
    container.createEl("p", {
      text: "No import attempt recorded."
    });
    return;
  }

  const list = container.createEl("ul");
  list.createEl("li", {
    text: `Status: ${state.lastImportStatus || "unknown"}`
  });
  list.createEl("li", {
    text: `Phase: ${state.lastImportPhase || "unknown"}`
  });
  if (state.lastImportFileName) {
    list.createEl("li", {
      text: `File: ${state.lastImportFileName}`
    });
  }
  if (state.lastImportSelectedConversations !== undefined || state.lastImportTotalConversations !== undefined) {
    list.createEl("li", {
      text: `Conversations: ${state.lastImportSelectedConversations ?? "?"} selected of ${state.lastImportTotalConversations ?? "?"}`
    });
  }
  if (state.lastImportProgressMessage) {
    list.createEl("li", {
      text: `Progress: ${state.lastImportProgressMessage} (${state.lastImportProgressCompleted ?? "?"}/${state.lastImportProgressTotal ?? "?"})`
    });
  }
  if (
    state.lastImportProgressCompletedChunks !== undefined ||
    state.lastImportProgressTotalChunks !== undefined
  ) {
    list.createEl("li", {
      text: `Chunks: ${state.lastImportProgressCompletedChunks ?? "?"}/${state.lastImportProgressTotalChunks ?? "?"}`
    });
  }
  if (state.lastImportStartedAt) {
    list.createEl("li", {
      text: `Started: ${formatTimestamp(state.lastImportStartedAt)}`
    });
  }
  if (state.lastImportUpdatedAt) {
    list.createEl("li", {
      text: `Last updated: ${formatTimestamp(state.lastImportUpdatedAt)}`
    });
  }
  if (state.lastImportCompletedAt) {
    list.createEl("li", {
      text: `Completed: ${formatTimestamp(state.lastImportCompletedAt)}`
    });
  }
  const elapsed = elapsedImportMs(state, now);
  if (elapsed !== undefined) {
    list.createEl("li", {
      text: `${state.lastImportStatus === "running" ? "Elapsed" : "Duration"}: ${formatDuration(elapsed)}`
    });
  }
  const eta = state.lastImportStatus === "running" ? estimateRemainingMs(state, now) : undefined;
  if (eta !== undefined) {
    list.createEl("li", {
      text: `ETA: ${formatDuration(eta)} remaining`
    });
  }
  const conversationThroughput = throughputMs(
    elapsed,
    state.lastImportProgressCompleted,
    state.lastImportProgressTotal
  );
  if (conversationThroughput !== undefined) {
    list.createEl("li", {
      text: `Avg per conversation: ${formatDuration(conversationThroughput)}`
    });
  }
  const chunkThroughput = throughputMs(
    elapsed,
    state.lastImportProgressCompletedChunks,
    state.lastImportProgressTotalChunks
  );
  if (chunkThroughput !== undefined) {
    list.createEl("li", {
      text: `Avg per extraction chunk: ${formatDuration(chunkThroughput)}`
    });
  }
  if (state.lastImportError) {
    list.createEl("li", {
      text: `Last error: ${state.lastImportError}`
    });
  }
  if (state.lastImportErrorAt) {
    list.createEl("li", {
      text: `Error recorded: ${formatTimestamp(state.lastImportErrorAt)}`
    });
  }

  renderPhaseTimings(container, state, now);

  if (isCheckpointStaleAfterAttempt(state, checkpoint)) {
    container.createEl("p", {
      text: "Warning: the latest import attempt is newer than the saved checkpoint. The generated graph may still reflect an older successful import."
    });
  }
}

function isCheckpointStaleAfterAttempt(
  state: ImportRunState,
  checkpoint?: ImportCheckpoint
): boolean {
  if (state.lastImportStatus !== "failed" && state.lastImportStatus !== "running") {
    return false;
  }

  if (!state.lastImportStartedAt) {
    return false;
  }

  if (!checkpoint?.createdAt) {
    return true;
  }

  return checkpoint.createdAt < state.lastImportStartedAt;
}

export function renderReport(container: HTMLElement, report: GraphBuildReport): void {
  container.createEl("h3", { text: "Last Import" });
  const list = container.createEl("ul");
  list.createEl("li", {
    text: `Processed conversations: ${report.processedConversationCount}`
  });
  const reportDuration = report.durationMs ?? durationBetween(report.startedAt, report.completedAt);
  if (reportDuration !== undefined) {
    list.createEl("li", {
      text: `Duration: ${formatDuration(reportDuration)}`
    });
  }
  list.createEl("li", {
    text: `Started: ${formatTimestamp(report.startedAt)}`
  });
  list.createEl("li", {
    text: `Completed: ${formatTimestamp(report.completedAt)}`
  });
  const reportConversationThroughput = throughputMs(
    reportDuration,
    report.processedConversationCount,
    report.processedConversationCount
  );
  if (reportConversationThroughput !== undefined) {
    list.createEl("li", {
      text: `Avg per conversation: ${formatDuration(reportConversationThroughput)}`
    });
  }
  const extractionCalls = report.apiUsageByPhase?.context_extraction?.calls;
  const reportChunkThroughput = throughputMs(reportDuration, extractionCalls, extractionCalls);
  if (reportChunkThroughput !== undefined) {
    list.createEl("li", {
      text: `Avg per extraction chunk: ${formatDuration(reportChunkThroughput)}`
    });
  }
  list.createEl("li", {
    text: `Estimated API cost: $${report.estimatedCostUsd.toFixed(4)}`
  });
  if (report.actualCostUsd !== undefined) {
    list.createEl("li", {
      text: `Actual estimated API cost: $${report.actualCostUsd.toFixed(4)}`
    });
  }
  if (report.actualTotalTokens !== undefined) {
    list.createEl("li", {
      text: `Actual tokens: ${report.actualTotalTokens} total (${report.actualInputTokens || 0} input, ${report.actualOutputTokens || 0} output, ${report.actualEmbeddingTokens || 0} embedding)`
    });
  }
  if (report.cacheHitCount !== undefined || report.cacheMissCount !== undefined) {
    list.createEl("li", {
      text: `Cache: ${report.cacheHitCount ?? 0} hits, ${report.cacheMissCount ?? 0} misses`
    });
  }
  list.createEl("li", {
    text: `Graph edges: ${report.edgeCount}`
  });
  list.createEl("li", {
    text: `Visible canonical nodes: ${report.visibleCanonicalNodeCount ?? 0}`
  });
  list.createEl("li", {
    text: `Isolated canonical nodes: ${report.isolatedCanonicalNodeCount ?? 0}`
  });
  list.createEl("li", {
    text: `Seeded canonical nodes: ${report.seededNodeCount ?? 0}`
  });
  list.createEl("li", {
    text: `Unmatched seed nodes: ${report.unmatchedSeedNodeCount ?? 0}`
  });
  list.createEl("li", {
    text: `New canonical nodes: ${report.newlyPromotedNodeCount ?? 0}`
  });
  list.createEl("li", {
    text: `Merged candidates: ${report.mergedCandidateCount ?? 0}`
  });
  list.createEl("li", {
    text: `Source-only candidates: ${report.sourceOnlyCandidateCount ?? 0}`
  });
  list.createEl("li", {
    text: `Demoted candidates: ${report.demotedCandidateCount ?? 0}`
  });
  list.createEl("li", {
    text: `Rejected project candidates: ${report.rejectedProjectCandidateCount ?? 0}`
  });
  list.createEl("li", {
    text: `Project evidence candidates: ${report.projectEvidenceCandidateCount ?? 0}`
  });
  list.createEl("li", {
    text: `Filtered seed aliases: ${report.filteredSeedAliasCount ?? 0}`
  });
  list.createEl("li", {
    text: `Source anchor fallbacks: ${report.sourceAnchorFallbackCount ?? 0}`
  });
  list.createEl("li", {
    text: `Underlinked sources: ${report.underlinkedSourceCount ?? 0}`
  });
  list.createEl("li", {
    text: `Rejected anchor candidates: ${report.anchorCandidateRejectedCount ?? 0}`
  });
  list.createEl("li", {
    text: `Transactional source suppressions: ${report.transactionalSourceSuppressionCount ?? 0}`
  });
  if (report.sourceClassCounts) {
    list.createEl("li", {
      text: `Source classes: ${Object.entries(report.sourceClassCounts)
        .filter(([, count]) => count > 0)
        .map(([sourceClass, count]) => `${sourceClass} ${count}`)
        .join(", ") || "none"}`
    });
  }
  list.createEl("li", {
    text: `Review queue items: ${report.reviewQueueItemCount ?? 0}`
  });
  list.createEl("li", {
    text: `Review groups rendered: ${report.reviewQueueRenderedGroupCount ?? report.reviewQueueGroupCount ?? 0}`
  });
  list.createEl("li", {
    text: `Review groups summarized: ${report.reviewQueueSummarizedGroupCount ?? 0}`
  });
  list.createEl("li", {
    text: `Review priority groups: high ${report.reviewQueueHighPriorityCount ?? 0}, medium ${report.reviewQueueMediumPriorityCount ?? 0}, low ${report.reviewQueueLowPriorityCount ?? 0}`
  });
  if (report.reviewQueueCategoryCounts) {
    list.createEl("li", {
      text: `Review categories: ${Object.entries(report.reviewQueueCategoryCounts)
        .filter(([, count]) => count > 0)
        .map(([category, count]) => `${category} ${count}`)
        .join(", ") || "none"}`
    });
  }
  list.createEl("li", {
    text: `Review variants merged: ${report.reviewQueueMergedVariantCount ?? 0}`
  });
  list.createEl("li", {
    text: `Low-priority review candidates summarized: ${report.reviewQueueSummarizedCandidateCount ?? 0}`
  });
  list.createEl("li", {
    text: `Approved review items promoted: ${report.promotedReviewItemCount ?? 0}`
  });
  list.createEl("li", {
    text: `Review groups auto-promoted after compaction: ${report.postCompactionPromotedReviewItemCount ?? 0}`
  });
  list.createEl("li", {
    text: `Rejected review items suppressed: ${report.suppressedReviewItemCount ?? 0}`
  });
  list.createEl("li", {
    text: `Canonical self-model nodes: ${report.canonicalSelfModelNodeCount ?? 0}`
  });
  list.createEl("li", {
    text: `Inferred canonical nodes: ${report.inferredCanonicalNodeCount ?? 0}`
  });
  list.createEl("li", {
    text: `Noun/self-model ratio: ${report.nounToSelfModelRatio ?? 0}`
  });
  list.createEl("li", {
    text: `Pruned duplicate nodes: ${report.prunedDuplicateNodeCount ?? 0}`
  });
  list.createEl("li", {
    text: `Files created: ${report.createdFiles}`
  });
  list.createEl("li", {
    text: `Files updated: ${report.updatedFiles}`
  });
  list.createEl("li", {
    text: `Files deleted: ${report.deletedFiles}`
  });
  list.createEl("li", {
    text: `Files skipped: ${report.skippedFiles}`
  });
  list.createEl("li", {
    text: `Agent context: ${report.agentContextPath}`
  });

  container.createEl("h3", { text: "Node Counts" });
  const nodeList = container.createEl("ul");
  for (const [type, count] of Object.entries(report.nodeCountByType)) {
    nodeList.createEl("li", {
      text: `${type}: ${count}`
    });
  }

  if (report.warnings.length > 0) {
    container.createEl("h3", { text: "Warnings" });
    const warningList = container.createEl("ul");
    for (const warning of report.warnings) {
      warningList.createEl("li", { text: warning });
    }
  }

  if (report.apiUsageByPhase && Object.keys(report.apiUsageByPhase).length > 0) {
    container.createEl("h3", { text: "API Usage By Phase" });
    const usageList = container.createEl("ul");
    for (const [phase, usage] of Object.entries(report.apiUsageByPhase)) {
      if (!usage) {
        continue;
      }
      usageList.createEl("li", {
        text: `${phase}: ${usage.calls} calls, ${usage.cacheHits} cache hits, ${usage.totalTokens} tokens, $${usage.estimatedCostUsd.toFixed(4)}`
      });
    }
  }
}

function renderPhaseTimings(
  container: HTMLElement,
  state: ImportRunState,
  now: Date
): void {
  const timings = state.lastImportPhaseTimings || [];
  if (timings.length === 0) {
    return;
  }

  container.createEl("h3", { text: "Phase Timings" });
  const list = container.createEl("ul");
  for (const timing of timings) {
    const isOpen = !timing.completedAt && state.lastImportStatus === "running";
    const duration =
      timing.durationMs ??
      durationBetween(timing.startedAt, isOpen ? now.toISOString() : timing.completedAt);
    const progress =
      timing.progressTotal !== undefined
        ? ` (${timing.progressCompleted ?? 0}/${timing.progressTotal}${
            timing.progressTotalChunks !== undefined
              ? `, chunks ${timing.progressCompletedChunks ?? 0}/${timing.progressTotalChunks}`
              : ""
          })`
        : "";
    list.createEl("li", {
      text: `${formatPhase(timing.phase)}: ${duration !== undefined ? formatDuration(duration) : "in progress"}${progress}`
    });
  }
}

function elapsedImportMs(state: ImportRunState, now: Date): number | undefined {
  if (!state.lastImportStartedAt) {
    return undefined;
  }

  if (state.lastImportDurationMs !== undefined && state.lastImportStatus !== "running") {
    return state.lastImportDurationMs;
  }

  const end =
    state.lastImportStatus === "running"
      ? now.toISOString()
      : state.lastImportCompletedAt || state.lastImportErrorAt || state.lastImportUpdatedAt;
  return durationBetween(state.lastImportStartedAt, end);
}

function estimateRemainingMs(state: ImportRunState, now: Date): number | undefined {
  const elapsed = elapsedImportMs(state, now);
  if (elapsed === undefined || elapsed <= 0) {
    return undefined;
  }

  const chunkRemaining = remainingMsFromProgress(
    elapsed,
    state.lastImportProgressCompletedChunks,
    state.lastImportProgressTotalChunks
  );
  if (chunkRemaining !== undefined) {
    return chunkRemaining;
  }

  return remainingMsFromProgress(
    elapsed,
    state.lastImportProgressCompleted,
    state.lastImportProgressTotal
  );
}

function remainingMsFromProgress(
  elapsed: number,
  completed?: number,
  total?: number
): number | undefined {
  if (!completed || !total || completed <= 0 || total <= completed) {
    return undefined;
  }

  return Math.round((elapsed / completed) * (total - completed));
}

function throughputMs(
  elapsed: number | undefined,
  completed?: number,
  total?: number
): number | undefined {
  void total;
  if (elapsed === undefined || !completed || completed <= 0) {
    return undefined;
  }

  return Math.round(elapsed / completed);
}

function durationBetween(startedAt?: string, completedAt?: string): number | undefined {
  if (!startedAt || !completedAt) {
    return undefined;
  }

  const duration = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }

  return `${seconds}s`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function formatPhase(phase: NonNullable<ImportRunState["lastImportPhase"]>): string {
  return phase
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
