import {
  parseManagedCanonicalSeed,
  parseManagedReviewSeed,
  parseManagedReviewSeeds
} from "../src/canonicalIndex";

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

  it("parses review queue notes with approval status and self-model metadata", () => {
    const seed = parseManagedReviewSeed(
      "Context Graph/Review Queue/pattern - Reference-driven UX design.md",
      [
        "---",
        'pcg_type: "review_item"',
        'pcg_id: "review_pattern_reference-driven-ux-design"',
        "pcg_managed: true",
        'pcg_review_status: "approved"',
        'pcg_target_type: "pattern"',
        "pcg_confidence: 0.78",
        'pcg_stability: "recurring"',
        'pcg_inference_level: "supported_inference"',
        "pcg_applies_to:",
        '  - "product design"',
        "---",
        "# Review: Reference-driven UX design",
        "",
        "## Summary",
        "The user draws UX mechanics from proven consumer apps.",
        "",
        "## Evidence",
        '- UX references (Context Graph/Sources/ChatGPT/UX references.md) (0.78): "I like Duolingo onboarding."'
      ].join("\n"),
      {
        "Context Graph/Sources/ChatGPT/UX references": "conv-ux"
      }
    );

    expect(seed?.status).toBe("approved");
    expect(seed?.type).toBe("pattern");
    expect(seed?.label).toBe("Reference-driven UX design");
    expect(seed?.stability).toBe("recurring");
    expect(seed?.inferenceLevel).toBe("supported_inference");
    expect(seed?.appliesTo).toEqual(["product design"]);
    expect(seed?.evidence[0].sourceId).toBe("conv-ux");
  });

  it("parses a single Review Queue inbox into multiple review seeds", () => {
    const seeds = parseManagedReviewSeeds(
      "Context Graph/Review Queue.md",
      [
        "---",
        'pcg_type: "review_queue"',
        "pcg_managed: true",
        'pcg_review_format: "inbox_v1"',
        "---",
        "# Review Queue",
        "",
        "## Pending",
        "",
        "### Review: Reference-driven UX design",
        "- **ID**: `review_pattern_reference-driven-ux-design`",
        "- **Status**: `approved`",
        "- **Target type**: `pattern`",
        "- **Confidence**: 0.78",
        "- **Stability**: `recurring`",
        "- **Inference level**: `supported_inference`",
        "- **Applies to**: product design; onboarding",
        "- **Source IDs**: conv-ux",
        "",
        "#### Summary",
        "The user draws UX mechanics from proven consumer apps.",
        "",
        "#### Agent Instruction",
        "Translate proven app mechanics into concrete flow decisions.",
        "",
        "#### Evidence",
        '- UX references (Context Graph/Sources/ChatGPT/UX references.md) (0.78): "I like Duolingo onboarding."',
        "",
        "### Review: Broad outcome bullets",
        "- **ID**: `review_preference_broad-outcome-bullets`",
        "- **Status**: `rejected`",
        "- **Target type**: `preference`",
        "- **Confidence**: 0.74",
        "",
        "#### Summary",
        "The user prefers broad outcome bullets.",
        "",
        "#### Evidence",
        '- Pitch copy (Context Graph/Sources/ChatGPT/Pitch copy.md) (0.74): "make these bullets broader."'
      ].join("\n"),
      {
        "Context Graph/Sources/ChatGPT/UX references": "conv-ux",
        "Context Graph/Sources/ChatGPT/Pitch copy": "conv-pitch"
      }
    );

    expect(seeds).toHaveLength(2);
    expect(seeds[0].status).toBe("approved");
    expect(seeds[0].type).toBe("pattern");
    expect(seeds[0].appliesTo).toEqual(["product design", "onboarding"]);
    expect(seeds[0].agentInstruction).toBe("Translate proven app mechanics into concrete flow decisions.");
    expect(seeds[0].evidence[0].sourceId).toBe("conv-ux");
    expect(seeds[1].status).toBe("rejected");
    expect(seeds[1].type).toBe("preference");
    expect(seeds[1].evidence[0].sourceId).toBe("conv-pitch");
  });
});
