import { ItemView, Setting, type WorkspaceLeaf } from "obsidian";
import type { GraphBuildReport, ImportCheckpoint, ImportRunState } from "./types";

export const VIEW_TYPE_CONTEXT_GRAPH_DASHBOARD = "personal-context-graph-dashboard";

export interface DashboardHost {
  checkpoint?: ImportCheckpoint;
  importRunState?: ImportRunState;
  openImportModal(): void;
  rebuildGeneratedGraph(): Promise<void>;
  exportAgentContextPack(): Promise<void>;
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
  checkpoint?: ImportCheckpoint
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
  if (state.lastImportStartedAt) {
    list.createEl("li", {
      text: `Started: ${state.lastImportStartedAt}`
    });
  }
  if (state.lastImportUpdatedAt) {
    list.createEl("li", {
      text: `Last updated: ${state.lastImportUpdatedAt}`
    });
  }
  if (state.lastImportCompletedAt) {
    list.createEl("li", {
      text: `Completed: ${state.lastImportCompletedAt}`
    });
  }
  if (state.lastImportError) {
    list.createEl("li", {
      text: `Last error: ${state.lastImportError}`
    });
  }
  if (state.lastImportErrorAt) {
    list.createEl("li", {
      text: `Error recorded: ${state.lastImportErrorAt}`
    });
  }

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

function renderReport(container: HTMLElement, report: GraphBuildReport): void {
  container.createEl("h3", { text: "Last Import" });
  const list = container.createEl("ul");
  list.createEl("li", {
    text: `Processed conversations: ${report.processedConversationCount}`
  });
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
    text: `Review queue items: ${report.reviewQueueItemCount ?? 0}`
  });
  list.createEl("li", {
    text: `Approved review items promoted: ${report.promotedReviewItemCount ?? 0}`
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
}
