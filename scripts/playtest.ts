import { runPlaytests, summarizePlaytests } from '../src/sim/playtest';

const results = runPlaytests();
console.log('Strait Transit strategy outcomes (seeds 1–20; silent LLM, normal weapons and ship-loss termination)');
console.table(summarizePlaytests(results));
