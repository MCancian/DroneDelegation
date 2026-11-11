import type { ChatMessage } from '../ai/client';
import { streamChat, getAiHealth } from '../ai/client';
import { Conversation } from '../ai/conversation';
import { decodeActionBlock, extractActionBlocks } from '../ai/actionBlocks';

export interface ChatPanel {
  appendNotice(text: string): void;
  appendAuto(text: string): void;
  destroy(): void;
}

export interface ChatOptions {
  getMessages?: (conversation: readonly ChatMessage[]) => ChatMessage[];
  onReply?: (text: string, playerText: string) => void;
  isEnded?: () => boolean;
}

interface ActionCard {
  action: string;
  target?: string;
  reason?: string;
  extra?: string;
}

type Segment =
  | { type: 'text'; content: string }
  | { type: 'card'; card: ActionCard }
  | { type: 'malformed'; content: string };

export function parseActionBlocks(text: string): { segments: Segment[] } {
  const segments: Segment[] = [];
  let lastIndex = 0;

  for (const block of extractActionBlocks(text)) {
    if (block.start > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, block.start) });
    }
    const jsonStr = block.content;
    let items: unknown[];
    try {
      items = decodeActionBlock(jsonStr);
    } catch {
      segments.push({ type: 'malformed', content: jsonStr });
      lastIndex = block.end;
      continue;
    }
    for (const item of items) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        segments.push({ type: 'malformed', content: JSON.stringify(item) });
        continue;
      }
      const parsed = item as Record<string, unknown>;
      if (typeof parsed.action === 'string') {
        const card: ActionCard = { action: parsed.action };
        if (typeof parsed.target === 'string') card.target = parsed.target;
        if (typeof parsed.reason === 'string') card.reason = parsed.reason;
        const extras: string[] = [];
        for (const key of Object.keys(parsed)) {
          if (key === 'action' || key === 'target' || key === 'reason') continue;
          const val = parsed[key];
          if (typeof val === 'string' || typeof val === 'number') {
            extras.push(`${key}=${val}`);
          }
        }
        if (extras.length > 0) card.extra = extras.join(' ');
        segments.push({ type: 'card', card });
      } else {
        segments.push({ type: 'malformed', content: JSON.stringify(item) });
      }
    }
    lastIndex = block.end;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return { segments };
}

function renderMessageContent(container: HTMLElement, text: string): void {
  const { segments } = parseActionBlocks(text);
  for (const seg of segments) {
    if (seg.type === 'text') {
      const span = document.createElement('span');
      span.className = 'chat-text';
      span.textContent = seg.content;
      container.appendChild(span);
    } else if (seg.type === 'card') {
      const card = document.createElement('div');
      card.className = 'chat-action-card';
      const actionEl = document.createElement('span');
      actionEl.className = 'chat-action-card-action';
      actionEl.textContent = seg.card.action;
      card.appendChild(actionEl);
      const targetEl = document.createElement('span');
      targetEl.className = 'chat-action-card-target';
      targetEl.textContent = seg.card.target ?? 'own ship';
      card.appendChild(targetEl);
      if (seg.card.reason) {
        const reasonEl = document.createElement('span');
        reasonEl.className = 'chat-action-card-reason';
        reasonEl.textContent = seg.card.reason;
        card.appendChild(reasonEl);
      }
      if (seg.card.extra) {
        const extraEl = document.createElement('span');
        extraEl.className = 'chat-action-card-extra';
        extraEl.textContent = seg.card.extra;
        card.appendChild(extraEl);
      }
      container.appendChild(card);
    } else {
      const span = document.createElement('span');
      span.className = 'chat-text chat-malformed';
      span.textContent = `[malformed action block] ${seg.content}`;
      container.appendChild(span);
    }
  }
}

export function createChat(root: HTMLElement, options?: ChatOptions): ChatPanel {
  while (root.firstChild) {
    root.removeChild(root.firstChild);
  }

  const conversation = new Conversation(20);
  let destroyed = false;
  let streaming = false;
  let abortController: AbortController | null = null;
  let healthTimer: ReturnType<typeof setTimeout> | null = null;
  let healthAbort: AbortController | null = null;
  let healthInFlight = false;
  let online = false;

  const header = document.createElement('div');
  header.className = 'chat-header';
  const title = document.createElement('h2');
  title.textContent = 'Chat';
  header.appendChild(title);
  const badge = document.createElement('span');
  badge.className = 'chat-badge chat-badge-offline';
  badge.textContent = 'OFFLINE';
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-label', 'AI connection status');
  header.appendChild(badge);
  root.appendChild(header);

  const messagesEl = document.createElement('div');
  messagesEl.className = 'chat-messages';
  root.appendChild(messagesEl);

  const inputRow = document.createElement('div');
  inputRow.className = 'chat-input-row';

  const input = document.createElement('textarea');
  input.className = 'chat-input';
  input.placeholder = 'Message Jarvis...';
  input.rows = 1;
  input.disabled = true;
  input.setAttribute('aria-label', 'Chat message input');
  inputRow.appendChild(input);

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'chat-send-btn';
  sendBtn.textContent = 'Send';
  sendBtn.disabled = true;
  inputRow.appendChild(sendBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'chat-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.display = 'none';
  inputRow.appendChild(cancelBtn);

  root.appendChild(inputRow);

  const noticeEl = document.createElement('div');
  noticeEl.className = 'chat-notice';
  noticeEl.textContent = 'AI assistant offline \u2014 doctrine and crew still operate';
  root.appendChild(noticeEl);

  let typingEl: HTMLElement | null = null;

  function showTyping(): void {
    if (typingEl) return;
    typingEl = document.createElement('div');
    typingEl.className = 'chat-typing';
    typingEl.textContent = 'Jarvis is typing...';
    messagesEl.appendChild(typingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideTyping(): void {
    if (typingEl) {
      typingEl.remove();
      typingEl = null;
    }
  }

  function appendMessage(role: string, text: string, renderCards: boolean = false): HTMLElement {
    const msg = document.createElement('div');
    msg.className = `chat-msg chat-msg-${role}`;
    const label = document.createElement('span');
    label.className = 'chat-msg-label';
    if (role === 'user') label.textContent = 'You';
    else if (role === 'assistant') label.textContent = 'Jarvis';
    else if (role === 'auto') label.textContent = '[AUTO]';
    else if (role === 'system') label.textContent = 'SYSTEM';
    msg.appendChild(label);

    const content = document.createElement('div');
    content.className = 'chat-msg-content';
    if (renderCards) {
      renderMessageContent(content, text);
    } else {
      content.textContent = text;
    }
    msg.appendChild(content);
    messagesEl.appendChild(msg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return msg;
  }

  function appendNotice(text: string): void {
    if (destroyed) return;
    appendMessage('system', text);
  }

  function appendAuto(text: string): void {
    if (destroyed) return;
    appendMessage('auto', text, true);
  }

  function updateOnlineState(isOnline: boolean): void {
    online = isOnline;
    if (isOnline) {
      badge.className = 'chat-badge chat-badge-online';
      badge.textContent = 'ONLINE';
      noticeEl.style.display = 'none';
      if (!streaming && !options?.isEnded?.()) {
        input.disabled = false;
        sendBtn.disabled = false;
      }
    } else {
      badge.className = 'chat-badge chat-badge-offline';
      badge.textContent = 'OFFLINE';
      noticeEl.style.display = '';
      input.disabled = true;
      sendBtn.disabled = true;
    }
  }

  async function pollHealth(): Promise<void> {
    if (destroyed || healthInFlight) return;
    healthInFlight = true;
    healthAbort = new AbortController();
    try {
      const health = await getAiHealth(healthAbort.signal);
      if (!destroyed) {
        updateOnlineState(health.online);
      }
    } catch {
      if (!destroyed) {
        updateOnlineState(false);
      }
    } finally {
      healthInFlight = false;
      if (!destroyed) {
        healthTimer = setTimeout(pollHealth, 15000);
      }
    }
  }

  pollHealth();

  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });

  async function send(): Promise<void> {
    if (destroyed || streaming) return;
    if (!online) return;
    if (options?.isEnded?.()) return;

    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    conversation.add({ role: 'user', content: text });
    appendMessage('user', text);

    streaming = true;
    input.disabled = true;
    sendBtn.disabled = true;
    cancelBtn.style.display = '';

    abortController = new AbortController();

    showTyping();

    let fullText = '';

    try {
      const getMsgs = options?.getMessages ?? ((conv: readonly ChatMessage[]) => conv.map((m) => ({ role: m.role, content: m.content })));
      const msgs = getMsgs(conversation.messages());

      await streamChat(
        msgs,
        (delta: string) => {
          if (destroyed || abortController?.signal.aborted) return;
          fullText += delta;
          hideTyping();
          let streamMsg = messagesEl.querySelector('.chat-streaming') as HTMLElement | null;
          if (!streamMsg) {
            streamMsg = document.createElement('div');
            streamMsg.className = 'chat-msg chat-msg-assistant chat-streaming';
            const lbl = document.createElement('span');
            lbl.className = 'chat-msg-label';
            lbl.textContent = 'Jarvis';
            streamMsg.appendChild(lbl);
            const content = document.createElement('div');
            content.className = 'chat-msg-content';
            streamMsg.appendChild(content);
            messagesEl.appendChild(streamMsg);
          }
          const contentEl = streamMsg.querySelector('.chat-msg-content');
          if (contentEl) {
            contentEl.textContent = fullText;
          }
          messagesEl.scrollTop = messagesEl.scrollHeight;
        },
        abortController.signal,
      );

      if (destroyed || abortController.signal.aborted) {
        hideTyping();
        const streamMsg = messagesEl.querySelector('.chat-streaming') as HTMLElement | null;
        if (streamMsg) streamMsg.remove();
        return;
      }

      hideTyping();
      const streamMsg = messagesEl.querySelector('.chat-streaming') as HTMLElement | null;
      if (streamMsg) {
        streamMsg.remove();
      }

      if (fullText.length > 0) {
        conversation.add({ role: 'assistant', content: fullText });
        appendMessage('assistant', fullText, true);

        if (options?.onReply) {
          options.onReply(fullText, text);
        }
      }
    } catch (err: unknown) {
      hideTyping();
      const streamMsg = messagesEl.querySelector('.chat-streaming') as HTMLElement | null;
      if (streamMsg) {
        streamMsg.remove();
      }

      if (destroyed) return;

      if (err instanceof DOMException && err.name === 'AbortError') {
        appendNotice('Response cancelled.');
      } else {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        appendNotice(`Error: ${msg}`);
      }
    } finally {
      streaming = false;
      abortController = null;
      cancelBtn.style.display = 'none';
      if (!destroyed && online && !options?.isEnded?.()) {
        input.disabled = false;
        sendBtn.disabled = false;
      }
    }
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !composing) {
      event.preventDefault();
      send();
    }
  }

  input.addEventListener('keydown', handleKeyDown);

  sendBtn.addEventListener('click', () => {
    send();
  });

  cancelBtn.addEventListener('click', () => {
    if (abortController) {
      abortController.abort();
    }
  });

  function destroy(): void {
    destroyed = true;
    if (healthTimer !== null) {
      clearTimeout(healthTimer);
      healthTimer = null;
    }
    if (healthAbort) {
      healthAbort.abort();
      healthAbort = null;
    }
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    input.removeEventListener('keydown', handleKeyDown);
    while (root.firstChild) {
      root.removeChild(root.firstChild);
    }
  }

  return { appendNotice, appendAuto, destroy };
}
