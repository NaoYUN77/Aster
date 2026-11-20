export interface TextRequest {
  requestId: string;
  /** Delivery target: the chat or channel the reply goes to. Never the conversation that answers. */
  conversationId: string;
  senderId: string;
  text: string;
  /** Thread to answer in, when the request arrived inside one. Absent means a flat reply. */
  threadTs?: string;
  /**
   * The inbound message's own id at the channel, when the channel has one. It stays part of the
   * durable request format; absent means the channel cannot address the message it received.
   */
  messageTs?: string;
}

export function splitReply(text: string, limit = 4000): string[] {
  if (!Number.isInteger(limit) || limit < 2) throw new Error("Reply chunk limit must be at least 2");
  const chunks: string[] = [];
  let chunk = "";
  for (const character of text) {
    if (chunk.length + character.length > limit) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
