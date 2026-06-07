export class TFile {
  path = "";
  name = "";
  parent = null;
}

export class TFolder {
  path = "";
  name = "";
  parent = null;
  children: Array<TFile | TFolder> = [];

  isRoot(): boolean {
    return this.path === "";
  }
}

export class ItemView {
  contentEl = new MockElement("div");

  constructor(_leaf?: unknown) {}
}

export class Setting {
  constructor(private readonly container: MockElement) {}

  addButton(callback: (button: ButtonComponent) => unknown): this {
    callback(new ButtonComponent());
    return this;
  }
}

export class ButtonComponent {
  setButtonText(_text: string): this {
    return this;
  }

  setCta(): this {
    return this;
  }

  onClick(_callback: () => unknown): this {
    return this;
  }
}

export class MockElement {
  text = "";
  children: MockElement[] = [];

  constructor(readonly tag: string) {}

  createEl(tag: string, options?: { text?: string }): MockElement {
    const child = new MockElement(tag);
    child.text = options?.text || "";
    this.children.push(child);
    return child;
  }

  empty(): void {
    this.children = [];
    this.text = "";
  }
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}
