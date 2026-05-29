import { requestUrl } from "obsidian";
import type {
  AIProvider,
  Evidence,
  ExtractedContext,
  ExtractedContextItem,
  ParsedConversation,
  SynthesizeSummaryArgs
} from "../types";
import type { PersonalContextGraphSettings } from "../settings";
import { conversationToPrompt } from "../conversationText";
import { nowIso } from "../text";
import { CONTEXT_NODE_LABEL } from "../types";
import {
  EXTRACTION_SYSTEM_PROMPT,
  NODE_SYNTHESIS_SYSTEM_PROMPT,
  SELF_MODEL_SYSTEM_PROMPT
} from "./prompts";

interface OpenAITextContent {
  type?: string;
  text?: string;
}

interface OpenAIOutputItem {
  content?: OpenAITextContent[];
}

interface OpenAIResponseBody {
  output_text?: string;
  output?: OpenAIOutputItem[];
  error?: {
    message?: string;
  };
}

interface OpenAIEmbeddingBody {
  data?: Array<{
    embedding?: number[];
  }>;
  error?: {
    message?: string;
  };
}

export class OpenAIProvider implements AIProvider {
  constructor(private readonly settings: PersonalContextGraphSettings) {}

  async extractContext(conversation: ParsedConversation): Promise<ExtractedContext> {
    if (!this.settings.openAiApiKey.trim()) {
      throw new Error("OpenAI API key is required before importing.");
    }

    const response = await requestUrl({
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.openAiApiKey.trim()}`,
        "Content-Type": "application/json"
      },
      throw: false,
      body: JSON.stringify({
        model: this.settings.extractionModel,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: EXTRACTION_SYSTEM_PROMPT
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: conversationToPrompt(conversation, this.settings.maxPromptChars)
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "personal_context_graph_extraction",
            strict: true,
            schema: EXTRACTION_SCHEMA
          }
        }
      })
    });

    const body = response.json as OpenAIResponseBody;
    if (response.status >= 400 || body.error) {
      throw new Error(formatOpenAiError("extraction", response.status, body));
    }

    const outputText = extractOutputText(body);
    if (!outputText) {
      throw new Error("OpenAI extraction returned no structured output.");
    }

    return normalizeExtractedContext(JSON.parse(outputText), conversation);
  }

  async extractSelfModel(
    conversation: ParsedConversation,
    baseExtraction: ExtractedContext
  ): Promise<Partial<ExtractedContext>> {
    if (!this.settings.openAiApiKey.trim()) {
      throw new Error("OpenAI API key is required before importing.");
    }

    const selfModelPayload = [
      "Base extraction summary:",
      baseExtraction.summary || "No summary.",
      "",
      "Conversation:",
      conversationToPrompt(conversation, this.settings.maxPromptChars)
    ].join("\n");

    const response = await requestUrl({
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.openAiApiKey.trim()}`,
        "Content-Type": "application/json"
      },
      throw: false,
      body: JSON.stringify({
        model: this.settings.extractionModel,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: SELF_MODEL_SYSTEM_PROMPT
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: selfModelPayload
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "personal_context_graph_self_model",
            strict: true,
            schema: SELF_MODEL_SCHEMA
          }
        }
      })
    });

    const body = response.json as OpenAIResponseBody;
    if (response.status >= 400 || body.error) {
      throw new Error(formatOpenAiError("extraction", response.status, body));
    }

    const outputText = extractOutputText(body);
    if (!outputText) {
      throw new Error("OpenAI self-model extraction returned no structured output.");
    }

    return normalizeExtractedSelfModel(JSON.parse(outputText));
  }

  async synthesizeSummary(args: SynthesizeSummaryArgs): Promise<string> {
    if (!this.settings.openAiApiKey.trim()) {
      throw new Error("OpenAI API key is required before synthesizing summaries.");
    }

    if (args.evidenceQuotes.length === 0) {
      return "";
    }

    const userPayload = [
      `Node type: ${CONTEXT_NODE_LABEL[args.type]}`,
      `Label: ${args.label}`,
      "",
      "Evidence quotes:",
      ...args.evidenceQuotes
        .slice(0, 12)
        .map((quote, index) => `${index + 1}. ${quote.trim()}`)
    ].join("\n");

    const response = await requestUrl({
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.openAiApiKey.trim()}`,
        "Content-Type": "application/json"
      },
      throw: false,
      body: JSON.stringify({
        model: this.settings.extractionModel,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: NODE_SYNTHESIS_SYSTEM_PROMPT }]
          },
          {
            role: "user",
            content: [{ type: "input_text", text: userPayload }]
          }
        ]
      })
    });

    const body = response.json as OpenAIResponseBody;
    if (response.status >= 400 || body.error) {
      throw new Error(formatOpenAiError("extraction", response.status, body));
    }

    return extractOutputText(body).trim();
  }

  async embedText(text: string): Promise<number[]> {
    if (!this.settings.openAiApiKey.trim()) {
      throw new Error("OpenAI API key is required before embedding text.");
    }

    const response = await requestUrl({
      url: "https://api.openai.com/v1/embeddings",
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.openAiApiKey.trim()}`,
        "Content-Type": "application/json"
      },
      throw: false,
      body: JSON.stringify({
        model: this.settings.embeddingModel,
        input: text
      })
    });

    const body = response.json as OpenAIEmbeddingBody;
    if (response.status >= 400 || body.error) {
      throw new Error(formatOpenAiError("embedding", response.status, body));
    }

    const embedding = body.data?.[0]?.embedding;
    if (!embedding) {
      throw new Error("OpenAI embedding returned no vector.");
    }

    return embedding;
  }
}

function formatOpenAiError(
  phase: "extraction" | "embedding",
  status: number,
  body: OpenAIResponseBody | OpenAIEmbeddingBody
): string {
  if (status === 401) {
    return "OpenAI authentication failed (401). Replace the API key in Personal Context Graph settings with a valid Platform API key, then try again.";
  }

  if (status === 403) {
    return "OpenAI authorization failed (403). Check that this API key/project has permission to use the configured model.";
  }

  return body.error?.message || `OpenAI ${phase} failed (${status}).`;
}

const evidenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["quote", "turnRole", "confidence"],
  properties: {
    quote: {
      type: "string",
      description: "A short quote or close excerpt supporting the item."
    },
    turnRole: {
      type: "string",
      enum: ["user", "assistant", "system", "tool", "unknown"]
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1
    }
  }
};

const itemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "summary", "confidence", "evidence"],
  properties: {
    label: {
      type: "string"
    },
    summary: {
      type: "string"
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1
    },
    evidence: {
      type: "array",
      maxItems: 3,
      items: evidenceSchema
    }
  }
};

const selfModelItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "label",
    "summary",
    "confidence",
    "evidence",
    "stability",
    "inferenceLevel",
    "appliesTo",
    "agentInstruction"
  ],
  properties: {
    ...itemSchema.properties,
    evidence: {
      type: "array",
      maxItems: 4,
      items: evidenceSchema
    },
    stability: {
      type: "string",
      enum: ["stable", "recurring", "situational", "temporary"]
    },
    inferenceLevel: {
      type: "string",
      enum: ["explicit", "supported_inference"]
    },
    appliesTo: {
      type: "array",
      maxItems: 6,
      items: { type: "string" }
    },
    agentInstruction: {
      type: "string"
    }
  }
};

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "confidence",
    "topics",
    "entities",
    "projects",
    "preferences",
    "decisions",
    "tasks",
    "artifacts",
    "stylePatterns"
  ],
  properties: {
    summary: {
      type: "string"
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1
    },
    topics: {
      type: "array",
      maxItems: 8,
      items: itemSchema
    },
    entities: {
      type: "array",
      maxItems: 10,
      items: itemSchema
    },
    projects: {
      type: "array",
      maxItems: 6,
      items: itemSchema
    },
    preferences: {
      type: "array",
      maxItems: 8,
      items: itemSchema
    },
    decisions: {
      type: "array",
      maxItems: 8,
      items: itemSchema
    },
    tasks: {
      type: "array",
      maxItems: 8,
      items: itemSchema
    },
    artifacts: {
      type: "array",
      maxItems: 8,
      items: itemSchema
    },
    stylePatterns: {
      type: "array",
      maxItems: 6,
      items: itemSchema
    }
  }
};

const SELF_MODEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "confidence",
    "patterns",
    "principles",
    "agentInstructions",
    "preferences",
    "decisions",
    "stylePatterns"
  ],
  properties: {
    summary: {
      type: "string"
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1
    },
    patterns: {
      type: "array",
      maxItems: 8,
      items: selfModelItemSchema
    },
    principles: {
      type: "array",
      maxItems: 6,
      items: selfModelItemSchema
    },
    agentInstructions: {
      type: "array",
      maxItems: 8,
      items: selfModelItemSchema
    },
    preferences: {
      type: "array",
      maxItems: 8,
      items: selfModelItemSchema
    },
    decisions: {
      type: "array",
      maxItems: 6,
      items: selfModelItemSchema
    },
    stylePatterns: {
      type: "array",
      maxItems: 4,
      items: selfModelItemSchema
    }
  }
};

function extractOutputText(body: OpenAIResponseBody): string {
  if (body.output_text) {
    return body.output_text;
  }

  return (
    body.output
      ?.flatMap((item) => item.content || [])
      .map((content) => content.text || "")
      .join("")
      .trim() || ""
  );
}

function normalizeExtractedContext(
  value: unknown,
  conversation: ParsedConversation
): ExtractedContext {
  const objectValue = asRecord(value);

  return {
    sourceId: conversation.sourceId,
    conversationTitle: conversation.title,
    summary: asString(objectValue.summary),
    confidence: clampConfidence(objectValue.confidence),
    topics: normalizeItems(objectValue.topics),
    entities: normalizeItems(objectValue.entities),
    projects: normalizeItems(objectValue.projects),
    patterns: normalizeItems(objectValue.patterns),
    principles: normalizeItems(objectValue.principles),
    agentInstructions: normalizeItems(objectValue.agentInstructions),
    preferences: normalizeItems(objectValue.preferences),
    decisions: normalizeItems(objectValue.decisions),
    tasks: normalizeItems(objectValue.tasks),
    artifacts: normalizeItems(objectValue.artifacts),
    stylePatterns: normalizeItems(objectValue.stylePatterns),
    extractedAt: nowIso()
  };
}

function normalizeExtractedSelfModel(value: unknown): Partial<ExtractedContext> {
  const objectValue = asRecord(value);
  return {
    summary: asString(objectValue.summary),
    confidence: clampConfidence(objectValue.confidence),
    patterns: normalizeItems(objectValue.patterns),
    principles: normalizeItems(objectValue.principles),
    agentInstructions: normalizeItems(objectValue.agentInstructions),
    preferences: normalizeItems(objectValue.preferences),
    decisions: normalizeItems(objectValue.decisions),
    stylePatterns: normalizeItems(objectValue.stylePatterns)
  };
}

function normalizeItems(value: unknown): ExtractedContextItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const itemObject = asRecord(item);
      return {
        label: asString(itemObject.label).trim(),
        summary: asString(itemObject.summary).trim(),
        confidence: clampConfidence(itemObject.confidence),
        evidence: normalizeEvidence(itemObject.evidence),
        stability: normalizeStability(itemObject.stability),
        inferenceLevel: normalizeInferenceLevel(itemObject.inferenceLevel),
        appliesTo: normalizeStringArray(itemObject.appliesTo).slice(0, 6),
        agentInstruction: asString(itemObject.agentInstruction).trim()
      };
    })
    .filter((item) => item.label && item.summary && item.evidence.length > 0);
}

function normalizeStability(value: unknown): ExtractedContextItem["stability"] {
  return value === "stable" ||
    value === "recurring" ||
    value === "situational" ||
    value === "temporary"
    ? value
    : undefined;
}

function normalizeInferenceLevel(value: unknown): ExtractedContextItem["inferenceLevel"] {
  return value === "explicit" || value === "supported_inference" ? value : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => asString(item).trim())
        .filter(Boolean)
    : [];
}

function normalizeEvidence(value: unknown): Evidence[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const evidence = asRecord(item);
      return {
        quote: asString(evidence.quote).trim(),
        turnRole: asString(evidence.turnRole) as Evidence["turnRole"],
        confidence: clampConfidence(evidence.confidence)
      };
    })
    .filter((evidence) => evidence.quote);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }

  return {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
