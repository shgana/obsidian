import { parseManagedCanonicalSeed } from "../src/canonicalIndex";

describe("canonical index", () => {
  it("parses managed canonical notes into seeds", () => {
    const seed = parseManagedCanonicalSeed(
      "Context Graph/Topics/Obsidian.md",
      [
        "---",
        'pcg_type: "topic"',
        'pcg_id: "topic_obsidian"',
        "pcg_managed: true",
        "pcg_confidence: 0.95",
        "pcg_aliases:",
        '  - "Obsidian.md"',
        "pcg_source_ids:",
        '  - "conv-1"',
        "---",
        "# Topic: Obsidian",
        "",
        "## Summary",
        "Obsidian is the graph UI.",
        "",
        "## Evidence",
        '- Graph UI (Context Graph/Sources/ChatGPT/Graph UI.md) (0.95): "Build this as an Obsidian plugin."'
      ].join("\n"),
      {
        "Context Graph/Sources/ChatGPT/Graph UI": "conv-1"
      }
    );

    expect(seed?.type).toBe("topic");
    expect(seed?.label).toBe("Obsidian");
    expect(seed?.aliases).toEqual(["Obsidian.md"]);
    expect(seed?.sourceIds).toEqual(["conv-1"]);
    expect(seed?.evidence[0].sourceId).toBe("conv-1");
  });

  it("ignores source conversations and unmanaged files as seeds", () => {
    const sourceSeed = parseManagedCanonicalSeed(
      "Context Graph/Sources/ChatGPT/Graph UI.md",
      [
        "---",
        'pcg_type: "source_conversation"',
        "pcg_managed: true",
        "---",
        "# Graph UI"
      ].join("\n")
    );
    const unmanagedSeed = parseManagedCanonicalSeed(
      "Context Graph/Topics/Manual.md",
      [
        "---",
        'pcg_type: "topic"',
        "pcg_managed: false",
        "---",
        "# Topic: Manual"
      ].join("\n")
    );

    expect(sourceSeed).toBeUndefined();
    expect(unmanagedSeed).toBeUndefined();
  });
});
