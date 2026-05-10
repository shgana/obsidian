import { describe, expect, it } from "vitest";
import { EXTRACTION_SYSTEM_PROMPT, NODE_SYNTHESIS_SYSTEM_PROMPT } from "../src/ai/prompts";

describe("OpenAI extraction prompt", () => {
  it("keeps evidence-backed proper nouns from short or generic conversations", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("named context");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("programs");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("frameworks");
  });

  it("invites preferences, decisions, tasks, and style patterns from user-turn evidence", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("Preferences");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("Decisions");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("Tasks");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("Style patterns");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("USER turn");
  });

  it("specifies a calibrated confidence scale instead of clustering at 0.99", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("Confidence calibration");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("0.95-1.0");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("0.65-0.79");
  });
});

describe("Node synthesis prompt", () => {
  it("requests one or two third-person sentences without enumerated evidence", () => {
    expect(NODE_SYNTHESIS_SYSTEM_PROMPT).toContain("ONE or TWO sentences");
    expect(NODE_SYNTHESIS_SYSTEM_PROMPT).toContain("third person");
    expect(NODE_SYNTHESIS_SYSTEM_PROMPT).toContain("not enumerate");
  });
});
