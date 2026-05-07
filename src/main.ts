import { Notice, Plugin, TFile, type WorkspaceLeaf } from "obsidian";
import { OpenAIProvider } from "./ai/openaiProvider";
import {
  ContextGraphDashboardView,
  VIEW_TYPE_CONTEXT_GRAPH_DASHBOARD
} from "./dashboardView";
import {
  applyWriteSummary,
  createImportPreview,
  runImport
} from "./importPipeline";
import { ImportConsentModal, ProgressModal, ZipImportModal } from "./modals";
import { DEFAULT_SETTINGS, type PersonalContextGraphSettings } from "./settings";
import { PersonalContextGraphSettingTab } from "./settingsTab";
import { parseChatGptExportZip } from "./chatgptParser";
import type { ImportCheckpoint, ParsedConversation } from "./types";
import { ManagedVaultWriter } from "./vaultWriter";

interface StoredPluginData {
  settings?: Partial<PersonalContextGraphSettings>;
  checkpoint?: ImportCheckpoint | Record<string, unknown>;
}

export default class PersonalContextGraphPlugin extends Plugin {
  settings: PersonalContextGraphSettings = { ...DEFAULT_SETTINGS };
  checkpoint?: ImportCheckpoint;

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.addSettingTab(new PersonalContextGraphSettingTab(this.app, this));
    this.registerView(
      VIEW_TYPE_CONTEXT_GRAPH_DASHBOARD,
      (leaf: WorkspaceLeaf) => new ContextGraphDashboardView(leaf, this)
    );

    this.addCommand({
      id: "import-chatgpt-export-zip",
      name: "Import ChatGPT export ZIP",
      callback: () => this.openImportModal()
    });

    this.addCommand({
      id: "rebuild-generated-graph",
      name: "Rebuild generated graph",
      callback: () => void this.rebuildGeneratedGraph()
    });

    this.addCommand({
      id: "open-import-dashboard",
      name: "Open import dashboard",
      callback: () => void this.activateDashboard()
    });

    this.addCommand({
      id: "export-agent-context-pack",
      name: "Export agent context pack",
      callback: () => void this.exportAgentContextPack()
    });
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CONTEXT_GRAPH_DASHBOARD);
  }

  async loadPluginData(): Promise<void> {
    const data = (await this.loadData()) as StoredPluginData | Partial<PersonalContextGraphSettings> | null;
    const settings = isStoredPluginData(data) ? data.settings : data;
    this.settings = migrateSettings(settings || {});
    this.checkpoint = isStoredPluginData(data) ? migrateCheckpoint(data.checkpoint) : undefined;
  }

  async saveSettings(): Promise<void> {
    await this.savePluginData();
  }

  async savePluginData(): Promise<void> {
    await this.saveData({
      settings: settingsForStorage(this.settings),
      checkpoint: this.checkpoint
    } satisfies StoredPluginData);
  }

  openImportModal(): void {
    if (!this.settings.openAiApiKey.trim()) {
      new Notice("Set an OpenAI API key in Personal Context Graph settings before importing.");
      return;
    }

    new ZipImportModal(this.app, (file) => void this.importZipFile(file)).open();
  }

  async importZipFile(file: File): Promise<void> {
    try {
      const conversations = await parseChatGptExportZip(await file.arrayBuffer());
      if (conversations.length === 0) {
        new Notice("No non-empty conversations found in conversations.json.");
        return;
      }

      const preview = createImportPreview(file.name, conversations, this.settings);
      new ImportConsentModal(this.app, preview, this.settings, () =>
        this.executeImport(conversations)
      ).open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  async executeImport(conversations: ParsedConversation[]): Promise<void> {
    const progress = new ProgressModal(this.app);
    progress.open();

    try {
      const provider = new OpenAIProvider(this.settings);
      const artifacts = await runImport(conversations, this.settings, provider, (status) => {
        progress.update(`${status.message} (${status.completed}/${status.total})`);
      });
      const writer = new ManagedVaultWriter(this.app.vault, this.settings);
      const writeSummary = await writer.writeDrafts(artifacts.drafts);
      const report = applyWriteSummary(artifacts.report, writeSummary);

      artifacts.checkpoint.report = report;
      this.checkpoint = artifacts.checkpoint;
      await this.savePluginData();
      this.refreshDashboard();

      progress.finish(
        `Context graph complete. Created ${report.createdFiles}, updated ${report.updatedFiles}, skipped ${report.skippedFiles}.`
      );
      new Notice(`Context graph imported: ${report.processedConversationCount} conversations.`);
      await this.openVaultFile(report.agentContextPath);
    } catch (error) {
      progress.close();
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  async rebuildGeneratedGraph(): Promise<void> {
    new Notice("Rebuild now requires re-importing the ChatGPT ZIP. Full transcripts are no longer stored in plugin data.");
  }

  async exportAgentContextPack(): Promise<void> {
    try {
      const path = this.checkpoint?.report.agentContextPath || `${this.settings.outputFolder}/Agent Context.md`;
      await this.openVaultFile(path);
      new Notice("Opened agent context pack.");
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  async activateDashboard(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_CONTEXT_GRAPH_DASHBOARD
    )[0];
    if (existingLeaf) {
      this.app.workspace.revealLeaf(existingLeaf);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE_CONTEXT_GRAPH_DASHBOARD,
      active: true
    });
    this.app.workspace.revealLeaf(leaf);
  }

  private refreshDashboard(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CONTEXT_GRAPH_DASHBOARD)) {
      if (leaf.view instanceof ContextGraphDashboardView) {
        leaf.view.render();
      }
    }
  }

  private async openVaultFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(true).openFile(file);
    }
  }
}

function isStoredPluginData(value: unknown): value is StoredPluginData {
  return (
    typeof value === "object" &&
    value !== null &&
    ("settings" in value || "checkpoint" in value)
  );
}

function migrateSettings(
  value: Partial<PersonalContextGraphSettings>
): PersonalContextGraphSettings {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...value,
    rememberOpenAiApiKey: value.rememberOpenAiApiKey ?? false,
    linkAgentContextToGraph: value.linkAgentContextToGraph ?? false,
    pruneStaleManagedFiles: value.pruneStaleManagedFiles ?? true
  };

  if (!settings.rememberOpenAiApiKey) {
    settings.openAiApiKey = value.openAiApiKey || "";
  }

  if (settings.confidenceThreshold < 0.72) {
    settings.confidenceThreshold = DEFAULT_SETTINGS.confidenceThreshold;
  }

  if (settings.singleSourcePromotionThreshold < settings.confidenceThreshold) {
    settings.singleSourcePromotionThreshold = Math.max(
      DEFAULT_SETTINGS.singleSourcePromotionThreshold,
      settings.confidenceThreshold
    );
  }

  return settings;
}

function settingsForStorage(
  settings: PersonalContextGraphSettings
): PersonalContextGraphSettings {
  return {
    ...settings,
    openAiApiKey: settings.rememberOpenAiApiKey ? settings.openAiApiKey : ""
  };
}

function migrateCheckpoint(value: unknown): ImportCheckpoint | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const checkpoint = value as Record<string, unknown>;
  const report = checkpoint.report;
  if (!report || typeof report !== "object") {
    return undefined;
  }

  if (Array.isArray(checkpoint.sourceManifest)) {
    return checkpoint as unknown as ImportCheckpoint;
  }

  const graph = checkpoint.graph as
    | {
        sourcePathsById?: Record<string, string>;
      }
    | undefined;
  const conversations = Array.isArray(checkpoint.conversations)
    ? (checkpoint.conversations as Array<Record<string, unknown>>)
    : [];

  return {
    importId: String(checkpoint.importId || "legacy_import"),
    createdAt: String(checkpoint.createdAt || new Date().toISOString()),
    settingsSnapshot:
      typeof checkpoint.settingsSnapshot === "object" && checkpoint.settingsSnapshot
        ? (checkpoint.settingsSnapshot as Record<string, unknown>)
        : {},
    sourceManifest: conversations.map((conversation) => {
      const sourceId = String(conversation.sourceId || "");
      return {
        sourceId,
        title: String(conversation.title || "Untitled conversation"),
        path: graph?.sourcePathsById?.[sourceId] || "",
        createTime:
          typeof conversation.createTime === "string" ? conversation.createTime : undefined,
        updateTime:
          typeof conversation.updateTime === "string" ? conversation.updateTime : undefined
      };
    }),
    report: report as ImportCheckpoint["report"]
  };
}
