import { describe, expect, it } from "vitest";
import { EXTRACTION_SYSTEM_PROMPT } from "../src/ai/prompts";

describe("OpenAI extraction prompt", () => {
  it("keeps evidence-backed proper nouns from short or generic conversations", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("named programs");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("proper nouns");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("conversation title is generic");
  });
});
