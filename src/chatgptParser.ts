import JSZip from "jszip";
import type { ChatRole, ConversationTurn, ParsedConversation } from "./types";
import { formatDateFromUnix, hashString } from "./text";

interface ChatGptExportConversation {
  id?: string;
  conversation_id?: string;
  title?: string;
  create_time?: unknown;
  update_time?: unknown;
  mapping?: Record<string, ChatGptMappingNode>;
}

interface ChatGptMappingNode {
  id?: string;
  message?: ChatGptMessage | null;
}

interface ChatGptMessage {
  id?: string;
  author?: {
    role?: string;
    name?: string;
  };
  create_time?: unknown;
  update_time?: unknown;
  content?: {
    content_type?: string;
    parts?: unknown[];
    text?: unknown;
  };
}

export class ChatGptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatGptParseError";
  }
}

export async function parseChatGptExportZip(
  arrayBuffer: ArrayBuffer
): Promise<ParsedConversation[]> {
  let zip: JSZip;

  try {
    zip = await JSZip.loadAsync(arrayBuffer);
  } catch (error) {
    throw new ChatGptParseError(
      `Could not read ZIP file. ${error instanceof Error ? error.message : ""}`.trim()
    );
  }

  const conversationFiles = Object.values(zip.files)
    .filter((file) => isConversationJsonFile(file.name))
    .sort((left, right) => left.name.localeCompare(right.name));

  if (conversationFiles.length === 0) {
    throw new ChatGptParseError(
      "This ZIP does not contain conversations.json or conversations-000.json style files. V1 supports ChatGPT export ZIPs only."
    );
  }

  const conversations: ParsedConversation[] = [];
  for (const file of conversationFiles) {
    const jsonText = await file.async("text");
    try {
      conversations.push(...parseChatGptConversationsJson(jsonText));
    } catch (error) {
      if (error instanceof ChatGptParseError) {
        throw new ChatGptParseError(`${file.name}: ${error.message}`);
      }

      throw error;
    }
  }

  return conversations;
}

export function parseChatGptConversationsJson(jsonText: string): ParsedConversation[] {
  let raw: unknown;

  try {
    raw = JSON.parse(jsonText);
  } catch (error) {
    throw new ChatGptParseError(
      `conversations.json is not valid JSON. ${
        error instanceof Error ? error.message : ""
      }`.trim()
    );
  }

  if (!Array.isArray(raw)) {
    throw new ChatGptParseError("conversations.json must contain an array of conversations.");
  }

  return raw
    .map((conversation, index) =>
      parseConversation(conversation as ChatGptExportConversation, index)
    )
    .filter((conversation) => conversation.turns.length > 0);
}

function parseConversation(
  conversation: ChatGptExportConversation,
  index: number
): ParsedConversation {
  const title = normalizeTitle(conversation.title, index);
  const createTime = formatDateFromUnix(conversation.create_time);
  const updateTime = formatDateFromUnix(conversation.update_time);
  const sourceId =
    conversation.id ||
    conversation.conversation_id ||
    `chatgpt-${hashString(`${title}-${createTime || ""}-${updateTime || ""}-${index}`)}`;

  const nodes = Object.entries(conversation.mapping || {});
  const turns = nodes
    .map(([nodeId, node]) => parseTurn(nodeId, node.message || undefined))
    .filter((turn): turn is ConversationTurn => Boolean(turn))
    .sort(compareTurns);

  return {
    source: "chatgpt",
    sourceId,
    title,
    createTime,
    updateTime,
    turns,
    rawMessageCount: nodes.length
  };
}

function parseTurn(nodeId: string, message?: ChatGptMessage): ConversationTurn | undefined {
  if (!message) {
    return undefined;
  }

  const text = extractMessageText(message.content);
  if (!text.trim()) {
    return undefined;
  }

  return {
    id: message.id || nodeId,
    role: normalizeRole(message.author?.role),
    authorName: message.author?.name,
    text: text.trim(),
    createTime: formatDateFromUnix(message.create_time),
    updateTime: formatDateFromUnix(message.update_time)
  };
}

function extractMessageText(content: ChatGptMessage["content"]): string {
  if (!content) {
    return "";
  }

  if (Array.isArray(content.parts)) {
    return content.parts.map(formatPart).filter(Boolean).join("\n\n");
  }

  if (typeof content.text === "string") {
    return content.text;
  }

  return "";
}

function formatPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }

  if (!part) {
    return "";
  }

  if (typeof part === "object") {
    return JSON.stringify(part);
  }

  return String(part);
}

function normalizeRole(role: string | undefined): ChatRole {
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") {
    return role;
  }

  return "unknown";
}

function normalizeTitle(title: string | undefined, index: number): string {
  const cleaned = title?.trim();
  return cleaned || `Untitled ChatGPT Conversation ${index + 1}`;
}

function compareTurns(left: ConversationTurn, right: ConversationTurn): number {
  if (left.createTime && right.createTime) {
    return left.createTime.localeCompare(right.createTime);
  }

  if (left.createTime) {
    return -1;
  }

  if (right.createTime) {
    return 1;
  }

  return left.id.localeCompare(right.id);
}

function isConversationJsonFile(path: string): boolean {
  const fileName = path.split("/").pop() || path;
  return fileName === "conversations.json" || /^conversations-\d+\.json$/.test(fileName);
}
