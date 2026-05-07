import { normalizePath, TFile, type Vault } from "obsidian";
import type { FileDraft, WriteSummary } from "./types";
import type { PersonalContextGraphSettings } from "./settings";

export class ManagedVaultWriter {
  constructor(
    private readonly vault: Vault,
    private readonly settings: PersonalContextGraphSettings
  ) {}

  async writeDrafts(drafts: FileDraft[]): Promise<WriteSummary> {
    const summary: WriteSummary = {
      created: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      warnings: []
    };

    await this.ensureFolder(this.settings.outputFolder);
    if (this.settings.pruneStaleManagedFiles) {
      summary.deleted += await this.deleteStaleManagedFiles(drafts);
    }

    for (const draft of drafts) {
      const path = normalizePath(draft.path);
      if (!this.isInsideOutputFolder(path)) {
        throw new Error(`Refusing to write outside ${this.settings.outputFolder}: ${path}`);
      }

      await this.ensureFolder(parentPath(path));
      const existing = this.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        const existingContent = await this.vault.read(existing);
        if (this.settings.overwritePolicy === "skip-existing") {
          summary.skipped += 1;
          continue;
        }

        if (!isManagedContent(existingContent)) {
          summary.skipped += 1;
          summary.warnings.push(`Skipped unmanaged existing file: ${path}`);
          continue;
        }

        await this.vault.modify(existing, draft.content);
        summary.updated += 1;
        continue;
      }

      if (existing) {
        summary.skipped += 1;
        summary.warnings.push(`Skipped path because it is not a file: ${path}`);
        continue;
      }

      await this.vault.create(path, draft.content);
      summary.created += 1;
    }

    return summary;
  }

  private async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (!normalized || this.vault.getAbstractFileByPath(normalized)) {
      return;
    }

    const parent = parentPath(normalized);
    if (parent && !this.vault.getAbstractFileByPath(parent)) {
      await this.ensureFolder(parent);
    }

    await this.vault.createFolder(normalized);
  }

  private isInsideOutputFolder(path: string): boolean {
    const outputFolder = normalizePath(this.settings.outputFolder);
    return path === outputFolder || path.startsWith(`${outputFolder}/`);
  }

  private async deleteStaleManagedFiles(drafts: FileDraft[]): Promise<number> {
    const draftPaths = new Set(drafts.map((draft) => normalizePath(draft.path)));
    const files = this.vault
      .getFiles()
      .filter((file) => this.isInsideOutputFolder(file.path) && !draftPaths.has(file.path));
    let deleted = 0;

    for (const file of files) {
      const content = await this.vault.read(file);
      if (!isManagedContent(content)) {
        continue;
      }

      await this.vault.delete(file);
      deleted += 1;
    }

    return deleted;
  }
}

function parentPath(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function isManagedContent(content: string): boolean {
  return /^---\n[\s\S]*?\npcg_managed: true\n[\s\S]*?\n---/.test(content);
}
