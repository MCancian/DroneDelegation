import type { Behavior, Classification, ContactResponses, Domain, OwnShip, RadarContact, Rcs, SensorInfo, SurfaceSize, Truth, Vec2 } from '../types';
import { World } from '../world';
import { STEP_S } from '../clock';
import { bearingTo, fromBearingRange, rangeTo } from '../geo';
import { setBehavior } from '../kinematics';
import { WEAPONS_HOOKS } from '../weapons';

export type CrewStation = 'CIC' | 'TAO-Air' | 'SWC' | 'EW' | 'Lookouts' | 'Bridge' | 'Radio';
export type CrewPriority = 'routine' | 'priority' | 'flash';

export type Placement =
  | { kind: 'absolute'; position: Vec2; courseDeg: number }
  | { kind: 'fromOwnship'; bearingDeg: number; rangeNm: number; courseDeg?: number };

export interface ScenarioContact {
  id: string;
  trackId: string;
  name: string;
  domain: Domain;
  truth: Truth;
  classification?: Classification;
  placement: Placement;
  speedKts: number;
  altitudeFt: number;
  sensors?: Partial<SensorInfo>;
  rcs?: Rcs;
  size?: SurfaceSize;
  pDetect?: number;
  personsAboard?: number;
  behavior: Behavior;
  spawnAtS?: number;
  visualDescription?: string;
  responses?: ContactResponses;
}

export type ScenarioCondition =
  | { kind: 'time'; atS: number }
  | { kind: 'rangeBelow'; contactId: string; rangeNm: number }
  | { kind: 'hostileAct'; byContactId: string };

export interface MissileLaunchSpec {
  count: number;
  weapon: string;
  speedKts: number;
  altitudeFt: number;
}

export type ScenarioAction =
  | { kind: 'setBehavior'; contactId: string; behavior: Behavior }
  | { kind: 'launchMissiles'; contactId: string; launch: MissileLaunchSpec }
  | { kind: 'setSensorInfo'; contactId: string; sensors: Partial<SensorInfo> }
  | { kind: 'crewReport'; station: CrewStation; priority: CrewPriority; text: string; contactId?: string };

export interface ScenarioTrigger {
  id: string;
  when: ScenarioCondition;
  notBeforeS?: number;
  actions: ScenarioAction[];
}

export interface Scenario {
  id: string;
  name: string;
  durationS: number;
  ownShip: OwnShip;
  contacts: ScenarioContact[];
  triggers: ScenarioTrigger[];
}

export interface MissileLaunchRequest extends MissileLaunchSpec {
  launcherId: string;
  trackId: string;
  t: number;
  position: Vec2;
  rangeNm: number;
  bearingDeg: number;
}

export interface ScenarioHooks {
  launchMissiles(world: World, req: MissileLaunchRequest): void;
}

export const STUB_HOOKS: ScenarioHooks = { launchMissiles: () => {} };

export interface HostileAct {
  contactId: string;
  t: number;
  kind: 'missile-launch';
}

export function buildContact(def: ScenarioContact, ownShip: OwnShip): RadarContact {
  let position: Vec2;
  let courseDeg: number;

  if (def.placement.kind === 'absolute') {
    position = { x: def.placement.position.x, y: def.placement.position.y };
    courseDeg = def.placement.courseDeg;
  } else {
    position = fromBearingRange(ownShip.position, def.placement.bearingDeg, def.placement.rangeNm);
    courseDeg = def.placement.courseDeg ?? bearingTo(position, ownShip.position);
  }

  const sensors: SensorInfo = structuredClone({
    iff: { kind: 'none' } as const,
    ais: { kind: 'none' } as const,
    esm: { kind: 'none' } as const,
    visual: { kind: 'none' } as const,
    ...def.sensors,
  });

  const contact: RadarContact = {
    id: def.id,
    trackId: def.trackId,
    domain: def.domain,
    truth: def.truth,
    position,
    courseDeg,
    speedKts: def.speedKts,
    altitudeFt: def.altitudeFt,
    classification: def.classification ?? 'unknown',
    sensors,
    alive: true,
    history: [],
    motion: {
      behavior: structuredClone(def.behavior),
      schedule: [],
    },
  };

  if (def.rcs !== undefined) contact.rcs = def.rcs;
  if (def.size !== undefined) contact.size = def.size;
  if (def.pDetect !== undefined) contact.pDetect = def.pDetect;
  if (def.personsAboard !== undefined) contact.personsAboard = def.personsAboard;
  if (def.responses !== undefined) contact.responses = structuredClone(def.responses);

  contact.visualDescription = def.visualDescription ?? def.name;

  return contact;
}

export function validateScenario(scenario: Scenario): string[] {
  const errors: string[] = [];

  if (scenario.durationS <= 0) {
    errors.push(`durationS must be > 0, got ${scenario.durationS}`);
  }

  const contactIds = new Set<string>();
  for (const c of scenario.contacts) {
    if (contactIds.has(c.id)) {
      errors.push(`duplicate contact id '${c.id}'`);
    }
    contactIds.add(c.id);
  }

  const trackIds = new Set<string>();
  for (const c of scenario.contacts) {
    if (trackIds.has(c.trackId)) {
      errors.push(`duplicate trackId '${c.trackId}'`);
    }
    trackIds.add(c.trackId);
  }

  const triggerIds = new Set<string>();
  for (const t of scenario.triggers) {
    if (triggerIds.has(t.id)) {
      errors.push(`duplicate trigger id '${t.id}'`);
    }
    triggerIds.add(t.id);
  }

  for (const c of scenario.contacts) {
    if (c.spawnAtS !== undefined && c.spawnAtS < 0) {
      errors.push(`contact '${c.id}' has negative spawnAtS ${c.spawnAtS}`);
    }
  }

  for (const t of scenario.triggers) {
    if (t.when.kind === 'rangeBelow') {
      if (!contactIds.has(t.when.contactId)) {
        errors.push(`trigger '${t.id}' references unknown contact '${t.when.contactId}'`);
      }
    }
    if (t.when.kind === 'hostileAct') {
      if (!contactIds.has(t.when.byContactId)) {
        errors.push(`trigger '${t.id}' references unknown contact '${t.when.byContactId}'`);
      }
    }
    for (const a of t.actions) {
      if (a.kind === 'setBehavior' || a.kind === 'launchMissiles' || a.kind === 'setSensorInfo') {
        if (!contactIds.has(a.contactId)) {
          errors.push(`trigger '${t.id}' action references unknown contact '${a.contactId}'`);
        }
      }
      if (a.kind === 'crewReport' && a.contactId !== undefined) {
        if (!contactIds.has(a.contactId)) {
          errors.push(`trigger '${t.id}' crewReport references unknown contact '${a.contactId}'`);
        }
      }
    }
  }

  return errors;
}

export class ScenarioRunner {
  readonly scenario: Scenario;
  readonly world: World;
  readonly hostileActs: HostileAct[] = [];
  readonly firedTriggers: string[] = [];

  private readonly hooks: ScenarioHooks;
  private readonly spawned: Set<string> = new Set();
  private readonly fired: Set<string> = new Set();

  constructor(scenario: Scenario, world: World, hooks?: ScenarioHooks) {
    this.scenario = scenario;
    this.world = world;
    this.hooks = hooks ?? WEAPONS_HOOKS;

    for (const def of scenario.contacts) {
      if ((def.spawnAtS ?? 0) <= 0) {
        this.spawned.add(def.id);
      }
    }
  }

  hasSpawned(contactId: string): boolean {
    return this.spawned.has(contactId);
  }

  update(): void {
    this.spawnContacts();
    this.processTriggers();
  }

  private spawnContacts(): void {
    for (const def of this.scenario.contacts) {
      if (this.spawned.has(def.id)) continue;
      if ((def.spawnAtS ?? 0) <= this.world.time + 1e-6) {
        this.world.contacts.push(buildContact(def, this.world.ownShip));
        this.spawned.add(def.id);
        this.world.logEvent('contact-spawn', 'scenario', {
          contactId: def.id,
          trackId: def.trackId,
        });
      }
    }
  }

  private processTriggers(): void {
    let firedAny = true;
    while (firedAny) {
      firedAny = false;
      for (const trigger of this.scenario.triggers) {
        if (this.fired.has(trigger.id)) continue;

        if (trigger.notBeforeS !== undefined && this.world.time < trigger.notBeforeS - 1e-6) {
          continue;
        }

        if (!this.checkCondition(trigger.when)) continue;

        this.fired.add(trigger.id);
        this.firedTriggers.push(trigger.id);
        this.world.logEvent('trigger', 'scenario', { triggerId: trigger.id });

        for (const action of trigger.actions) {
          this.executeAction(action, trigger.id);
        }

        firedAny = true;
      }
    }
  }

  private checkCondition(cond: ScenarioCondition): boolean {
    switch (cond.kind) {
      case 'time':
        return this.world.time >= cond.atS - 1e-6;
      case 'rangeBelow': {
        const contact = this.world.contactById(cond.contactId);
        if (!contact || !contact.alive) return false;
        return rangeTo(this.world.ownShip.position, contact.position) < cond.rangeNm;
      }
      case 'hostileAct':
        return this.hostileActs.some((h) => h.contactId === cond.byContactId);
    }
  }

  private executeAction(action: ScenarioAction, triggerId: string): void {
    switch (action.kind) {
      case 'setBehavior': {
        const contact = this.world.contactById(action.contactId);
        if (!contact || !contact.alive) return;
        setBehavior(contact, structuredClone(action.behavior));
        this.world.logEvent('behavior-change', 'scenario', {
          contactId: action.contactId,
          triggerId,
          behavior: action.behavior.kind,
        });
        break;
      }
      case 'setSensorInfo': {
        const contact = this.world.contactById(action.contactId);
        if (!contact || !contact.alive) return;
        contact.sensors = { ...contact.sensors, ...structuredClone(action.sensors) };
        this.world.logEvent('sensor-change', 'scenario', {
          contactId: action.contactId,
          triggerId,
          sensors: action.sensors,
        });
        break;
      }
      case 'crewReport': {
        const payload: Record<string, unknown> = {
          station: action.station,
          priority: action.priority,
          text: action.text,
          triggerId,
        };
        if (action.contactId !== undefined) {
          payload.contactId = action.contactId;
        }
        this.world.logEvent('crew-report', 'scenario', payload);
        break;
      }
      case 'launchMissiles': {
        const contact = this.world.contactById(action.contactId);
        if (!contact || !contact.alive) return;

        const req: MissileLaunchRequest = {
          ...action.launch,
          launcherId: action.contactId,
          trackId: contact.trackId,
          t: this.world.time,
          position: { x: contact.position.x, y: contact.position.y },
          rangeNm: rangeTo(this.world.ownShip.position, contact.position),
          bearingDeg: bearingTo(this.world.ownShip.position, contact.position),
        };

        const hostileAct: HostileAct = {
          contactId: action.contactId,
          t: this.world.time,
          kind: 'missile-launch',
        };
        this.hostileActs.push(hostileAct);

        this.world.logEvent('missile-launch', 'scenario', { ...req, triggerId });
        this.world.logEvent('hostile-act', 'scenario', hostileAct);

        this.hooks.launchMissiles(this.world, req);
        break;
      }
    }
  }
}

export function loadScenario(
  scenario: Scenario,
  seed: number,
  hooks?: ScenarioHooks,
): { world: World; runner: ScenarioRunner } {
  const errors = validateScenario(scenario);
  if (errors.length > 0) {
    throw new Error(`Invalid scenario ${scenario.id}: ${errors.join('; ')}`);
  }

  const initialContacts = scenario.contacts
    .filter((c) => (c.spawnAtS ?? 0) <= 0)
    .map((c) => buildContact(c, scenario.ownShip));

  const world = new World({ seed, ownShip: scenario.ownShip, contacts: initialContacts });
  const runner = new ScenarioRunner(scenario, world, hooks);
  runner.update();

  return { world, runner };
}

export function runScenario(
  scenario: Scenario,
  seed: number,
  opts?: {
    untilS?: number;
    hooks?: ScenarioHooks;
    onStep?: (world: World, runner: ScenarioRunner) => void;
  },
): { world: World; runner: ScenarioRunner } {
  const { world, runner } = loadScenario(scenario, seed, opts?.hooks);
  const steps = Math.round((opts?.untilS ?? scenario.durationS) / STEP_S);

  for (let i = 0; i < steps; i++) {
    world.step(STEP_S);
    runner.update();
    opts?.onStep?.(world, runner);
  }

  return { world, runner };
}
