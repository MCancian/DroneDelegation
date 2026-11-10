import type { World } from '../sim/world';
import type { Command } from '../sim/commands';
import { executeCommand } from '../sim/commands';
import { parseActions } from './actions';

const DIRECT_VERB_START = /^\s*(?:engage|fire|hail|warn|illuminate|classify|maneuver|turn|change|set|deploy|challenge|launch|stop)\b/i;

const PREFIX_STRIP = /^(?:please[,\s]+|jarvis[,\s]+|can\s+you\s+|could\s+you\s+|will\s+you\s+|would\s+you\s+)+/i;

const ADVICE_RE = /\b(?:should\s+i|what\s+should|what\s+do|what\s+would|what\s+about|why|how\s+(?:do|should|can|would|to)|recommend|describe|explain|advise|suggest)\b/i;

const NEGATION_RE = /\b(?:don'?t|do\s+not|never|shouldn'?t|should\s+not|wouldn'?t|would\s+not|won'?t|will\s+not|can'?t|cannot)\b/i;

const HYPOTHETICAL_RE = /\b(?:if\s+|what\s+if|suppose|imagine|hypothetically|in\s+the\s+event\s+that|were\s+to|should\s+it)\b/i;

const CONDITIONAL_RE = /\b(?:unless|when|until|after|once)\b/i;

const QUOTED_ORDER_RE = /["'`][^"'`]*\b(?:engage|fire|hail|warn|illuminate|classify|maneuver|turn|change|set|deploy|challenge|launch|stop)\b[^"'`]*["'`]/i;

export function isDirectOrder(playerText: string): boolean {
  const text = playerText.trim();
  if (!text) return false;
  if (ADVICE_RE.test(text)) return false;
  if (NEGATION_RE.test(text)) return false;
  if (HYPOTHETICAL_RE.test(text)) return false;
  if (CONDITIONAL_RE.test(text)) return false;
  if (QUOTED_ORDER_RE.test(text)) return false;
  const stripped = text.replace(PREFIX_STRIP, '');
  return DIRECT_VERB_START.test(stripped);
}

function getDisplayId(world: World, cmd: Command): string | null {
  if (!('target' in cmd)) return null;
  const track = world.trackFor(cmd.target);
  return track?.trackId ?? null;
}

export function handleChatReply(
  world: World,
  reply: string,
  playerText: string,
  ended: boolean = false,
): string[] {
  const notices: string[] = [];
  const { commands, errors } = parseActions(reply, world);

  for (const error of errors) {
    world.logEvent('ai-action-error', 'ai-chat', { error, context: 'chat' });
    notices.push(`Error: ${error}`);
  }

  if (commands.length === 0 && errors.length === 0) {
    return notices;
  }

  if (ended || world.weapons.shipLost) {
    if (commands.length > 0 || errors.length > 0) {
      notices.push('Scenario ended; no actions executed.');
    }
    return notices;
  }

  if (!isDirectOrder(playerText)) {
    if (commands.length > 0) {
      notices.push('Suggested actions were not executed; issue a direct order to act.');
    }
    return notices;
  }

  for (const cmd of commands) {
    const result = executeCommand(world, cmd, 'ai-chat');
    const displayId = getDisplayId(world, cmd);
    const label = `${cmd.action}${displayId ? ` ${displayId}` : ''}`;
    if (result.ok) {
      notices.push(`Executed: ${label}`);
    } else {
      notices.push(`Failed: ${label} \u2014 ${result.error}`);
      world.logEvent('ai-action-error', 'ai-chat', { error: result.error, context: 'chat' });
    }
  }

  return notices;
}
