import type { ParsedConversation } from "./types";
import { truncate } from "./text";

export function conversationToTranscript(conversation: ParsedConversation): string {
  return conversation.turns
    .map((turn) => {
      const timestamp = turn.createTime ? ` ${turn.createTime}` : "";
      const author = turn.authorName ? `/${turn.authorName}` : "";
      return `### ${turn.role}${author}${timestamp}\n${turn.text}`;
    })
    .join("\n\n");
}

export function conversationToPrompt(conversation: ParsedConversation, maxChars: number): string {
  const header = [
    `Title: ${conversation.title}`,
    `Source ID: ${conversation.sourceId}`,
    conversation.createTime ? `Created: ${conversation.createTime}` : undefined,
    conversation.updateTime ? `Updated: ${conversation.updateTime}` : undefined
  ]
    .filter(Boolean)
    .join("\n");

  return `${header}\n\nTranscript:\n${truncate(conversationToTranscript(conversation), maxChars)}`;
}
