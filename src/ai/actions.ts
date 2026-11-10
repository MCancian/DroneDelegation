import type { World } from '../sim/world';
import type { Command } from '../sim/commands';
import { validateCommand } from '../sim/commands';
import type { Classification, PointDefenseMode } from '../sim/types';

const VALID_ACTIONS = new Set([
  'engage_sam', 'engage_gun', 'ciws', 'chaff',
  'iff_challenge', 'radio_warning', 'hail', 'illuminate', 'warning_shots',
  'classify', 'maneuver', 'set_point_defense',
]);

const CLASSIFICATIONS: readonly Classification[] = ['unknown', 'neutral', 'friendly', 'suspect', 'hostile'];
const MODES: readonly PointDefenseMode[] = ['auto', 'manual'];

const ALLOWED_FIELDS: Record<string, Set<string>> = {
  engage_sam: new Set(['action', 'target', 'reason']),
  engage_gun: new Set(['action', 'target', 'reason']),
  ciws: new Set(['action', 'target', 'reason']),
  chaff: new Set(['action', 'reason']),
  iff_challenge: new Set(['action', 'target', 'reason']),
  radio_warning: new Set(['action', 'target', 'reason']),
  hail: new Set(['action', 'target', 'reason']),
  illuminate: new Set(['action', 'target', 'reason']),
  warning_shots: new Set(['action', 'target', 'reason']),
  classify: new Set(['action', 'target', 'classification', 'reason']),
  maneuver: new Set(['action', 'courseDeg', 'speedKts', 'reason']),
  set_point_defense: new Set(['action', 'mode', 'reason']),
};

const NEEDS_TARGET = new Set([
  'engage_sam', 'engage_gun', 'ciws', 'iff_challenge', 'radio_warning',
  'hail', 'illuminate', 'warning_shots', 'classify',
]);

function extractBlocks(text: string): string[] {
  const blocks: string[] = [];
  const regex = /```action\s*\r?\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

function resolveTarget(
  world: World,
  trackId: string,
): { id: string } | { error: string } {
  const tracks = world.visibleTracks();
  const allMatches = tracks.filter((t) => t.trackId === trackId);
  if (allMatches.length === 0) return { error: `Target '${trackId}' not found among visible tracks` };
  if (allMatches.length > 1) return { error: `Ambiguous target '${trackId}' (${allMatches.length} matches)` };
  const match = allMatches[0];
  if (match.ownMissile) return { error: `Target '${trackId}' is an own interceptor` };
  return { id: match.id };
}

function validateFields(obj: Record<string, unknown>, action: string): string[] {
  const errors: string[] = [];
  const allowed = ALLOWED_FIELDS[action];
  if (!allowed) return [`Unknown action '${action}'`];

  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      errors.push(`Unknown field '${key}' for action '${action}'`);
    }
  }

  if ('reason' in obj && typeof obj.reason !== 'string') {
    errors.push(`Invalid reason: must be a string if provided`);
  }

  if (action === 'maneuver') {
    const c = obj.courseDeg;
    const s = obj.speedKts;
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c >= 360) {
      errors.push(`Invalid courseDeg: must be finite number 0<=x<360`);
    }
    if (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > 35) {
      errors.push(`Invalid speedKts: must be finite number 0..35`);
    }
  }

  if (action === 'classify') {
    const cl = obj.classification;
    if (typeof cl !== 'string' || !CLASSIFICATIONS.includes(cl as Classification)) {
      errors.push(`Invalid classification: must be one of ${CLASSIFICATIONS.join(', ')}`);
    }
  }

  if (action === 'set_point_defense') {
    const m = obj.mode;
    if (typeof m !== 'string' || !MODES.includes(m as PointDefenseMode)) {
      errors.push(`Invalid mode: must be 'auto' or 'manual'`);
    }
  }

  if (NEEDS_TARGET.has(action)) {
    if (typeof obj.target !== 'string' || obj.target.length === 0) {
      errors.push(`Missing or invalid 'target' for action '${action}'`);
    }
  }

  return errors;
}

function buildCommand(obj: Record<string, unknown>, internalId: string): Command {
  const action = obj.action as string;
  switch (action) {
    case 'engage_sam': return { action: 'engage_sam', target: internalId };
    case 'engage_gun': return { action: 'engage_gun', target: internalId };
    case 'ciws': return { action: 'ciws', target: internalId };
    case 'chaff': return { action: 'chaff' };
    case 'iff_challenge': return { action: 'iff_challenge', target: internalId };
    case 'radio_warning': return { action: 'radio_warning', target: internalId };
    case 'hail': return { action: 'hail', target: internalId };
    case 'illuminate': return { action: 'illuminate', target: internalId };
    case 'warning_shots': return { action: 'warning_shots', target: internalId };
    case 'classify': return { action: 'classify', target: internalId, classification: obj.classification as Classification };
    case 'maneuver': return { action: 'maneuver', courseDeg: obj.courseDeg as number, speedKts: obj.speedKts as number };
    case 'set_point_defense': return { action: 'set_point_defense', mode: obj.mode as PointDefenseMode };
    default: throw new Error(`Unreachable: action '${action}' passed validation`);
  }
}

export function parseActions(
  text: string,
  world: World,
): { commands: Command[]; errors: string[] } {
  const commands: Command[] = [];
  const errors: string[] = [];
  const blocks = extractBlocks(text);

  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      errors.push('Malformed JSON in action block');
      continue;
    }

    const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

    for (const item of items) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        errors.push('Action block entry must be a JSON object');
        continue;
      }

      const obj = item as Record<string, unknown>;
      const action = obj.action;

      if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
        errors.push(`Unknown or missing action: '${String(action)}'`);
        continue;
      }

      const fieldErrors = validateFields(obj, action);
      if (fieldErrors.length > 0) {
        errors.push(...fieldErrors);
        continue;
      }

      let internalId = '';
      if (NEEDS_TARGET.has(action)) {
        const resolved = resolveTarget(world, obj.target as string);
        if ('error' in resolved) {
          errors.push(resolved.error);
          continue;
        }
        internalId = resolved.id;
      }

      const cmd = buildCommand(obj, internalId);
      const validation = validateCommand(world, cmd);
      if (!validation.ok) {
        errors.push(validation.error);
        continue;
      }
      commands.push(cmd);
    }
  }

  return { commands, errors };
}
