import type { DeckInfo, PreconInfo, SeatDeckSpec } from '../protocol';
import type { Bridge } from '../net';
import { cardArtUrl } from '../scene/textures';

/**
 * Game setup: a name and a deck for every seat: a random Forge precon, a precon you pick (by commander),
 * or a list pasted from Moxfield (or MTGA / MTGO / plain text). Pasted decks are kept in this browser
 * so they can be picked again.
 */

export type Format = 'constructed' | 'commander';

export interface SavedDeck {
  id: string;
  name: string;
  list: string;
  format: Format;
  commanders: string[];
  colors: string[];
  count: number;
  face?: { name: string; set: string; cn: string };
  savedAt: number;
}

/** null = random precon, "precon:<name>" = that precon, otherwise a saved deck's id */
type SeatChoice = string | null;

export interface GameSetup {
  format: Format;
  players: number;
  decks: (SeatDeckSpec | null)[];
  /** what each seat is called (index 0 is you) */
  names: string[];
}

const PRECON = 'precon:';
const PRECON_INFO_KEY = 'mtg-tabletop.preconInfo';
const NAMES_KEY = 'mtg-tabletop.aiNames';

/** opponents' default names (original, picked at random; each can be renamed on the seat screen) */
const AI_NAMES = [
  'Morwen', 'Aldric', 'Isolde', 'Corvin', 'Brannoc', 'Seraphine', 'Vesna', 'Old Maud', 'Halvard', 'Ysolde',
  'Kestrel', 'Dorian', 'Rook', 'Sable', 'Quill', 'Mirela', 'Tobiah', 'Wren', 'Garrick', 'Liora',
  'Thessaly', 'Marrow', 'Ansel', 'Petra', 'Fenwick', 'Odile', 'Caspian', 'Nerys', 'Bastian', 'Juniper',
];

function randomNames(n: number, avoid: string[] = []): string[] {
  const pool = AI_NAMES.filter((x) => !avoid.includes(x));
  const out: string[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out;
}

/** a precon's details, kept for the ones chosen so their seat tile can show them before the list loads */
function preconInfo(name: string): PreconInfo | undefined {
  return load<Record<string, PreconInfo>>(PRECON_INFO_KEY, {})[name];
}

function rememberPrecon(p: PreconInfo): void {
  const all = load<Record<string, PreconInfo>>(PRECON_INFO_KEY, {});
  all[p.name] = p;
  save(PRECON_INFO_KEY, all);
}

/** "Abzan Armor [TDC] [2025]" → "Abzan Armor", "TDC 2025" */
function splitPreconName(name: string): { title: string; tag: string } {
  const tags = [...name.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  return { title: name.replace(/\s*\[[^\]]+\]/g, '').trim() || name, tag: tags.join(' ') };
}

const DECKS_KEY = 'mtg-tabletop.decks';
const seatsKey = (format: Format, players: number) => `mtg-tabletop.seats.${format}.${players}`;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window or storage full: decks just aren't remembered */
  }
}

export function savedDecks(): SavedDeck[] {
  return load<SavedDeck[]>(DECKS_KEY, []);
}

function storeDeck(deck: SavedDeck): void {
  const all = savedDecks().filter((d) => d.id !== deck.id);
  all.unshift(deck);
  save(DECKS_KEY, all);
}

function deleteDeck(id: string): void {
  save(DECKS_KEY, savedDecks().filter((d) => d.id !== id));
}

export function specFor(deck: SavedDeck): SeatDeckSpec {
  return { list: deck.list, name: deck.name, commanders: deck.commanders };
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

const PIP: Record<string, string> = { W: '#f3ead0', U: '#4f9fe6', B: '#8d7f8f', R: '#e8624a', G: '#4fb36a' };

function pips(colors: string[]): HTMLElement {
  const el = h('div', 'pips');
  for (const c of colors.length ? colors : ['C']) {
    const p = h('span', 'deck-pip');
    p.style.background = PIP[c] ?? '#b9b2a6';
    p.title = c;
    el.append(p);
  }
  return el;
}

function setArt(el: HTMLElement, face: SavedDeck['face'] | undefined): void {
  if (!face) return;
  void cardArtUrl({ id: -1, owner: null, controller: null, zone: null, tapped: false, visible: true, name: face.name, set: face.set, cn: face.cn }).then((url) => {
    if (url) el.style.backgroundImage = `url("${url}")`;
  });
}

const SEAT_HUES = [8, 120, 200, 285];

export class DeckSetup {
  constructor(
    private readonly root: HTMLElement,
    private readonly bridge: Bridge,
  ) {}

  /** The seat screen for a format; resolves with what to start, or null if the player backs out. */
  open(format: Format, players: number, title: string): Promise<GameSetup | null> {
    return new Promise((resolve) => {
      const ov = h('div', 'overlay setup');
      const close = (result: GameSetup | null) => {
        ov.remove();
        resolve(result);
      };
      let count = players;
      let choices: SeatChoice[] = this.loadSeats(format, count);
      const names = this.loadNames();

      const render = () => {
        ov.replaceChildren();
        const head = h('div', 'setup-head');
        head.append(h('h2', '', title));
        if (format === 'commander' && players > 2) {
          // 3 or 4 at the table
          const seg = h('div', 'seg');
          for (const n of [3, 4]) {
            const b = h('button', n === count ? 'on' : '', `${n} players`);
            b.onclick = () => {
              count = n;
              choices = this.loadSeats(format, count);
              render();
            };
            seg.append(b);
          }
          head.append(seg);
        }
        ov.append(head);

        const seats = h('div', 'seats');
        for (let i = 0; i < count; i++) {
          const row = h('div', 'seat-row');
          const badge = h('div', 'seat-badge', i === 0 ? 'Y' : (names[i - 1]?.trim()[0] ?? 'A').toUpperCase());
          badge.style.setProperty('--hue', String(SEAT_HUES[i % 4]));
          const who = h('div', 'seat-who');
          if (i === 0) {
            who.append(h('div', 'seat-name', 'You'));
          } else {
            // opponents can be renamed; the die picks another name
            const nameRow = h('div', 'seat-name-row');
            const input = h('input', 'seat-name-input');
            input.value = names[i - 1] ?? '';
            input.maxLength = 24;
            input.placeholder = `AI ${i}`;
            input.spellcheck = false;
            input.oninput = () => {
              names[i - 1] = input.value;
              badge.textContent = (input.value.trim()[0] ?? 'A').toUpperCase();
              this.saveNames(names);
            };
            const die = h('button', 'seat-reroll', '↻');
            die.title = 'Another name';
            die.onclick = () => {
              names[i - 1] = randomNames(1, names)[0] ?? names[i - 1];
              input.value = names[i - 1];
              badge.textContent = (input.value.trim()[0] ?? 'A').toUpperCase();
              this.saveNames(names);
            };
            nameRow.append(input, die);
            who.append(nameRow);
          }
          who.append(h('div', 'seat-role', i === 0 ? 'Your deck' : 'Opponent'));
          const tile = this.choiceTile(choices[i], format);
          tile.classList.add('seat-deck');
          tile.title = 'Choose a deck';
          tile.onclick = async () => {
            const picked = await this.pick(format, choices[i]);
            if (picked === undefined) return;
            choices[i] = picked;
            this.saveSeats(format, count, choices);
            render();
          };
          row.append(badge, who, tile);
          seats.append(row);
        }
        ov.append(seats);

        const actions = h('div', 'setup-actions');
        const back = h('button', 'sub-btn', 'Back');
        back.onclick = () => close(null);
        const start = h('button', 'main-btn wide glow', 'Start game');
        start.onclick = () => {
          const all = savedDecks();
          const decks = choices.slice(0, count).map((id): SeatDeckSpec | null => {
            if (id?.startsWith(PRECON)) return { precon: id.slice(PRECON.length) };
            const d = all.find((x) => x.id === id);
            return d ? specFor(d) : null;
          });
          // blank or repeated names fall back to "AI n"
          const seatNames = ['You', ...names.slice(0, count - 1).map((n, i, a) => {
            const t = n.trim();
            return t && a.findIndex((x) => x.trim().toLowerCase() === t.toLowerCase()) === i && t.toLowerCase() !== 'you' ? t : `AI ${i + 1}`;
          })];
          close({ format, players: count, decks, names: seatNames });
        };
        actions.append(back, start);
        ov.append(actions);
      };
      render();
      this.root.append(ov);
    });
  }

  private loadSeats(format: Format, players: number): SeatChoice[] {
    const ids = new Set(savedDecks().filter((d) => d.format === format).map((d) => d.id));
    const stored = load<SeatChoice[]>(seatsKey(format, players), []);
    return Array.from({ length: players }, (_, i) => (stored[i] && (ids.has(stored[i]!) || stored[i]!.startsWith(PRECON)) ? stored[i] : null));
  }

  private loadNames(): string[] {
    const stored = load<string[]>(NAMES_KEY, []).filter((x) => typeof x === 'string');
    if (stored.length >= 3) return stored.slice(0, 3);
    const names = [...stored, ...randomNames(3 - stored.length, stored)];
    this.saveNames(names);
    return names;
  }

  private saveNames(names: string[]): void {
    save(NAMES_KEY, names);
  }

  /** The tile for a seat's current choice. */
  private choiceTile(choice: SeatChoice, format: Format): HTMLElement {
    if (choice?.startsWith(PRECON)) {
      const name = choice.slice(PRECON.length);
      return this.preconTile(preconInfo(name) ?? { name, commanders: [], colors: [] });
    }
    return this.deckTile(savedDecks().find((d) => d.id === choice), format);
  }

  private preconTile(p: PreconInfo): HTMLElement {
    const tile = h('button', 'deck-tile');
    const art = h('div', 'deck-art');
    setArt(art, p.face);
    const { title, tag } = splitPreconName(p.name);
    const body = h('div', 'deck-body');
    body.append(h('div', 'deck-name', p.commanders.length ? p.commanders.join(' & ') : title));
    const meta = h('div', 'deck-meta');
    meta.append(pips(p.colors), h('span', '', p.commanders.length ? `${title}${tag ? ' · ' + tag : ''}` : tag || 'Precon'));
    body.append(meta);
    tile.append(art, body);
    return tile;
  }

  private saveSeats(format: Format, players: number, choices: SeatChoice[]): void {
    save(seatsKey(format, players), choices);
  }

  private deckTile(deck: SavedDeck | undefined, format: Format): HTMLElement {
    const tile = h('button', 'deck-tile');
    const art = h('div', 'deck-art');
    const body = h('div', 'deck-body');
    if (deck) {
      setArt(art, deck.face);
      body.append(h('div', 'deck-name', deck.name));
      const meta = h('div', 'deck-meta');
      meta.append(pips(deck.colors), h('span', '', deck.commanders.length ? deck.commanders.join(' & ') : `${deck.count} cards`));
      body.append(meta);
    } else {
      art.classList.add('random');
      art.textContent = '?';
      body.append(h('div', 'deck-name', 'Random precon'), h('div', 'deck-meta', format === 'commander' ? 'A Forge commander precon' : 'A Forge preconstructed deck'));
    }
    tile.append(art, body);
    return tile;
  }

  /** Deck picker for one seat: undefined = cancelled, null = random precon, else a saved deck id. */
  private pick(format: Format, current: SeatChoice): Promise<SeatChoice | undefined> {
    return new Promise((resolve) => {
      const modal = h('div', 'modal deck-modal');
      const box = h('div', 'modal-panel deck-picker');
      const done = (v: SeatChoice | undefined) => {
        modal.remove();
        resolve(v);
      };
      modal.onclick = (e) => {
        if (e.target === modal) done(undefined);
      };
      const render = () => {
        box.replaceChildren();
        box.append(h('div', 'modal-title', 'Choose a deck'));
        const grid = h('div', 'deck-grid');
        const random = this.deckTile(undefined, format);
        random.classList.toggle('current', current === null);
        random.onclick = () => done(null);
        grid.append(random);
        for (const d of savedDecks().filter((x) => x.format === format)) {
          const wrap = h('div', 'deck-cell');
          const tile = this.deckTile(d, format);
          tile.classList.toggle('current', current === d.id);
          tile.onclick = () => done(d.id);
          const edit = h('button', 'deck-x', '✎');
          edit.title = 'Edit list';
          edit.onclick = async (e) => {
            e.stopPropagation();
            const saved = await this.paste(format, d);
            if (saved) done(saved.id);
            else render();
          };
          const del = h('button', 'deck-x del', '×');
          del.title = 'Delete deck';
          del.onclick = (e) => {
            e.stopPropagation();
            if (!confirm(`Delete "${d.name}"?`)) return;
            deleteDeck(d.id);
            if (current === d.id) current = null;
            render();
          };
          wrap.append(tile, edit, del);
          grid.append(wrap);
        }
        if (current?.startsWith(PRECON)) {
          const chosen = this.choiceTile(current, format);
          chosen.classList.add('current');
          chosen.onclick = () => done(current);
          grid.append(chosen);
        }
        const browse = h('button', 'deck-tile add');
        browse.append(h('div', 'deck-art plus', '♛'), h('div', 'deck-body', format === 'commander' ? 'Choose a commander precon…' : 'Choose a precon…'));
        browse.onclick = async () => {
          modal.style.visibility = 'hidden';
          const p = await this.browsePrecons(format);
          modal.style.visibility = '';
          if (p) {
            rememberPrecon(p);
            done(PRECON + p.name);
          }
        };
        grid.append(browse);
        const add = h('button', 'deck-tile add');
        add.append(h('div', 'deck-art plus', '+'), h('div', 'deck-body', 'Paste a deck list…'));
        add.onclick = async () => {
          const saved = await this.paste(format);
          if (saved) done(saved.id);
        };
        grid.append(add);
        box.append(grid);
        const actions = h('div', 'modal-buttons');
        const cancel = h('button', 'sub-btn', 'Cancel');
        cancel.onclick = () => done(undefined);
        actions.append(cancel);
        box.append(actions);
      };
      render();
      modal.append(box);
      this.root.append(modal);
    });
  }

  /** Forge's precons, searchable by deck name or commander. Resolves with the one picked, or null. */
  private browsePrecons(format: Format): Promise<PreconInfo | null> {
    return new Promise((resolve) => {
      const modal = h('div', 'modal deck-modal');
      const box = h('div', 'modal-panel deck-picker precon-browser');
      const done = (v: PreconInfo | null) => {
        modal.remove();
        resolve(v);
      };
      modal.onclick = (e) => {
        if (e.target === modal) done(null);
      };
      box.append(h('div', 'modal-title', format === 'commander' ? 'Choose a commander' : 'Choose a precon'));
      const search = h('input', 'paste-name precon-search');
      search.placeholder = format === 'commander' ? 'Search by commander, deck or colour (e.g. "BG", "dragons")' : 'Search decks';
      search.spellcheck = false;
      const grid = h('div', 'deck-grid');
      grid.append(h('div', 'paste-checking', 'Loading precons…'));
      const actions = h('div', 'modal-buttons');
      const cancel = h('button', 'sub-btn', 'Cancel');
      cancel.onclick = () => done(null);
      actions.append(cancel);
      box.append(search, grid, actions);
      modal.append(box);
      this.root.append(modal);
      setTimeout(() => search.focus(), 30);

      let all: PreconInfo[] = [];
      const show = () => {
        const q = search.value.trim().toLowerCase();
        const colorQuery = /^[wubrg]{1,5}$/i.test(q) ? q.toUpperCase().split('').sort().join('') : null;
        const hits = all.filter((p) => {
          if (!q) return true;
          if (colorQuery && [...p.colors].sort().join('') === colorQuery) return true;
          return p.name.toLowerCase().includes(q) || p.commanders.some((c) => c.toLowerCase().includes(q));
        });
        grid.replaceChildren();
        // tiles load their art as they're built, so long lists are built a page at a time
        const page = (from: number) => {
          for (const p of hits.slice(from, from + 40)) {
            const tile = this.preconTile(p);
            tile.onclick = () => done(p);
            grid.append(tile);
          }
          if (hits.length > from + 40) {
            const more = h('button', 'sub-btn wide precon-more', `Show more (${hits.length - from - 40})`);
            more.onclick = () => {
              more.remove();
              page(from + 40);
            };
            grid.append(more);
          }
        };
        if (hits.length === 0) grid.append(h('div', 'paste-note', 'No precon matches that.'));
        else page(0);
      };
      let timer = 0;
      search.oninput = () => {
        clearTimeout(timer);
        timer = window.setTimeout(show, 150);
      };
      void this.bridge.listPrecons(format).then((decks) => {
        all = [...decks].sort((a, b) => (a.commanders[0] ?? a.name).localeCompare(b.commanders[0] ?? b.name));
        if (all.length === 0) {
          grid.replaceChildren(h('div', 'paste-bad', 'The rules engine did not send its precon list.'));
          return;
        }
        show();
      });
    });
  }

  /** Paste (or edit) a list; the engine reads it as you type. Resolves with the saved deck. */
  private paste(format: Format, existing?: SavedDeck): Promise<SavedDeck | null> {
    return new Promise((resolve) => {
      const modal = h('div', 'modal deck-modal');
      const box = h('div', 'modal-panel deck-paste');
      const done = (v: SavedDeck | null) => {
        modal.remove();
        resolve(v);
      };
      box.append(h('div', 'modal-title', existing ? 'Edit deck' : 'Paste a deck list'));
      const hint = h('div', 'paste-hint');
      hint.innerHTML =
        format === 'commander'
          ? 'In Moxfield: <b>More → Export → Copy for MTGA</b> (or plain text). The commander is read from a “Commander” section, or from a single card set apart at the end.'
          : 'In Moxfield: <b>More → Export → Copy for MTGA</b> (or plain text). One card per line, e.g. <code>4 Lightning Bolt (2X2) 117</code>.';
      const name = h('input', 'paste-name');
      name.placeholder = 'Deck name (optional)';
      name.value = existing?.name ?? '';
      let nameTouched = !!existing;
      name.oninput = () => (nameTouched = true);
      const area = h('textarea', 'paste-area');
      area.placeholder = format === 'commander' ? 'Commander\n1 Atraxa, Praetors\' Voice (C16) 28\n\nDeck\n1 Sol Ring (C21) 263\n…' : '4 Lightning Bolt\n4 Goblin Guide\n…\n20 Mountain';
      area.value = existing?.list ?? '';
      area.spellcheck = false;
      const report = h('div', 'paste-report');
      const cmdPick = h('div', 'cmd-pick');
      const actions = h('div', 'modal-buttons');
      const cancel = h('button', 'sub-btn', 'Cancel');
      cancel.onclick = () => done(null);
      const ok = h('button', 'main-btn', existing ? 'Save' : 'Save deck');
      ok.disabled = true;
      actions.append(cancel, ok);
      box.append(hint, name, area, cmdPick, report, actions);
      modal.append(box);
      this.root.append(modal);
      area.focus();

      let info: DeckInfo | null = null;
      let chosen: string[] = existing?.commanders ?? [];
      let seq = 0;
      let timer = 0;
      const check = async () => {
        const list = area.value.trim();
        if (!list) {
          info = null;
          report.replaceChildren();
          cmdPick.replaceChildren();
          ok.disabled = true;
          return;
        }
        const mine = ++seq;
        report.replaceChildren(h('div', 'paste-checking', 'Reading list…'));
        const res = await this.bridge.validateDeck(list, format, chosen);
        if (mine !== seq) return;
        info = res;
        this.showReport(report, res, format);
        this.showCommanderPick(cmdPick, res, chosen, (picked) => {
          chosen = picked;
          void check();
        });
        if (res.ok && !nameTouched) name.value = res.commanders?.length ? res.commanders.join(' & ') : '';
        ok.disabled = !res.ok || (format === 'commander' && res.needsCommander);
      };
      area.oninput = () => {
        clearTimeout(timer);
        timer = window.setTimeout(check, 450);
      };
      if (existing) void check();

      ok.onclick = () => {
        if (!info?.ok) return;
        const deck: SavedDeck = {
          id: existing?.id ?? `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          name: name.value.trim() || info.commanders?.join(' & ') || info.face?.name || 'Custom deck',
          list: area.value.trim(),
          format,
          commanders: info.commanders ?? [],
          colors: info.colors ?? [],
          count: info.count ?? 0,
          face: info.face,
          savedAt: Date.now(),
        };
        storeDeck(deck);
        done(deck);
      };
    });
  }

  private showReport(el: HTMLElement, info: DeckInfo, format: Format): void {
    el.replaceChildren();
    if (!info.ok) {
      el.append(h('div', 'paste-bad', info.problem ?? 'No cards recognised in that list.'));
      return;
    }
    const sum = h('div', 'paste-summary');
    const art = h('div', 'deck-art');
    setArt(art, info.face);
    const body = h('div', 'deck-body');
    const total = (info.count ?? 0) + (info.commanders?.length ?? 0);
    body.append(
      h('div', 'deck-name', info.commanders?.length ? `Commander: ${info.commanders.join(' & ')}` : `${info.count} cards`),
      h('div', 'deck-meta', format === 'commander' ? `${total} cards including commander` : `${info.count} cards in the main deck`),
    );
    body.append(pips(info.colors ?? []));
    sum.append(art, body);
    el.append(sum);
    if (info.unknown.length) {
      el.append(h('div', 'paste-warn', `Not recognised (left out): ${info.unknown.map((u) => u.replace(/^\d+x?\s+/, '')).join(', ')}`));
    }
    for (const w of info.warnings.filter((w) => !/moved from/i.test(w))) el.append(h('div', 'paste-note', w));
    if (info.problem) el.append(h('div', 'paste-note', `Not format-legal (${info.problem}), but it can still be played.`));
  }

  private showCommanderPick(el: HTMLElement, info: DeckInfo, chosen: string[], onPick: (names: string[]) => void): void {
    el.replaceChildren();
    const options = [...new Set([...(info.commanders ?? []), ...info.candidates])];
    if (!info.ok || options.length === 0 || (!info.needsCommander && chosen.length === 0 && options.length <= (info.commanders?.length ?? 0))) return;
    el.append(h('span', '', info.needsCommander ? 'Which card is the commander?' : 'Commander:'));
    const sel = h('select');
    sel.append(new Option(info.needsCommander ? 'Choose…' : '—', ''));
    for (const o of options) sel.append(new Option(o, o));
    sel.value = info.commanders?.[0] ?? '';
    const sel2 = h('select');
    sel2.append(new Option('No partner', ''));
    for (const o of options) sel2.append(new Option(o, o));
    sel2.value = info.commanders?.[1] ?? '';
    const fire = () => onPick([sel.value, sel2.value].filter((v, i, a) => v && a.indexOf(v) === i));
    sel.onchange = fire;
    sel2.onchange = fire;
    el.append(sel);
    if (sel.value) el.append(sel2);
  }
}
