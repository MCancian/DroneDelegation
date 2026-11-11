export interface ActionBlock {
  start: number;
  end: number;
  content: string;
}

export function extractActionBlocks(text: string): ActionBlock[] {
  return Array.from(text.matchAll(/```action\s*\r?\n([\s\S]*?)```/gi), (match) => ({
    start: match.index!,
    end: match.index! + match[0].length,
    content: match[1].trim(),
  }));
}

/** Decode a JSON value or whitespace-separated JSON objects; never repair invalid JSON. */
export function decodeActionBlock(content: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Models sometimes put several objects in one fence instead of separate fences.
    // Split only at complete object boundaries, respecting strings and escapes.
  }

  const items: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (start === -1) {
      if (/\s/.test(char)) continue;
      if (char !== '{') throw new SyntaxError('Expected a JSON object');
      start = i;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        items.push(JSON.parse(content.slice(start, i + 1)));
        start = -1;
        if (i + 1 < content.length && !/\s/.test(content[i + 1])) {
          throw new SyntaxError('Expected whitespace between JSON objects');
        }
      }
    }
  }

  // Reject the whole block if any object is incomplete or invalid.
  if (start !== -1 || items.length === 0) throw new SyntaxError('Incomplete action block');
  return items;
}
