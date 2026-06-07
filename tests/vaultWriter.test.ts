import { TFile, TFolder, type Vault } from "obsidian";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings";
import { isManagedContent, isProtectedContent, ManagedVaultWriter } from "../src/vaultWriter";

describe("vault writer frontmatter flags", () => {
  it("detects managed content when the flag is the final frontmatter key", () => {
    expect(
      isManagedContent(
        [
          "---",
          "pcg_type: \"agent_context_index\"",
          "pcg_id: \"agent_context_index\"",
          "pcg_managed: true",
          "---",
          "# Agent Context"
        ].join("\n")
      )
    ).toBe(true);
  });

  it("detects quoted boolean values", () => {
    expect(
      isManagedContent(
        [
          "---",
          "pcg_type: \"agent_context_index\"",
          "pcg_managed: \"true\"",
          "---",
          "# Agent Context"
        ].join("\n")
      )
    ).toBe(true);
  });

  it("detects CRLF frontmatter", () => {
    expect(
      isManagedContent(
        ["---", "pcg_type: \"agent_context_index\"", "pcg_managed: true", "---", ""].join(
          "\r\n"
        )
      )
    ).toBe(true);
  });

  it("does not detect flags outside opening frontmatter", () => {
    expect(isManagedContent(["# Note", "", "pcg_managed: true"].join("\n"))).toBe(false);
  });

  it("detects protected content with the same frontmatter rules", () => {
    expect(
      isProtectedContent(
        [
          "---",
          "pcg_type: \"identity\"",
          "pcg_protected: \"true\"",
          "---",
          "# Me"
        ].join("\n")
      )
    ).toBe(true);

    expect(
      isProtectedContent(
        ["---", "pcg_type: \"identity\"", "pcg_protected: true", "---", ""].join("\r\n")
      )
    ).toBe(true);
  });
});

describe("ManagedVaultWriter stale pruning", () => {
  it("deletes stale managed files and preserves unmanaged or protected files", async () => {
    const vault = new FakeVault({
      "Context Graph/Stale Managed.md": [
        "---",
        "pcg_type: \"agent_context_section\"",
        "pcg_managed: true",
        "---",
        "# Old"
      ].join("\n"),
      "Context Graph/Stale Unmanaged.md": ["---", "pcg_type: \"manual\"", "---", "# Keep"].join(
        "\n"
      ),
      "Context Graph/Stale Protected.md": [
        "---",
        "pcg_type: \"identity\"",
        "pcg_managed: true",
        "pcg_protected: true",
        "---",
        "# Keep"
      ].join("\n"),
      "Context Graph/Review Queue/pattern - Old.md": [
        "---",
        "pcg_type: \"review_item\"",
        "pcg_managed: true",
        "pcg_protected: true",
        "pcg_review_status: \"pending\"",
        "---",
        "# Review: Old"
      ].join("\n")
    });
    const writer = new ManagedVaultWriter(vault as unknown as Vault, {
      ...DEFAULT_SETTINGS,
      outputFolder: "Context Graph",
      pruneStaleManagedFiles: true
    });

    const summary = await writer.writeDrafts([
      {
        path: "Context Graph/Current.md",
        content: ["---", "pcg_managed: true", "---", "# Current"].join("\n"),
        managed: true
      }
    ]);

    expect(summary.deleted).toBe(2);
    expect(summary.created).toBe(1);
    expect(vault.hasFile("Context Graph/Stale Managed.md")).toBe(false);
    expect(vault.hasFile("Context Graph/Review Queue/pattern - Old.md")).toBe(false);
    expect(vault.hasFolder("Context Graph/Review Queue")).toBe(false);
    expect(vault.hasFile("Context Graph/Stale Unmanaged.md")).toBe(true);
    expect(vault.hasFile("Context Graph/Stale Protected.md")).toBe(true);
    expect(vault.hasFile("Context Graph/Current.md")).toBe(true);
  });

  it("removes stale empty generated folders but preserves folders with unmanaged files", async () => {
    const vault = new FakeVault({
      "Context Graph/Agent Context/README.md": [
        "---",
        "pcg_type: \"agent_context_index\"",
        "pcg_managed: true",
        "---",
        "# Old Agent Context"
      ].join("\n"),
      "Context Graph/Review Queue/pattern - Old.md": [
        "---",
        "pcg_type: \"review_item\"",
        "pcg_managed: true",
        "pcg_review_status: \"pending\"",
        "---",
        "# Review: Old"
      ].join("\n"),
      "Context Graph/Manual Folder/Manual.md": "# Keep"
    });
    const writer = new ManagedVaultWriter(vault as unknown as Vault, {
      ...DEFAULT_SETTINGS,
      outputFolder: "Context Graph",
      pruneStaleManagedFiles: true
    });

    await writer.writeDrafts([
      {
        path: "Context Graph/Agent Context.md",
        content: ["---", "pcg_managed: true", "---", "# Agent Context"].join("\n"),
        managed: true
      },
      {
        path: "Context Graph/Review Queue.md",
        content: ["---", "pcg_managed: true", "---", "# Review Queue"].join("\n"),
        managed: true
      }
    ]);

    expect(vault.hasFolder("Context Graph/Agent Context")).toBe(false);
    expect(vault.hasFolder("Context Graph/Review Queue")).toBe(false);
    expect(vault.hasFolder("Context Graph/Manual Folder")).toBe(true);
    expect(vault.hasFile("Context Graph/Manual Folder/Manual.md")).toBe(true);
  });
});

class FakeVault {
  private readonly files = new Map<string, { file: TFile; content: string }>();
  private readonly folders = new Map<string, TFolder>();

  constructor(initialFiles: Record<string, string>) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.files.set(path, { file: makeFile(path), content });
      this.addParentFolders(path);
      this.attachFileToParent(path);
    }
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    return this.files.get(path)?.file ?? this.folders.get(path) ?? null;
  }

  getFiles(): TFile[] {
    return [...this.files.values()].map((entry) => entry.file);
  }

  getAllLoadedFiles(): Array<TFile | TFolder> {
    return [
      ...this.folders.values(),
      ...Array.from(this.files.values()).map((entry) => entry.file)
    ];
  }

  async read(file: TFile): Promise<string> {
    const entry = this.files.get(file.path);
    if (!entry) {
      throw new Error(`Missing file: ${file.path}`);
    }

    return entry.content;
  }

  async modify(file: TFile, content: string): Promise<void> {
    const entry = this.files.get(file.path);
    if (!entry) {
      throw new Error(`Missing file: ${file.path}`);
    }

    entry.content = content;
  }

  async delete(file: TFile | TFolder): Promise<void> {
    if (file instanceof TFile) {
      this.files.delete(file.path);
      this.detachFromParent(file);
      return;
    }

    this.folders.delete(file.path);
    this.detachFromParent(file);
  }

  async create(path: string, content: string): Promise<TFile> {
    const file = makeFile(path);
    this.files.set(path, { file, content });
    this.addParentFolders(path);
    this.attachFileToParent(path);
    return file;
  }

  async createFolder(path: string): Promise<TFolder> {
    const folder = this.ensureFolder(path);
    const parent = parentPath(path);
    if (parent) {
      const parentFolder = this.ensureFolder(parent);
      attachChild(parentFolder, folder);
      folder.parent = parentFolder;
    }
    return folder;
  }

  hasFile(path: string): boolean {
    return this.files.has(path);
  }

  hasFolder(path: string): boolean {
    return this.folders.has(path);
  }

  private addParentFolders(path: string): void {
    const parts = path.split("/");
    parts.pop();
    for (let index = 1; index <= parts.length; index += 1) {
      const folderPath = parts.slice(0, index).join("/");
      const folder = this.ensureFolder(folderPath);
      const parent = parentPath(folderPath);
      if (parent) {
        const parentFolder = this.ensureFolder(parent);
        attachChild(parentFolder, folder);
        folder.parent = parentFolder;
      }
    }
  }

  private ensureFolder(path: string): TFolder {
    const existing = this.folders.get(path);
    if (existing) {
      return existing;
    }

    const folder = new TFolder();
    folder.path = path;
    folder.name = path.split("/").pop() ?? path;
    this.folders.set(path, folder);
    return folder;
  }

  private attachFileToParent(path: string): void {
    const entry = this.files.get(path);
    const parent = parentPath(path);
    if (!entry || !parent) {
      return;
    }

    const parentFolder = this.ensureFolder(parent);
    entry.file.parent = parentFolder;
    attachChild(parentFolder, entry.file);
  }

  private detachFromParent(file: TFile | TFolder): void {
    const parent = file.parent as TFolder | null;
    if (!parent) {
      return;
    }

    parent.children = parent.children.filter((child) => child !== file);
  }
}

function makeFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.name = path.split("/").pop() ?? path;
  return file;
}

function attachChild(folder: TFolder, child: TFile | TFolder): void {
  if (!folder.children.includes(child)) {
    folder.children.push(child);
  }
}

function parentPath(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}
