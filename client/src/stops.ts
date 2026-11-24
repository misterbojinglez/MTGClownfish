// Where the game stops for you: a stop per step, for your turns and for everyone else's. Kept on this device and
// sent to the bridge, which does the stopping.

export type Stop = 'on' | 'once';

/** the steps you can stop at, as Forge names them */
export const STEPS: [string, string][] = [
  ['UPKEEP', 'Upkeep'],
  ['DRAW', 'Draw'],
  ['MAIN1', 'Main 1'],
  ['COMBAT_BEGIN', 'Beginning of combat'],
  ['COMBAT_DECLARE_ATTACKERS', 'Attackers declared'],
  ['COMBAT_DECLARE_BLOCKERS', 'Blockers declared'],
  ['COMBAT_DAMAGE', 'Damage dealt'],
  ['COMBAT_END', 'End of combat'],
  ['MAIN2', 'Main 2'],
  ['END_OF_TURN', 'End step'],
];

const DEFAULTS: Record<string, Stop> = {
  'mine:MAIN1': 'on', 'mine:COMBAT_DECLARE_BLOCKERS': 'on', 'mine:MAIN2': 'on',
  'theirs:COMBAT_DECLARE_ATTACKERS': 'on', 'theirs:COMBAT_DECLARE_BLOCKERS': 'on', 'theirs:END_OF_TURN': 'on',
};

const KEY = 'mtgclownfish.stops';

function load(): Record<string, Stop> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Record<string, unknown> | null;
    // one-time stops don't outlive the session they were set in
    if (saved) return Object.fromEntries(Object.entries(saved).filter(([, v]) => v === 'on')) as Record<string, Stop>;
  } catch {
    /* storage unavailable: defaults */
  }
  return { ...DEFAULTS };
}

let stops = load();
const listeners = new Set<() => void>();

export function stopsNow(): Readonly<Record<string, Stop>> {
  return stops;
}

export function setStop(key: string, stop: Stop | null): void {
  stops = { ...stops };
  if (stop) stops[key] = stop;
  else delete stops[key];
  changed();
}

export function resetStops(): void {
  stops = { ...DEFAULTS };
  changed();
}

function changed(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(stops));
  } catch {
    /* not saved: they still apply now */
  }
  listeners.forEach((f) => f());
}

/** Full control: 'turn' until the turn ends, 'held' until you let go of it. */
let full: 'off' | 'turn' | 'held' = 'off';

export function fullControl(): 'off' | 'turn' | 'held' {
  return full;
}

export function setFullControl(v: 'off' | 'turn' | 'held'): void {
  if (v === full) return;
  full = v;
  listeners.forEach((f) => f());
}

export function onStops(f: () => void): void {
  listeners.add(f);
}
