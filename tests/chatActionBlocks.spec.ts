import { describe, it, expect } from 'vitest';
import { parseActionBlocks } from '../src/ui/chat';

describe('chat action cards', () => {
  const first = { action: 'hail', target: 'S-05', reason: 'unknown no-AIS closing contact' };
  const second = { action: 'hail', target: 'S-08', reason: 'unknown no-AIS closing contact' };

  it.each([
    JSON.stringify(first) + '\n' + JSON.stringify(second),
    JSON.stringify([first, second]),
  ])('renders both actions with surrounding prose intact: %s', (content) => {
    expect(parseActionBlocks(`Before\n\`\`\`action\n${content}\n\`\`\`\nAfter`).segments).toEqual([
      { type: 'text', content: 'Before\n' },
      { type: 'card', card: first },
      { type: 'card', card: second },
      { type: 'text', content: '\nAfter' },
    ]);
  });

  it('preserves single-object cards and maneuver fields with CRLF fences', () => {
    expect(parseActionBlocks('```ACTION\r\n{"action":"maneuver","courseDeg":180,"speedKts":20}\r\n```').segments).toEqual([
      { type: 'card', card: { action: 'maneuver', extra: 'courseDeg=180 speedKts=20' } },
    ]);
  });

  it('shows malformed JSON without rendering any partial actions', () => {
    const content = JSON.stringify(first) + '\n{bad json}';
    expect(parseActionBlocks(`\`\`\`action\n${content}\n\`\`\``).segments).toEqual([
      { type: 'malformed', content },
    ]);
  });

  it('handles invalid array entries without hiding valid cards', () => {
    const content = JSON.stringify([null, [], {}, first]);
    expect(parseActionBlocks(`\`\`\`action\n${content}\n\`\`\``).segments).toEqual([
      { type: 'malformed', content: 'null' },
      { type: 'malformed', content: '[]' },
      { type: 'malformed', content: '{}' },
      { type: 'card', card: first },
    ]);
  });
});
