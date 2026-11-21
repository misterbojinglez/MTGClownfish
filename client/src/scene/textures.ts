import * as THREE from 'three';
import type { CardState } from '../protocol';

/** The interface's typeface (theme.css --display), for text drawn onto card textures. */
export const CANVAS_FONT = 'Alegreya, Georgia, serif';
// a canvas draws with whatever is loaded at that moment and keeps it: load the weights card text uses now,
// so a card drawn early doesn't keep a fallback face
if (typeof document !== 'undefined' && document.fonts) {
  for (const w of ['500', '600', '700', '800']) void document.fonts.load(`${w} 20px Alegreya`).catch(() => {});
}

/**
 * Card art from Scryfall. Unknown cards are resolved in batches through /cards/collection (75 per call,
 * spaced to respect Scryfall's rate guidance); images then come straight from the CDN.
 */

interface Resolved {
  normal: string;
  large: string;
  art: string;
}

const resolved = new Map<string, Resolved | null>();
const pending = new Map<string, { card: CardState; waiters: ((r: Resolved | null) => void)[] }>();
const textureCache = new Map<string, Promise<THREE.Texture>>();
let flushTimer: number | null = null;
let lastApiCall = 0;

const loader = new THREE.TextureLoader();
loader.setCrossOrigin('anonymous');

function keyOf(c: CardState): string {
  return `${c.name}|${c.set ?? ''}|${c.cn ?? ''}|${c.state ?? ''}`;
}

/** A name for comparing faces: Forge and Scryfall can differ in punctuation ("Max Speed!" / "Max Speed"). */
function plainName(name: string | undefined): string {
  return (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Forge names transformed / split faces by the face shown; pick that face's art from a Scryfall card. */
function pickImages(card: any, faceName: string | undefined): Resolved | null {
  const faces: any[] = card.card_faces ?? [];
  const face = faces.find((f) => f.name === faceName && f.image_uris) ?? faces.find((f) => plainName(f.name) === plainName(faceName) && f.image_uris) ?? null;
  const uris = face?.image_uris ?? card.image_uris ?? faces[0]?.image_uris;
  return uris ? { normal: uris.normal, large: uris.large ?? uris.normal, art: uris.art_crop ?? uris.normal } : null;
}

async function flush(): Promise<void> {
  flushTimer = null;
  const batch = [...pending.entries()].slice(0, 75);
  if (batch.length === 0) return;
  for (const [k] of batch) pending.delete(k);

  const wait = Math.max(0, lastApiCall + 120 - performance.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastApiCall = performance.now();

  const identifiers = batch.map(([, { card }]) =>
    card.set && card.cn ? { set: card.set.toLowerCase(), collector_number: card.cn } : { name: frontName(card.name ?? '') },
  );
  let data: any[] = [];
  try {
    const res = await fetch('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ identifiers }),
    });
    data = res.ok ? (await res.json()).data ?? [] : [];
  } catch {
    data = [];
  }

  const misses: [string, (typeof batch)[number][1]][] = [];
  for (const entry of batch) {
    const [k, { card, waiters }] = entry;
    const match = data.find(
      (d) =>
        (card.cn && d.collector_number === card.cn && d.set === card.set?.toLowerCase()) ||
        d.name === card.name ||
        d.card_faces?.some((f: any) => f.name === card.name),
    );
    if (match) {
      const r = pickImages(match, card.name);
      resolved.set(k, r);
      waiters.forEach((w) => w(r));
    } else {
      misses.push(entry);
    }
  }
  // set/number misses (promos, Forge-only set codes) get one retry by name
  for (const [k, { card, waiters }] of misses) {
    if (!card.name) {
      resolved.set(k, null);
      waiters.forEach((w) => w(null));
      continue;
    }
    // the printing the bridge named, asked for on its own (the batch may have failed as a whole: an error or
    // a rate limit), before any search by name, which for a card that isn't a real one ("Start Your
    // Engines!", speed's effect) finds an unrelated card of the same name
    let r = card.set && card.cn ? await byPrinting(card.set, card.cn, card.name) : null;
    // an effect is never looked up by name: without its printing it gets a drawn face
    // a token is either a copy of a real card (Offspring, clones: same name) or a token printing
    if (!r && !card.effect) r = card.token ? ((await byName(card.name)) ?? (await byTokenName(card.name))) : await byName(card.name);
    resolved.set(k, r);
    waiters.forEach((w) => w(r));
  }
  if (pending.size) flushTimer = window.setTimeout(flush, 0);
}

function frontName(name: string): string {
  return name.split(' // ')[0];
}

/** One printing, by set and collector number (a batch that failed as a whole gets its cards this way). */
async function byPrinting(set: string, cn: string, faceName: string | undefined): Promise<Resolved | null> {
  const wait = Math.max(0, lastApiCall + 120 - performance.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastApiCall = performance.now();
  try {
    const res = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(set.toLowerCase())}/${encodeURIComponent(cn)}`);
    if (!res.ok) return null;
    return pickImages(await res.json(), faceName);
  } catch {
    return null;
  }
}

async function byName(name: string): Promise<Resolved | null> {
  const wait = Math.max(0, lastApiCall + 120 - performance.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastApiCall = performance.now();
  try {
    const res = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(frontName(name))}`);
    if (!res.ok) return null;
    return pickImages(await res.json(), name);
  } catch {
    return null;
  }
}

/** The newest token printing with this name ("Soldier", "Treasure"), when Forge didn't say which. */
async function byTokenName(name: string): Promise<Resolved | null> {
  const clean = frontName(name).replace(/\s+Token$/i, '').trim();
  const wait = Math.max(0, lastApiCall + 120 - performance.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastApiCall = performance.now();
  try {
    const q = encodeURIComponent(`!"${clean}" is:token`);
    const res = await fetch(`https://api.scryfall.com/cards/search?q=${q}&order=released&dir=desc&unique=art`);
    if (!res.ok) return null;
    const data = (await res.json()).data ?? [];
    return data.length ? pickImages(data[0], clean) : null;
  } catch {
    return null;
  }
}

export function resolveCard(card: CardState): Promise<Resolved | null> {
  const k = keyOf(card);
  if (resolved.has(k)) return Promise.resolve(resolved.get(k)!);
  return new Promise((resolve) => {
    const p = pending.get(k);
    if (p) p.waiters.push(resolve);
    else pending.set(k, { card, waiters: [resolve] });
    if (flushTimer === null) flushTimer = window.setTimeout(flush, 30);
  });
}

function loadTexture(url: string): Promise<THREE.Texture> {
  let p = textureCache.get(url);
  if (!p) {
    p = new Promise((resolve, reject) =>
      loader.load(
        url,
        (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = 8;
          resolve(t);
        },
        undefined,
        reject,
      ),
    );
    textureCache.set(url, p);
  }
  return p;
}

export async function cardFaceTexture(card: CardState): Promise<THREE.Texture> {
  const r = await resolveCard(card);
  if (r) {
    try {
      return await loadTexture(r.normal);
    } catch {
      /* fall through to the drawn face */
    }
  }
  return drawnFace(card);
}

/** The image the 3D card already uses (so it's in the browser cache and shows instantly). */
export async function cardImageUrl(card: CardState): Promise<string | null> {
  const r = await resolveCard(card);
  return r?.normal ?? null;
}

/** Just the illustration, for deck tiles. */
export async function cardArtUrl(card: CardState): Promise<string | null> {
  const r = await resolveCard(card);
  return r?.art ?? null;
}

export async function cardZoomUrl(card: CardState): Promise<string | null> {
  const r = await resolveCard(card);
  return r?.large ?? null;
}

// ---- generated faces ----------------------------------------------------------------------------

const W = 488;
const H = 680;

let backTexture: THREE.Texture | null = null;

/** An original card back: deep blue-violet field, gilded oval, five-pip ring. */
export function cardBackTexture(): THREE.Texture {
  if (backTexture) return backTexture;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  roundRect(g, 0, 0, W, H, 26);
  g.fillStyle = '#16120e';
  g.fill();
  const field = g.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, H * 0.7);
  field.addColorStop(0, '#3b2f6b');
  field.addColorStop(0.55, '#1d1838');
  field.addColorStop(1, '#0b0a14');
  roundRect(g, 18, 18, W - 36, H - 36, 18);
  g.fillStyle = field;
  g.fill();
  g.strokeStyle = '#b8924a';
  g.lineWidth = 6;
  g.beginPath();
  g.ellipse(W / 2, H / 2, W * 0.33, H * 0.36, 0, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 2;
  g.beginPath();
  g.ellipse(W / 2, H / 2, W * 0.29, H * 0.32, 0, 0, Math.PI * 2);
  g.stroke();
  const pips = ['#f3ecd2', '#4a8fd6', '#2b2430', '#d6513a', '#3e9b5a'];
  pips.forEach((col, i) => {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 5;
    g.beginPath();
    g.arc(W / 2 + Math.cos(a) * 70, H / 2 + Math.sin(a) * 70, 22, 0, Math.PI * 2);
    g.fillStyle = col;
    g.fill();
    g.strokeStyle = '#b8924a';
    g.lineWidth = 3;
    g.stroke();
  });
  backTexture = new THREE.CanvasTexture(c);
  backTexture.colorSpace = THREE.SRGBColorSpace;
  backTexture.anisotropy = 8;
  return backTexture;
}

const COLOR_FRAMES: Record<string, [string, string]> = {
  W: ['#efe6c8', '#cdbd8a'],
  U: ['#2f6fb5', '#1b4677'],
  B: ['#3c3340', '#1c181e'],
  R: ['#c4482f', '#7c2416'],
  G: ['#2f7d48', '#1a4a2a'],
  M: ['#c8a54a', '#7d6424'],
  C: ['#9aa0a6', '#5f656b'],
};

function frameColors(colors: string | undefined): [string, string] {
  const cs = (colors ?? '').replace(/[^WUBRG]/g, '');
  if (cs.length > 1) return COLOR_FRAMES.M;
  return COLOR_FRAMES[cs] ?? COLOR_FRAMES.C;
}

/** Tokens and cards Scryfall can't find get a clean, readable stand-in face. */
function drawnFace(card: CardState): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const [light, dark] = frameColors(card.colors);
  roundRect(g, 0, 0, W, H, 26);
  g.fillStyle = '#111';
  g.fill();
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, light);
  grad.addColorStop(1, dark);
  roundRect(g, 14, 14, W - 28, H - 28, 16);
  g.fillStyle = grad;
  g.fill();
  // art window
  const art = g.createLinearGradient(0, 80, W, 380);
  art.addColorStop(0, 'rgba(255,255,255,0.25)');
  art.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = art;
  g.fillRect(34, 84, W - 68, 300);
  // name bar
  g.fillStyle = 'rgba(245,240,225,0.92)';
  roundRect(g, 26, 28, W - 52, 46, 10);
  g.fill();
  g.fillStyle = '#111';
  g.font = `600 26px ${CANVAS_FONT}`;
  g.fillText(fit(g, card.name ?? 'Card', W - 90), 40, 60);
  // type bar
  g.fillStyle = 'rgba(245,240,225,0.92)';
  roundRect(g, 26, 394, W - 52, 40, 10);
  g.fill();
  g.fillStyle = '#111';
  g.font = `600 20px ${CANVAS_FONT}`;
  g.fillText(fit(g, card.typeLine ?? '', W - 90), 40, 421);
  // rules text
  g.fillStyle = 'rgba(250,247,238,0.94)';
  g.fillRect(34, 444, W - 68, 190);
  g.fillStyle = '#222';
  g.font = `500 18px ${CANVAS_FONT}`;
  wrap(g, (card.text ?? '').replace(/\r?\n/g, ' ⏎ '), 46, 470, W - 92, 22, 7);
  if (card.power !== undefined && card.toughness !== undefined) {
    g.fillStyle = 'rgba(245,240,225,0.95)';
    roundRect(g, W - 128, H - 74, 100, 48, 12);
    g.fill();
    g.fillStyle = '#111';
    g.font = `700 30px ${CANVAS_FONT}`;
    g.textAlign = 'center';
    g.fillText(`${card.power}/${card.toughness}`, W - 78, H - 40);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function fit(g: CanvasRenderingContext2D, text: string, max: number): string {
  let t = text;
  while (t.length > 3 && g.measureText(t).width > max) t = t.slice(0, -2);
  return t === text ? t : t + '…';
}

function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, max: number, lh: number, maxLines: number): void {
  const words = text.split(' ');
  let line = '';
  let n = 0;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (g.measureText(test).width > max && line) {
      g.fillText(line, x, y + n * lh);
      line = w;
      if (++n >= maxLines) return;
    } else {
      line = test;
    }
  }
  if (line) g.fillText(line, x, y + n * lh);
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
