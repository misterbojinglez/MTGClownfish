// Performance settings, kept on this device. The renderer reads them every frame or subscribes to changes,
// so a choice in the Settings dialog takes effect at once.

/** auto: 60 fps while anything moves, 30 when the table is still; max: every display refresh (120 Hz on ProMotion) */
export type FrameRate = 'auto' | '30' | '60' | 'max';
/** spell and combat effects, sparks and the floor's rising embers */
export type ParticleLevel = 'full' | 'reduced' | 'off';
/** the table's procedural stone and lava cracks */
export type FloorDetail = 'high' | 'low';
/** high: up to 2 pixels per point on high-density (Retina) screens; standard: 1 */
export type Resolution = 'high' | 'standard';
/** the least time (seconds) a spell or ability stays on the Stack before the table shows it resolving */
export type StackHold = '0' | '1' | '2' | '3';

export interface Settings {
  frameRate: FrameRate;
  particles: ParticleLevel;
  floorDetail: FloorDetail;
  resolution: Resolution;
  stackHold: StackHold;
}

export const DEFAULT_SETTINGS: Settings = { frameRate: 'auto', particles: 'full', floorDetail: 'high', resolution: 'high', stackHold: '0' };

const STORE_KEY = 'mtgclownfish.settings';
const CHOICES: { [K in keyof Settings]: readonly Settings[K][] } = {
  frameRate: ['auto', '30', '60', 'max'],
  particles: ['full', 'reduced', 'off'],
  floorDetail: ['high', 'low'],
  resolution: ['high', 'standard'],
  stackHold: ['0', '1', '2', '3'],
};

function load(): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Partial<Record<keyof Settings, unknown>>;
    for (const key of Object.keys(CHOICES) as (keyof Settings)[]) {
      const v = saved[key];
      if ((CHOICES[key] as readonly unknown[]).includes(v)) (s as Record<keyof Settings, unknown>)[key] = v;
    }
  } catch {
    /* storage unavailable: defaults */
  }
  return s;
}

const current: Settings = load();
const listeners = new Set<(s: Readonly<Settings>) => void>();

export const settings: Readonly<Settings> = current;

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  if (current[key] === value) return;
  current[key] = value;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(current));
  } catch {
    /* not saved: it still applies for this session */
  }
  for (const fn of listeners) fn(current);
}

/** Calls fn now and on every change; returns an unsubscribe. */
export function onSettings(fn: (s: Readonly<Settings>) => void): () => void {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}

/** Whether a particle emission should happen under the current setting: reduced keeps every other one. */
let reduceTick = 0;
export function particleAllowed(): boolean {
  if (current.particles === 'full') return true;
  if (current.particles === 'off') return false;
  return (reduceTick++ & 1) === 0;
}
