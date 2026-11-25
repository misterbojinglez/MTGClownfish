/**
 * Decks from EDHREC: a commander picked at random among its 500 most played (of the past two years, its own
 * default ranking), with the average of the decks people have built around it, for one power bracket or for
 * all of them. EDHREC's data pages allow reads from any page, so this needs nothing from the bridge.
 */

const BASE = 'https://json.edhrec.com/pages';
const PAGES = 5; // of 100 commanders
/** a bracket this few people have built for has an average that isn't much of a deck */
const MIN_DECKS = 10;
const BASIC_FOR: Record<string, string> = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
const BASICS = new Set([...Object.values(BASIC_FOR), 'Wastes']);

/** 0 is any bracket */
export type Bracket = 0 | 1 | 2 | 3 | 4 | 5;

export const BRACKETS: { n: Bracket; name: string; slug: string }[] = [
  { n: 0, name: 'Any', slug: '' },
  { n: 1, name: 'Exhibition', slug: 'exhibition' },
  { n: 2, name: 'Core', slug: 'core' },
  { n: 3, name: 'Upgraded', slug: 'upgraded' },
  { n: 4, name: 'Optimized', slug: 'optimized' },
  { n: 5, name: 'cEDH', slug: 'cedh' },
];

export interface TopCommander {
  name: string;
  slug: string;
  rank: number;
}

export interface EdhrecDeck {
  commander: TopCommander;
  bracket: Bracket;
  list: string;
  /** how many decks the average was made from */
  sample: number;
  url: string;
}

/** EDHREC couldn't be reached (as opposed to one commander having no such deck). */
export class EdhrecDown extends Error {}

async function get(path: string): Promise<any | null> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/${path}.json`, { signal: AbortSignal.timeout(12000) });
  } catch {
    throw new EdhrecDown();
  }
  // a page it doesn't have is a 403 or 404
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new EdhrecDown();
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const pages = new Map<number, Promise<TopCommander[]>>();

function topPage(n: number): Promise<TopCommander[]> {
  let p = pages.get(n);
  if (!p) {
    p = (async () => {
      const d = await get(n === 0 ? 'commanders/year' : `commanders/year-past2years-${n}`);
      const views: any[] = (n === 0 ? d?.container?.json_dict?.cardlists?.[0]?.cardviews : d?.cardviews) ?? [];
      const list = views
        .map((v, i) => ({ name: String(v.name), slug: String(v.sanitized ?? v.slug ?? ''), rank: Number(v.rank) || n * 100 + i + 1 }))
        .filter((c) => /^[a-z0-9-]+$/.test(c.slug));
      if (!list.length) throw new EdhrecDown();
      return list;
    })();
    pages.set(n, p);
    // a failure isn't remembered
    p.catch(() => pages.delete(n));
  }
  return p;
}

/** The average deck for a commander in a bracket; null when EDHREC has none worth playing. */
async function averageDeck(commander: TopCommander, bracket: Bracket): Promise<EdhrecDeck | null> {
  const path = `average-decks/${commander.slug}${bracket ? `/${BRACKETS[bracket].slug}` : ''}`;
  const d = await get(path);
  const leaders: unknown = d?.deck?.commander;
  const groups: unknown = d?.deck?.cards;
  if (!Array.isArray(leaders) || !leaders.length || !groups || typeof groups !== 'object') return null;
  const counts: Record<string, number> = d.bracket_counts ?? {};
  // most decks have no bracket set, so without one it's the commander's own total
  const sample = Number((bracket ? counts[bracket] : d.container?.json_dict?.card?.num_decks) ?? 0);
  if (sample < MIN_DECKS) return null;
  // each group is [name, copies][]
  const cards = Object.values(groups as Record<string, [string, number][]>).flat().map(([name, n]): [string, number] => [String(name), Number(n)]);
  const total = leaders.length + cards.reduce((a, [, n]) => a + n, 0);
  if (total < 90) return null;
  // an average can come out a card or two short (partners especially): a basic land makes it up
  if (total < 100) {
    const basic = cards.filter(([name]) => BASICS.has(name)).sort((a, b) => b[1] - a[1])[0];
    const color = String(d.container?.json_dict?.card?.color_identity?.[0] ?? '');
    if (basic) basic[1] += 100 - total;
    else cards.push([BASIC_FOR[color] ?? 'Wastes', 100 - total]);
  }
  const list = `Commander\n${leaders.map((n) => `1 ${n}`).join('\n')}\n\nDeck\n${cards.map(([name, n]) => `${n} ${name}`).join('\n')}`;
  return { commander, bracket, list, sample, url: `https://edhrec.com/${path}` };
}

/** One pull: a random top-500 commander's deck. `skip` holds the commanders not to pull (again). */
export async function randomDeck(bracket: Bracket, skip: Set<string>): Promise<EdhrecDeck | null> {
  for (let tries = 0; tries < 12; tries++) {
    const list = await topPage(Math.floor(Math.random() * PAGES));
    const c = list[Math.floor(Math.random() * list.length)];
    if (skip.has(c.slug)) continue;
    const deck = await averageDeck(c, bracket);
    skip.add(c.slug);
    if (deck) return deck;
  }
  return null;
}
