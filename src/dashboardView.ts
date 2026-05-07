import { ItemView, Setting, type WorkspaceLeaf } from "obsidian";
import type { GraphBuildReport, ImportCheckpoint } from "./types";

export const VIEW_TYPE_CONTEXT_GRAPH_DASHBOARD = "personal-context-graph-dashboard";

export interface DashboardHost {
  checkpoint?: ImportCheckpoint;
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
