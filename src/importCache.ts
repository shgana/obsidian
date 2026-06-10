import { conversationToPrompt } from "./conversationText";
import type { PersonalContextGraphSettings } from "./settings";
import type {
  AIProvider,
  ApiUsageEvent,
  ExtractedContext,
  ImportCacheState,
  ImportCacheStats,
  ParsedConversation,
  SynthesizeAgentContextArgs,
  SynthesizeSummaryArgs
} from "./types";
import { hashString, nowIso } from "./text";

export const IMPORT_CACHE_VERSION = 1;
export const EXTRACTION_PROMPT_VERSION = "base-extraction-v4";
export const SELF_MODEL_PROMPT_VERSION = "self-model-v2";
export const NODE_SUMMARY_PROMPT_VERSION = "node-summary-v1";
export const AGENT_CONTEXT_PROMPT_VERSION = "agent-context-profile-v1";

export function createEmptyImportCacheState(): ImportCacheState {
  return {
    version: IMPORT_CACHE_VERSION,
    extraction: {},
    selfModel: {},
    embeddings: {},
    nodeSummaries: {},
    agentContext: {}
  };
}

export function migrateImportCacheState(value: unknown): ImportCacheState {
  const empty = createEmptyImportCacheState();
  if (!value || typeof value !== "object") {
    return empty;
  }

  const record = value as Partial<ImportCacheState>;
  return {
    version: IMPORT_CACHE_VERSION,
    extraction: asRecord(record.extraction),
    selfModel: asRecord(record.selfModel),
    embeddings: asRecord(record.embeddings),
    nodeSummaries: asRecord(record.nodeSummaries),
    agentContext: asRecord(record.agentContext)
  };
}

export function createEmptyCacheStats(): ImportCacheStats {
  return {
    extractionHits: 0,
    extractionMisses: 0,
    selfModelHits: 0,
    selfModelMisses: 0,
    embeddingHits: 0,
    embeddingMisses: 0,
    nodeSummaryHits: 0,
    nodeSummaryMisses: 0,
    agentContextHits: 0,
    agentContextMisses: 0
  };
}

export function cacheHitCount(stats: ImportCacheStats): number {
  return (
    stats.extractionHits +
    stats.selfModelHits +
    stats.embeddingHits +
    stats.nodeSummaryHits +
    stats.agentContextHits
  );
}

export function cacheMissCount(stats: ImportCacheStats): number {
  return (
    stats.extractionMisses +
    stats.selfModelMisses +
    stats.embeddingMisses +
    stats.nodeSummaryMisses +
    stats.agentContextMisses
  );
}

export class CachedAIProvider implements AIProvider {
  private readonly stats = createEmptyCacheStats();
  private readonly cacheUsageEvents: ApiUsageEvent[] = [];

  constructor(
    private readonly inner: AIProvider,
    private readonly settings: PersonalContextGraphSettings,
    private readonly cache: ImportCacheState
  ) {}

  getCacheStats(): ImportCacheStats {
    return { ...this.stats };
  }

  getUsageEvents(): ApiUsageEvent[] {
    return [...(this.inner.getUsageEvents?.() || []), ...this.cacheUsageEvents];
  }

  async extractContext(conversation: ParsedConversation): Promise<ExtractedContext> {
    const key = extractionCacheKey(conversation, this.settings);
    const cached = this.cache.extraction[key];
    if (cached?.value) {
      this.stats.extractionHits += 1;
      this.recordCacheHit("context_extraction", this.settings.extractionModel);
      return clone(cached.value);
    }

    this.stats.extractionMisses += 1;
    const value = await this.inner.extractContext(conversation);
    this.cache.extraction[key] = {
      createdAt: nowIso(),
      sourceId: conversation.sourceId,
      transcriptHash: transcriptHash(conversation, this.settings.maxPromptChars),
      model: this.settings.extractionModel,
      promptVersion: EXTRACTION_PROMPT_VERSION,
      value: clone(value)
    };
    return value;
  }

  async extractSelfModel(
    conversation: ParsedConversation,
    baseExtraction: ExtractedContext
  ): Promise<Partial<ExtractedContext>> {
    if (!this.inner.extractSelfModel) {
      return {};
    }

    const key = selfModelCacheKey(conversation, baseExtraction, this.settings);
    const cached = this.cache.selfModel[key];
    if (cached?.value) {
      this.stats.selfModelHits += 1;
      this.recordCacheHit("self_model_extraction", this.settings.extractionModel);
      return clone(cached.value);
    }

    this.stats.selfModelMisses += 1;
    const value = await this.inner.extractSelfModel(conversation, baseExtraction);
    this.cache.selfModel[key] = {
      createdAt: nowIso(),
      sourceId: conversation.sourceId,
      transcriptHash: transcriptHash(conversation, this.settings.maxPromptChars),
      model: this.settings.extractionModel,
      promptVersion: SELF_MODEL_PROMPT_VERSION,
      value: clone(value)
    };
    return value;
  }

  async embedText(text: string): Promise<number[]> {
    const key = embeddingCacheKey(text, this.settings.embeddingModel);
    const cached = this.cache.embeddings[key];
    if (cached?.vector) {
      this.stats.embeddingHits += 1;
      this.recordCacheHit("embedding", this.settings.embeddingModel);
      return [...cached.vector];
    }

    this.stats.embeddingMisses += 1;
    const vector = await this.inner.embedText(text);
    this.cache.embeddings[key] = {
      createdAt: nowIso(),
      textHash: hashString(text),
      model: this.settings.embeddingModel,
      vector: [...vector]
    };
    return vector;
  }

  async synthesizeSummary(args: SynthesizeSummaryArgs): Promise<string> {
    const key = nodeSummaryCacheKey(args, this.settings.extractionModel);
    const cached = this.cache.nodeSummaries[key];
    if (cached?.text) {
      this.stats.nodeSummaryHits += 1;
      this.recordCacheHit("node_summary_synthesis", this.settings.extractionModel);
      return cached.text;
    }

    this.stats.nodeSummaryMisses += 1;
    const text = await this.inner.synthesizeSummary(args);
    this.cache.nodeSummaries[key] = {
      createdAt: nowIso(),
      inputHash: hashSummaryArgs(args),
      model: this.settings.extractionModel,
      promptVersion: NODE_SUMMARY_PROMPT_VERSION,
      text
    };
    return text;
  }

  async synthesizeSummariesBatch(
    args: SynthesizeSummaryArgs[]
  ): Promise<Array<{ key: string; summary: string }>> {
    const results: Array<{ key: string; summary: string }> = [];
    const misses: SynthesizeSummaryArgs[] = [];

    for (const arg of args) {
      const cacheKey = nodeSummaryCacheKey(arg, this.settings.extractionModel);
      const resultKey = arg.key || cacheKey;
      const cached = this.cache.nodeSummaries[cacheKey];
      if (cached?.text) {
        this.stats.nodeSummaryHits += 1;
        this.recordCacheHit("node_summary_synthesis", this.settings.extractionModel);
        results.push({ key: resultKey, summary: cached.text });
      } else {
        this.stats.nodeSummaryMisses += 1;
        misses.push({ ...arg, key: resultKey });
      }
    }

    if (misses.length === 0) {
      return results;
    }

    const missedResults = this.inner.synthesizeSummariesBatch
      ? await this.inner.synthesizeSummariesBatch(misses)
      : await Promise.all(
          misses.map(async (arg) => ({
            key: arg.key || nodeSummaryCacheKey(arg, this.settings.extractionModel),
            summary: await this.inner.synthesizeSummary(arg)
          }))
        );

    for (const result of missedResults) {
      const arg = misses.find((candidate) => candidate.key === result.key);
      if (!arg) {
        continue;
      }
      const cacheKey = nodeSummaryCacheKey(arg, this.settings.extractionModel);
      this.cache.nodeSummaries[cacheKey] = {
        createdAt: nowIso(),
        inputHash: hashSummaryArgs(arg),
        model: this.settings.extractionModel,
        promptVersion: NODE_SUMMARY_PROMPT_VERSION,
        text: result.summary
      };
      results.push(result);
    }

    return results;
  }

  async synthesizeAgentContextProfile(args: SynthesizeAgentContextArgs): Promise<string> {
    if (!this.inner.synthesizeAgentContextProfile) {
      return "";
    }

    const key = agentContextCacheKey(args, this.settings.extractionModel);
    const cached = this.cache.agentContext[key];
    if (cached?.text) {
      this.stats.agentContextHits += 1;
      this.recordCacheHit("agent_context_synthesis", this.settings.extractionModel);
      return cached.text;
    }

    this.stats.agentContextMisses += 1;
    const text = await this.inner.synthesizeAgentContextProfile(args);
    this.cache.agentContext[key] = {
      createdAt: nowIso(),
      inputHash: hashAgentContextArgs(args),
      model: this.settings.extractionModel,
      promptVersion: AGENT_CONTEXT_PROMPT_VERSION,
      text
    };
    return text;
  }

  private recordCacheHit(phase: ApiUsageEvent["phase"], model: string): void {
    this.cacheUsageEvents.push({
      phase,
      model,
      cached: true,
      timestamp: nowIso()
    });
  }
}

export function extractionCacheKey(
  conversation: ParsedConversation,
  settings: PersonalContextGraphSettings
): string {
  return hashString(
    stableStringify({
      kind: "extraction",
      sourceId: conversation.sourceId,
      transcriptHash: transcriptHash(conversation, settings.maxPromptChars),
      createTime: conversation.createTime || "",
      updateTime: conversation.updateTime || "",
      rawMessageCount: conversation.rawMessageCount,
      model: settings.extractionModel,
      promptVersion: EXTRACTION_PROMPT_VERSION,
      maxPromptChars: settings.maxPromptChars
    })
  );
}

export function selfModelCacheKey(
  conversation: ParsedConversation,
  baseExtraction: ExtractedContext,
  settings: PersonalContextGraphSettings
): string {
  return hashString(
    stableStringify({
      kind: "self-model",
      sourceId: conversation.sourceId,
      transcriptHash: transcriptHash(conversation, settings.maxPromptChars),
      createTime: conversation.createTime || "",
      updateTime: conversation.updateTime || "",
      rawMessageCount: conversation.rawMessageCount,
      baseExtractionHash: hashString(stableStringify(baseExtraction)),
      model: settings.extractionModel,
      promptVersion: SELF_MODEL_PROMPT_VERSION,
      maxPromptChars: settings.maxPromptChars
    })
  );
}

export function embeddingCacheKey(text: string, model: string): string {
  return hashString(
    stableStringify({
      kind: "embedding",
      textHash: hashString(text),
      model
    })
  );
}

export function nodeSummaryCacheKey(args: SynthesizeSummaryArgs, model: string): string {
  return hashString(
    stableStringify({
      kind: "node-summary",
      type: args.type,
      label: args.label,
      evidenceHash: hashString(stableStringify(args.evidenceQuotes)),
      model,
      promptVersion: NODE_SUMMARY_PROMPT_VERSION
    })
  );
}

export function agentContextCacheKey(args: SynthesizeAgentContextArgs, model: string): string {
  return hashString(
    stableStringify({
      kind: "agent-context",
      inputHash: hashAgentContextArgs(args),
      model,
      promptVersion: AGENT_CONTEXT_PROMPT_VERSION
    })
  );
}

function transcriptHash(conversation: ParsedConversation, maxPromptChars: number): string {
  return hashString(conversationToPrompt(conversation, maxPromptChars));
}

function hashSummaryArgs(args: SynthesizeSummaryArgs): string {
  return hashString(
    stableStringify({
      type: args.type,
      label: args.label,
      evidenceQuotes: args.evidenceQuotes
    })
  );
}

function hashAgentContextArgs(args: SynthesizeAgentContextArgs): string {
  return hashString(stableStringify(args));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function asRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
