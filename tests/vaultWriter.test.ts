import { TFile, type Vault } from "obsidian";
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
    expect(vault.hasFile("Context Graph/Stale Unmanaged.md")).toBe(true);
    expect(vault.hasFile("Context Graph/Stale Protected.md")).toBe(true);
    expect(vault.hasFile("Context Graph/Current.md")).toBe(true);
  });
});

class FakeVault {
  private readonly files = new Map<string, { file: TFile; content: string }>();
  private readonly folders = new Set<string>();

  constructor(initialFiles: Record<string, string>) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.files.set(path, { file: makeFile(path), content });
      this.addParentFolders(path);
    }
  }

  getAbstractFileByPath(path: string): TFile | object | null {
    return this.files.get(path)?.file ?? (this.folders.has(path) ? {} : null);
  }

  getFiles(): TFile[] {
    return [...this.files.values()].map((entry) => entry.file);
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

  async delete(file: TFile): Promise<void> {
    this.files.delete(file.path);
  }

  async create(path: string, content: string): Promise<TFile> {
    const file = makeFile(path);
    this.files.set(path, { file, content });
    this.addParentFolders(path);
    return file;
  }

  async createFolder(path: string): Promise<void> {
    this.folders.add(path);
  }

  hasFile(path: string): boolean {
    return this.files.has(path);
  }

  private addParentFolders(path: string): void {
    const parts = path.split("/");
    parts.pop();
    for (let index = 1; index <= parts.length; index += 1) {
      this.folders.add(parts.slice(0, index).join("/"));
    }
  }
}

function makeFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.name = path.split("/").pop() ?? path;
  return file;
}
