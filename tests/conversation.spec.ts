import { describe, it, expect } from 'vitest';
import { Conversation } from '../src/ai/conversation';
import type { ChatMessage } from '../src/ai/client';

function user(content: string): ChatMessage {
  return { role: 'user', content };
}

function assistant(content: string): ChatMessage {
  return { role: 'assistant', content };
}

function system(content: string): ChatMessage {
  return { role: 'system', content };
}

describe('Conversation', () => {
  it('starts empty', () => {
    const conv = new Conversation(20);
    expect(conv.messages()).toEqual([]);
  });

  it('adds and retrieves messages', () => {
    const conv = new Conversation(20);
    conv.add(user('hello'));
    conv.add(assistant('hi there'));
    const msgs = conv.messages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'user', content: 'hello' });
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'hi there' });
  });

  it('excludes system messages from messages()', () => {
    const conv = new Conversation(20);
    conv.add(system('you are a helpful assistant'));
    conv.add(user('hello'));
    conv.add(assistant('hi'));
    const msgs = conv.messages();
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m) => m.role !== 'system')).toBe(true);
  });

  it('returns detached snapshots (mutation does not affect internal state)', () => {
    const conv = new Conversation(20);
    conv.add(user('hello'));
    const msgs = conv.messages();
    msgs[0].content = 'MUTATED';
    const msgs2 = conv.messages();
    expect(msgs2[0].content).toBe('hello');
  });

  it('returns new array each call', () => {
    const conv = new Conversation(20);
    conv.add(user('a'));
    const m1 = conv.messages();
    const m2 = conv.messages();
    expect(m1).not.toBe(m2);
    expect(m1).toEqual(m2);
  });

  it('trims to maxTurns exchanges', () => {
    const conv = new Conversation(3);
    for (let i = 0; i < 5; i++) {
      conv.add(user(`msg${i}`));
      conv.add(assistant(`reply${i}`));
    }
    const msgs = conv.messages();
    // Should keep last 3 exchanges = 6 messages
    expect(msgs).toHaveLength(6);
    expect(msgs[0]).toEqual({ role: 'user', content: 'msg2' });
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'reply2' });
    expect(msgs[4]).toEqual({ role: 'user', content: 'msg4' });
    expect(msgs[5]).toEqual({ role: 'assistant', content: 'reply4' });
  });

  it('never orphans assistant prefix after trim', () => {
    const conv = new Conversation(2);
    conv.add(user('a'));
    conv.add(assistant('r1'));
    conv.add(user('b'));
    conv.add(assistant('r2'));
    conv.add(user('c'));
    conv.add(assistant('r3'));
    // Trim to 2: should remove first exchange
    const msgs = conv.messages();
    expect(msgs).toHaveLength(4);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('b');
  });

  it('handles orphan assistant at start after trim', () => {
    // Scenario: user, assistant, user, assistant, user (no reply yet)
    // With maxTurns=1, trimming might leave an assistant without user
    const conv = new Conversation(1);
    conv.add(user('a'));
    conv.add(assistant('r1'));
    conv.add(user('b'));
    // Only 2 user messages, maxTurns=1, so trim removes first exchange
    const msgs = conv.messages();
    // After trim: should have user('b') only (assistant r1 was orphaned and removed)
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'b' });
  });

  it('system messages do not count as exchanges', () => {
    const conv = new Conversation(2);
    conv.add(system('notice'));
    conv.add(user('a'));
    conv.add(assistant('r1'));
    conv.add(system('another notice'));
    conv.add(user('b'));
    conv.add(assistant('r2'));
    const msgs = conv.messages();
    // 2 exchanges, no trim needed
    expect(msgs).toHaveLength(4);
    expect(msgs[0].content).toBe('a');
    expect(msgs[3].content).toBe('r2');
  });

  it('default maxTurns is 20', () => {
    const conv = new Conversation();
    for (let i = 0; i < 25; i++) {
      conv.add(user(`u${i}`));
      conv.add(assistant(`a${i}`));
    }
    const msgs = conv.messages();
    // Should keep last 20 exchanges = 40 messages
    expect(msgs).toHaveLength(40);
    expect(msgs[0]).toEqual({ role: 'user', content: 'u5' });
  });

  it('handles multiple consecutive user messages', () => {
    const conv = new Conversation(2);
    conv.add(user('a'));
    conv.add(user('b'));
    conv.add(assistant('r'));
    const msgs = conv.messages();
    // 2 user messages = 2 exchanges (each user starts an exchange)
    // maxTurns=2, so no trim needed
    expect(msgs).toHaveLength(3);
  });

  it('trim removes leading orphaned assistants', () => {
    const conv = new Conversation(1);
    conv.add(user('a'));
    conv.add(assistant('r1'));
    conv.add(assistant('r2')); // extra assistant
    conv.add(user('b'));
    conv.add(assistant('r3'));
    // 2 user messages, maxTurns=1, trim removes first exchange
    // After trim from user('b'): assistant('r2') is before user('b') so it gets removed
    const msgs = conv.messages();
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('b');
  });

  it('empty conversation messages returns empty array', () => {
    const conv = new Conversation(5);
    expect(conv.messages()).toEqual([]);
  });

  it('single message no trim', () => {
    const conv = new Conversation(1);
    conv.add(user('only'));
    const msgs = conv.messages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('only');
  });
});
