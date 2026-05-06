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
      .setDesc("Used only after you explicitly confirm an import.")
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
      .setDesc("Items below this confidence are not written as graph links.")
      .addSlider((slider) =>
        slider
          .setLimits(0.5, 0.95, 0.01)
          .setValue(this.host.settings.confidenceThreshold)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.host.settings.confidenceThreshold = value;
            await this.host.saveSettings();
          })
      );
  }
}
