import { App, Modal, Setting } from "obsidian";
import type { ImportPreview } from "./types";
import type { PersonalContextGraphSettings } from "./settings";

export class ZipImportModal extends Modal {
  constructor(
    app: App,
    private readonly onFileSelected: (file: File) => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Import ChatGPT Export ZIP");
    this.contentEl.empty();

    this.contentEl.createEl("p", {
      text: "Choose a ChatGPT data export ZIP that contains conversations.json."
    });

    const input = this.contentEl.createEl("input", {
      attr: {
        type: "file",
        accept: ".zip,application/zip"
      }
    });

    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) {
        return;
      }

      this.close();
      await this.onFileSelected(file);
    });
  }
}

export class ImportConsentModal extends Modal {
  constructor(
    app: App,
    private readonly preview: ImportPreview,
    private readonly settings: PersonalContextGraphSettings,
    private readonly onConfirm: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Confirm Hosted Extraction");
    this.contentEl.empty();

    this.contentEl.createEl("p", {
      text:
        "This import sends selected ChatGPT conversations to the configured OpenAI model for structured extraction."
    });

    const list = this.contentEl.createEl("ul");
    list.createEl("li", {
      text: `File: ${this.preview.fileName}`
    });
    list.createEl("li", {
      text: `Conversations: ${this.preview.selectedConversations} selected of ${this.preview.totalConversations}`
    });
    list.createEl("li", {
      text: `Turns: ${this.preview.totalTurns}`
    });
    list.createEl("li", {
      text: `Estimated input tokens: ${this.preview.estimatedTokens.toLocaleString()}`
    });
    list.createEl("li", {
      text: `Approximate extraction cost: $${this.preview.estimatedCostUsd.toFixed(
        4
      )} with cap $${this.settings.costCapUsd.toFixed(2)}`
    });

    if (this.settings.costCapUsd > 0 && this.preview.estimatedCostUsd > this.settings.costCapUsd) {
      this.contentEl.createEl("p", {
        text: "The estimate exceeds your configured cap. Raise the cap or lower the test-run limit before importing."
      });
      new Setting(this.contentEl).addButton((button) =>
        button.setButtonText("Close").onClick(() => this.close())
      );
      return;
    }

    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText("Cancel")
          .onClick(() => this.close())
      )
      .addButton((button) =>
        button
          .setButtonText("Import")
          .setCta()
          .onClick(async () => {
            this.close();
            await this.onConfirm();
          })
      );
  }
}

export class ProgressModal extends Modal {
  private statusEl?: HTMLElement;

  onOpen(): void {
    this.titleEl.setText("Building Context Graph");
    this.contentEl.empty();
    this.statusEl = this.contentEl.createEl("p", {
      text: "Starting import..."
    });
  }

  update(message: string): void {
    this.statusEl?.setText(message);
  }

  finish(message: string): void {
    this.statusEl?.setText(message);
  }
}
