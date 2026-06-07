import { normalizePath, TFile, TFolder, type Vault } from "obsidian";
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
        if (draft.createOnly) {
          summary.skipped += 1;
          continue;
        }

        if (this.settings.overwritePolicy === "skip-existing") {
          summary.skipped += 1;
          continue;
        }

        if (isProtectedContent(existingContent)) {
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

    if (this.settings.pruneStaleManagedFiles) {
      await this.deleteEmptyStaleFolders(drafts);
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

      if (isProtectedContent(content) && !isMigratedReviewItemContent(content)) {
        continue;
      }

      await this.vault.delete(file);
      deleted += 1;
    }

    return deleted;
  }

  private async deleteEmptyStaleFolders(drafts: FileDraft[]): Promise<void> {
    const draftParentPaths = new Set(drafts.map((draft) => parentPath(normalizePath(draft.path))));
    const folders = this.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .filter((folder) => this.isInsideOutputFolder(folder.path))
      .filter((folder) => folder.path !== normalizePath(this.settings.outputFolder))
      .sort((left, right) => right.path.length - left.path.length);

    for (const folder of folders) {
      if (draftParentPaths.has(folder.path)) {
        continue;
      }

      if (folder.children.length > 0) {
        continue;
      }

      await this.vault.delete(folder);
    }
  }
}

function parentPath(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

export function isManagedContent(content: string): boolean {
  return readFrontmatterBoolean(content, "pcg_managed");
}

export function isProtectedContent(content: string): boolean {
  return readFrontmatterBoolean(content, "pcg_protected");
}

function readFrontmatterBoolean(content: string, key: string): boolean {
  return readFrontmatterValue(content, key).toLowerCase() === "true";
}

function isMigratedReviewItemContent(content: string): boolean {
  return readFrontmatterValue(content, "pcg_type") === "review_item";
}

function readFrontmatterValue(content: string, key: string): string {
  const frontmatter = extractOpeningFrontmatter(content);
  if (!frontmatter) {
    return "";
  }

  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:\\s*(.*?)\\s*$`);
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(keyPattern);
    if (!match) {
      continue;
    }

    return parseFrontmatterScalar(match[1]);
  }

  return "";
}

function extractOpeningFrontmatter(content: string): string | null {
  const normalized = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const match = normalized.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return match?.[1] ?? null;
}

function parseFrontmatterScalar(value: string): string {
  const trimmed = value.trim();
  const withoutComment = trimmed.startsWith("\"") || trimmed.startsWith("'")
    ? trimmed
    : trimmed.replace(/\s+#.*$/, "");
  return withoutComment.replace(/^["'](.*)["']$/, "$1");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
