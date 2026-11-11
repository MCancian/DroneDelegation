import { describe, it, expect } from 'vitest';
import { isDirectOrder, handleChatReply } from '../src/ai/chatOrders';
import { makeWorld, makeContact } from './helpers/sim';
import type { World } from '../src/sim/world';

function block(obj: Record<string, unknown>): string {
  return '```action\n' + JSON.stringify(obj) + '\n```';
}

describe('isDirectOrder', () => {
  it('accepts bare imperatives', () => {
    expect(isDirectOrder('engage A-1')).toBe(true);
    expect(isDirectOrder('deploy chaff')).toBe(true);
    expect(isDirectOrder('fire at A-1')).toBe(true);
    expect(isDirectOrder('illuminate A-1')).toBe(true);
  });
  it('accepts please/jarvis/can-you prefixes', () => {
    expect(isDirectOrder('please engage A-1')).toBe(true);
    expect(isDirectOrder('Jarvis engage A-1')).toBe(true);
    expect(isDirectOrder('can you engage A-1')).toBe(true);
    expect(isDirectOrder('could you deploy chaff')).toBe(true);
    expect(isDirectOrder('Jarvis, please engage A-1')).toBe(true);
  });
  it('rejects advice requests', () => {
    expect(isDirectOrder('should I engage A-1?')).toBe(false);
    expect(isDirectOrder('what should I do?')).toBe(false);
    expect(isDirectOrder('why is A-1 closing?')).toBe(false);
    expect(isDirectOrder('how do I engage?')).toBe(false);
    expect(isDirectOrder('recommend engaging A-1')).toBe(false);
    expect(isDirectOrder('describe A-1')).toBe(false);
  });
  it('rejects negated orders', () => {
    expect(isDirectOrder("don't engage A-1")).toBe(false);
    expect(isDirectOrder('do not fire')).toBe(false);
    expect(isDirectOrder('never deploy chaff')).toBe(false);
  });
  it('rejects conditional and hypothetical', () => {
    expect(isDirectOrder('if A-1 closes engage it')).toBe(false);
    expect(isDirectOrder('what if I engage A-1?')).toBe(false);
    expect(isDirectOrder('suppose we engage')).toBe(false);
  });
  it('rejects future-condition keywords', () => {
    expect(isDirectOrder('engage A-1 unless it turns away')).toBe(false);
    expect(isDirectOrder('deploy chaff when the missile is close')).toBe(false);
    expect(isDirectOrder('fire until the target is destroyed')).toBe(false);
    expect(isDirectOrder('engage after it enters range')).toBe(false);
    expect(isDirectOrder('deploy chaff once the missile is inbound')).toBe(false);
  });
  it('rejects quoted orders', () => {
    expect(isDirectOrder('Jarvis said "engage A-1"')).toBe(false);
  });
});

describe('handleChatReply', () => {
  function setup(): World {
    const c = makeContact({ id: 'a1', trackId: 'A-01', position: { x: 0, y: 10 } });
    return makeWorld([c]);
  }

  it('advice reply with action blocks does not execute', () => {
    const w = setup();
    const reply = `I recommend engaging.\n${block({ action: 'chaff' })}`;
    const notices = handleChatReply(w, reply, 'should I deploy chaff?');
    expect(notices.some(n => n.includes('not executed'))).toBe(true);
    expect(w.ownShip.inventory.chaff).toBe(6);
  });

  it('direct order deploys chaff consuming 1 with actor ai-chat', () => {
    const w = setup();
    const notices = handleChatReply(w, block({ action: 'chaff' }), 'deploy chaff');
    expect(w.ownShip.inventory.chaff).toBe(5);
    const ev = w.events.find(e => e.type === 'command');
    expect(ev?.actor).toBe('ai-chat');
    expect(notices.some(n => n.includes('chaff'))).toBe(true);
  });

  it.each([
    ['deploy chaff twice', 4],
    ['should I deploy chaff twice?', 6],
  ])('preserves direct-order gating for multi-object blocks: %s', (order, remaining) => {
    const w = setup();
    const reply = '```action\n{"action":"chaff"}\n{"action":"chaff"}\n```';
    const notices = handleChatReply(w, reply, order);
    expect(notices.some(n => n.includes('Error'))).toBe(false);
    expect(w.ownShip.inventory.chaff).toBe(remaining);
    if (remaining === 6) expect(notices.some(n => n.includes('not executed'))).toBe(true);
  });

  it('validation errors logged as ai-action-error', () => {
    const w = setup();
    const notices = handleChatReply(w, block({ action: 'engage_sam', target: 'zzz' }), 'engage zzz');
    expect(notices.some(n => n.includes('Error'))).toBe(true);
    expect(w.events.some(e => e.type === 'ai-action-error')).toBe(true);
  });

  it('ended scenario does not execute', () => {
    const w = setup();
    const notices = handleChatReply(w, block({ action: 'chaff' }), 'deploy chaff', true);
    expect(w.ownShip.inventory.chaff).toBe(6);
    expect(notices.some(n => n.includes('ended'))).toBe(true);
  });

  it('ship lost does not execute and shows ended notice', () => {
    const w = setup();
    w.weapons.shipLost = true;
    const notices = handleChatReply(w, block({ action: 'chaff' }), 'deploy chaff');
    expect(w.ownShip.inventory.chaff).toBe(6);
    expect(notices.some(n => n.includes('ended'))).toBe(true);
  });

  it('multiple chaff blocks revalidate inventory after first', () => {
    const w = setup();
    w.ownShip.inventory.chaff = 1;
    const reply = block({ action: 'chaff' }) + '\n' + block({ action: 'chaff' });
    const notices = handleChatReply(w, reply, 'deploy chaff twice');
    expect(w.ownShip.inventory.chaff).toBe(0);
    expect(notices.some(n => n.includes('Failed'))).toBe(true);
  });

  it('notice uses displayed track id', () => {
    const w = setup();
    const notices = handleChatReply(w, block({ action: 'engage_sam', target: 'A-01' }), 'engage A-01');
    expect(notices.some(n => n.includes('A-01'))).toBe(true);
  });

  it('conditional order does not consume inventory', () => {
    const w = setup();
    const notices = handleChatReply(w, block({ action: 'chaff' }), 'deploy chaff when ready');
    expect(w.ownShip.inventory.chaff).toBe(6);
    expect(notices.some(n => n.includes('not executed'))).toBe(true);
  });
});
