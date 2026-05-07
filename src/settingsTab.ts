import { PluginSettingTab, Setting, type Plugin } from "obsidian";
import type { App } from "obsidian";
import type { PersonalContextGraphSettings } from "./settings";

export interface SettingsHost {
  settings: PersonalContextGraphSettings;
  saveSettings(): Promise<void>;
}

export class PersonalContextGraphSettingTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin & SettingsHost) {
    super(app, plugin);
    this.host = plugin;
  }

  private readonly host: SettingsHost;

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Personal Context Graph" });

    new Setting(containerEl)
      .setName("OpenAI API key")
      .setDesc("Used only after you explicitly confirm an import. Not saved unless you enable key persistence below.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.host.settings.openAiApiKey)
          .onChange(async (value) => {
            this.host.settings.openAiApiKey = value.trim();
            await this.host.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Remember API key on disk")
      .setDesc("Off by default. When off, the key works for this Obsidian session but is not saved into plugin data.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.rememberOpenAiApiKey).onChange(async (value) => {
          this.host.settings.rememberOpenAiApiKey = value;
          await this.host.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Extraction model")
      .setDesc("Hosted model used for structured context extraction.")
      .addText((text) =>
        text.setValue(this.host.settings.extractionModel).onChange(async (value) => {
          this.host.settings.extractionModel = value.trim() || "gpt-5.4-mini";
          await this.host.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Embedding model")
      .setDesc("Used for conservative same-type semantic merging.")
      .addText((text) =>
        text.setValue(this.host.settings.embeddingModel).onChange(async (value) => {
          this.host.settings.embeddingModel = value.trim() || "text-embedding-3-small";
          await this.host.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("The plugin writes only inside this folder.")
      .addText((text) =>
        text.setValue(this.host.settings.outputFolder).onChange(async (value) => {
          this.host.settings.outputFolder = value.trim() || "Context Graph";
          await this.host.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Max conversations")
      .setDesc("Use 0 for all conversations. Useful for test runs.")
      .addText((text) =>
        text
          .setPlaceholder("0")
          .setValue(String(this.host.settings.maxConversations))
          .onChange(async (value) => {
            this.host.settings.maxConversations = Math.max(0, Number.parseInt(value, 10) || 0);
            await this.host.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Cost cap")
      .setDesc("Approximate extraction cost cap in USD before any API calls are made.")
      .addText((text) =>
        text.setValue(String(this.host.settings.costCapUsd)).onChange(async (value) => {
          this.host.settings.costCapUsd = Math.max(0, Number.parseFloat(value) || 0);
          await this.host.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Overwrite policy")
      .setDesc("Managed-only updates files marked pcg_managed: true. Skip-existing never overwrites.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("managed-only", "Managed files only")
          .addOption("skip-existing", "Skip existing files")
          .setValue(this.host.settings.overwritePolicy)
          .onChange(async (value) => {
            this.host.settings.overwritePolicy =
              value === "skip-existing" ? "skip-existing" : "managed-only";
            await this.host.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Confidence threshold")
      .setDesc("Items below this confidence are not eligible for graph promotion.")
      .addSlider((slider) =>
        slider
          .setLimits(0.72, 0.95, 0.01)
          .setValue(this.host.settings.confidenceThreshold)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.host.settings.confidenceThreshold = value;
            this.host.settings.singleSourcePromotionThreshold = Math.max(
              this.host.settings.singleSourcePromotionThreshold,
              value
            );
            await this.host.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Single-source promotion threshold")
      .setDesc("A concept from one conversation must meet this confidence before becoming a canonical graph node.")
      .addSlider((slider) =>
        slider
          .setLimits(0.78, 0.99, 0.01)
          .setValue(this.host.settings.singleSourcePromotionThreshold)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.host.settings.singleSourcePromotionThreshold = Math.max(
              value,
              this.host.settings.confidenceThreshold
            );
            await this.host.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Minimum sources for canonical node")
      .setDesc("Unmatched concepts below the single-source threshold must appear in this many conversations before promotion.")
      .addText((text) =>
        text
          .setPlaceholder("2")
          .setValue(String(this.host.settings.minimumCanonicalSources))
          .onChange(async (value) => {
            this.host.settings.minimumCanonicalSources = Math.max(
              1,
              Number.parseInt(value, 10) || 2
            );
            await this.host.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max source links per type")
      .setDesc("Caps visible wikilinks from each source note to canonical graph nodes.")
      .addText((text) =>
        text
          .setPlaceholder("3")
          .setValue(String(this.host.settings.maxSourceLinksPerType))
          .onChange(async (value) => {
            this.host.settings.maxSourceLinksPerType = Math.max(
              1,
              Number.parseInt(value, 10) || 3
            );
            await this.host.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max project links per type")
      .setDesc("Caps visible wikilinks from project notes to directly evidenced related context.")
      .addText((text) =>
        text
          .setPlaceholder("3")
          .setValue(String(this.host.settings.maxProjectLinksPerType))
          .onChange(async (value) => {
            this.host.settings.maxProjectLinksPerType = Math.max(
              1,
              Number.parseInt(value, 10) || 3
            );
            await this.host.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Link Agent Context into graph")
      .setDesc("Off by default so Agent Context does not become a giant hub node.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.linkAgentContextToGraph).onChange(async (value) => {
          this.host.settings.linkAgentContextToGraph = value;
          await this.host.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Prune stale managed files")
      .setDesc("Deletes old plugin-generated files that are no longer produced by the next import. Only files marked pcg_managed: true are deleted.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.pruneStaleManagedFiles).onChange(async (value) => {
          this.host.settings.pruneStaleManagedFiles = value;
          await this.host.saveSettings();
        })
      );
  }
}
