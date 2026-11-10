import type { ChatMessage } from './client';

export class Conversation {
  private readonly maxTurns: number;
  private history: ChatMessage[] = [];

  constructor(maxTurns: number = 20) {
    this.maxTurns = maxTurns;
  }

  add(message: ChatMessage): void {
    this.history.push({ role: message.role, content: message.content });
    this.trim();
  }

  messages(): ChatMessage[] {
    // Return detached snapshot excluding system messages (not sent to model)
    return this.history
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));
  }

  private trim(): void {
    // Count exchanges: a user message followed by an assistant message is one exchange.
    // Keep last maxTurns exchanges.
    // Never orphan an assistant prefix (assistant without preceding user).
    // System messages are kept in history but don't count as exchanges.

    // Find indices of user messages (non-system)
    const userIndices: number[] = [];
    for (let i = 0; i < this.history.length; i++) {
      if (this.history[i].role === 'user') {
        userIndices.push(i);
      }
    }

    if (userIndices.length <= this.maxTurns) return;

    // We need to remove the oldest exchanges
    const excess = userIndices.length - this.maxTurns;
    const removeUpTo = userIndices[excess]; // index of the first user message to keep

    // Find the start: we want to keep from removeUpTo onward
    // But also keep any system messages that come before the first kept user message
    // Actually, system messages are not part of exchanges, so we just trim from the beginning
    // up to (but not including) the first system message before removeUpTo, or removeUpTo itself

    // Find the earliest index to keep: the first non-system message at or after removeUpTo
    // But we also want to keep system messages interspersed
    // Simple approach: remove everything before removeUpTo that is not a system message
    // Actually simplest: just slice from removeUpTo, but preserve leading system messages

    // Find the first system message before removeUpTo that should be kept
    let startIdx = removeUpTo;
    // Walk back to include any leading system messages that precede the first kept exchange
    // Actually, system messages between exchanges should be kept if they're after the trim point
    // Let's just trim from the start up to removeUpTo
    this.history = this.history.slice(removeUpTo);

    // Never orphan assistant prefix: if first message is assistant, remove it
    while (this.history.length > 0 && this.history[0].role === 'assistant') {
      this.history.shift();
    }
  }
}
