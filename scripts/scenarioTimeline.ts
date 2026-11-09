import { STRAIT_TRANSIT } from '../src/sim/scenario/strait';
import { computeTimeline, formatTimeline } from '../src/sim/scenario/timeline';

const raw = Number(process.argv[2] ?? '1');
const seed = Number.isInteger(raw) && raw >= 0 ? raw : 1;

console.log(formatTimeline(computeTimeline(STRAIT_TRANSIT, seed)));
