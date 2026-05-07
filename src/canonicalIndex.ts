import type { Vault } from "obsidian";
import type { PersonalContextGraphSettings } from "./settings";
import {
  CONTEXT_NODE_LABEL,
  CONTEXT_NODE_TYPES,
  type CanonicalNodeSeed,
  type ContextNodeType,
  type NodeEvidence
} from "./types";
import { hashString, slugify } from "./text";

interface ParsedManagedFile {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

export async function loadCanonicalNodeSeeds(
  vault: Vault,
  settings: Pick<PersonalContextGraphSettings, "outputFolder">
): Promise<CanonicalNodeSeed[]> {
  const outputFolder = normalizeVaultPath(settings.outputFolder);
  const managedFiles: ParsedManagedFile[] = [];

  for (const file of vault.getFiles()) {
    if (!isInsideOutputFolder(file.path, outputFolder)) {
      continue;
    }

    const content = await vault.read(file);
    const frontmatter = parseFrontmatter(content);
    if (frontmatter.pcg_managed !== true) {
      continue;
    }

    managedFiles.push({ path: file.path, frontmatter, content });
  }

  const sourceIdByPath = buildSourceIdMap(managedFiles);
  return managedFiles
    .map((file) => managedFileToSeed(file, sourceIdByPath))
    .filter((seed): seed is CanonicalNodeSeed => Boolean(seed));
}

export function parseManagedCanonicalSeed(
  path: string,
  content: string,
  sourceIdByPath: Record<string, string> = {}
): CanonicalNodeSeed | undefined {
  return managedFileToSeed(
    {
      path,
      content,
      frontmatter: parseFrontmatter(content)
    },
    sourceIdByPath
  );
}

function buildSourceIdMap(files: ParsedManagedFile[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const file of files) {
    if (file.frontmatter.pcg_type !== "source_conversation") {
      continue;
    }

    const sourceId = asString(file.frontmatter.pcg_source_id);
    if (!sourceId) {
      continue;
    }

    map[withoutMarkdownExtension(file.path)] = sourceId;
    map[file.path] = sourceId;
  }

  return map;
}

function managedFileToSeed(
  file: ParsedManagedFile,
  sourceIdByPath: Record<string, string>
): CanonicalNodeSeed | undefined {
  const type = asContextNodeType(file.frontmatter.pcg_type);
  if (!type || file.frontmatter.pcg_managed !== true) {
    return undefined;
  }

  const label = extractLabel(file.content, type) || basenameWithoutMarkdown(file.path);
  const aliases = asStringArray(file.frontmatter.pcg_aliases);
  const evidence = parseEvidence(file.content, sourceIdByPath);
  const sourceIds = uniqueStrings([
    ...asStringArray(file.frontmatter.pcg_source_ids),
    ...evidence.map((entry) => entry.sourceId)
  ]);

  return {
    type,
    id: asString(file.frontmatter.pcg_id) || `${type}_${slugify(label)}`,
    label,
    slug: slugify(label),
    aliases,
    path: file.path,
    summary: extractSection(file.content, "Summary") || "",
    confidence: asNumber(file.frontmatter.pcg_confidence, 0),
    evidence,
    sourceIds,
    lastSeen: asString(file.frontmatter.pcg_last_seen)
  };
}

function parseEvidence(
  content: string,
  sourceIdByPath: Record<string, string>
): NodeEvidence[] {
  const section = extractSection(content, "Evidence");
  if (!section || /No evidence captured/i.test(section)) {
    return [];
  }

  const evidence: NodeEvidence[] = [];
  for (const line of section.split("\n")) {
    const parsed = parseEvidenceLine(line);
    if (!parsed) {
      continue;
    }

    evidence.push({
      sourceId:
        sourceIdByPath[parsed.sourcePath] ||
        sourceIdByPath[withoutMarkdownExtension(parsed.sourcePath)] ||
        `seed_${hashString(parsed.sourcePath)}`,
      sourceTitle: parsed.sourceTitle,
      sourcePath: parsed.sourcePath,
      quote: parsed.quote,
      confidence: parsed.confidence
    });
  }

  return evidence;
}

function parseEvidenceLine(
  line: string
): Pick<NodeEvidence, "sourceTitle" | "sourcePath" | "quote" | "confidence"> | undefined {
  const wikiMatch = /^- \[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\] \(([\d.]+)\): "?(.+?)"?$/.exec(
    line
  );
  if (wikiMatch) {
    const sourcePath = wikiMatch[1].trim();
    const confidence = Number.parseFloat(wikiMatch[3] || "0");
    return {
      sourcePath,
      sourceTitle: (wikiMatch[2] || basenameWithoutMarkdown(sourcePath)).trim(),
      confidence: Number.isFinite(confidence) ? confidence : 0,
      quote: (wikiMatch[4] || "").replace(/^"|"$/g, "").trim()
    };
  }

  const plainMatch = /^- (.+?) \((.+?)\) \(([\d.]+)\): "?(.+?)"?$/.exec(line);
  if (plainMatch) {
    const confidence = Number.parseFloat(plainMatch[3] || "0");
    return {
      sourceTitle: plainMatch[1].trim(),
      sourcePath: plainMatch[2].trim(),
      confidence: Number.isFinite(confidence) ? confidence : 0,
      quote: (plainMatch[4] || "").replace(/^"|"$/g, "").trim()
    };
  }

  return undefined;
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) {
    return {};
  }

  const result: Record<string, unknown> = {};
  const lines = match[1].split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const keyMatch = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (!keyMatch) {
      continue;
    }

    const key = keyMatch[1];
    const value = keyMatch[2] || "";
    if (value) {
      result[key] = parseScalar(value);
      continue;
    }

    const values: unknown[] = [];
    while (index + 1 < lines.length && /^  - /.test(lines[index + 1])) {
      index += 1;
      values.push(parseScalar(lines[index].replace(/^  - /, "")));
    }
    result[key] = values;
  }

  return result;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function extractLabel(content: string, type: ContextNodeType): string | undefined {
  const label = CONTEXT_NODE_LABEL[type];
  const match = new RegExp(`^#\\s+${escapeRegExp(label)}:\\s+(.+)$`, "m").exec(content);
  return match?.[1]?.trim();
}

function extractSection(content: string, heading: string): string | undefined {
  const headingMatch = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m").exec(content);
  if (!headingMatch) {
    return undefined;
  }

  const rest = content.slice(headingMatch.index + headingMatch[0].length).replace(/^\n/, "");
  const nextHeading = /^##\s+/m.exec(rest);
  return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
}

function asContextNodeType(value: unknown): ContextNodeType | undefined {
  return CONTEXT_NODE_TYPES.includes(value as ContextNodeType)
    ? (value as ContextNodeType)
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isInsideOutputFolder(path: string, outputFolder: string): boolean {
  const normalized = normalizeVaultPath(path);
  return normalized === outputFolder || normalized.startsWith(`${outputFolder}/`);
}

function normalizeVaultPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function basenameWithoutMarkdown(path: string): string {
  return path.split("/").pop()?.replace(/\.md$/i, "") || "Untitled";
}

function withoutMarkdownExtension(path: string): string {
  return path.replace(/\.md$/i, "");
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
