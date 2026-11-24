import { askYes } from './buildin';
import type { Bridge } from '../net';
import { playerName, setPlayerName } from '../net';
import type { LobbySeat, LobbyState } from '../protocol';
import { claudeKey, type DeckSetup, tabletalkRow } from './decks';

/**
 * The online lobby: the join code (and link) to share, everyone's seat and deck, and for the host the table's
 * settings and Start. The bridge owns the lobby; this screen draws whatever it last sent and sends changes back.
 */

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

const SEAT_HUES = [8, 120, 200, 285];

export class LobbyView {
  private state: LobbyState | null = null;
  private overlay: HTMLElement | null = null;
  /** your own deck pick (a seat choice in this browser's deck list) */
  private myChoice: string | null = null;
  /** host: the AI seats' deck picks, for their gameplans (which are kept by deck in this browser) */
  private readonly aiChoices = new Map<number, string | null>();

  constructor(
    private readonly root: HTMLElement,
    private readonly bridge: Bridge,
    private readonly decks: DeckSetup,
    private readonly toast: (text: string, kind?: string) => void,
  ) {}

  get current(): LobbyState | null {
    return this.state;
  }

  /** The bridge's latest word on the lobby. Drawn unless hidden (during a game). */
  update(state: LobbyState, visible: boolean): void {
    const was = this.state;
    this.state = state;
    // the format changed: deck picks belong to the old one
    if (was && was.format !== state.format) {
      this.myChoice = null;
      this.aiChoices.clear();
    }
    if (visible) this.render();
  }

  /** The lobby is gone (closed by the host, or you left). */
  clear(): void {
    this.state = null;
    this.myChoice = null;
    this.aiChoices.clear();
    this.hide();
  }

  show(): void {
    if (this.state) this.render();
  }

  hide(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  private render(): void {
    const s = this.state;
    if (!s) return;
    const scroll = this.overlay?.querySelector('.lobby-seats')?.scrollTop ?? 0;
    this.overlay?.remove();
    const ov = h('div', 'overlay setup lobby');
    this.overlay = ov;

    const head = h('div', 'setup-head');
    head.append(h('h2', '', s.format === 'commander' ? 'Online · Commander' : 'Online · Duel'));
    ov.append(head);

    // the code to share
    const share = h('div', 'lobby-share');
    if (s.problem) {
      share.append(h('div', 'paste-bad', s.problem));
    } else if (!s.code) {
      share.append(h('div', 'paste-checking', 'Opening the lobby…'));
    } else {
      share.append(h('div', 'lobby-code-label', s.host ? 'Share this code with your friends' : 'Game code'));
      const code = h('div', 'lobby-code', s.code.replace(/^(...)(...)$/, '$1-$2'));
      share.append(code);
      if (s.host) {
        const row = h('div', 'lobby-share-row');
        const copyCode = h('button', 'sub-btn', 'Copy code');
        copyCode.onclick = () => this.copy(s.code!, 'Code copied');
        row.append(copyCode);
        if (s.link) {
          const copyLink = h('button', 'sub-btn', 'Copy invite link');
          copyLink.onclick = () => this.copy(s.link!, 'Invite link copied');
          row.append(copyLink);
        }
        share.append(row, h('div', 'paste-note', 'Friends open the invite link (or the game’s site and enter the code). They only need a browser.'));
      }
    }
    ov.append(share);

    // host: the table
    if (s.host && !s.playing) {
      const table = h('div', 'lobby-table');
      const formats = h('div', 'seg');
      for (const [f, label] of [['constructed', 'Duel'], ['commander', 'Commander']] as const) {
        const b = h('button', s.format === f ? 'on' : '', label);
        b.onclick = () => {
          if (s.format === f) return;
          this.bridge.lobbyConfig({ format: f, players: f === 'commander' ? Math.max(s.seats.length, 2) : 2 });
        };
        formats.append(b);
      }
      table.append(formats);
      if (s.format === 'commander') {
        const counts = h('div', 'seg');
        for (const n of [2, 3, 4]) {
          const b = h('button', s.seats.length === n ? 'on' : '', `${n} players`);
          b.onclick = () => this.bridge.lobbyConfig({ players: n });
          counts.append(b);
        }
        table.append(counts);
      }
      ov.append(table);
      ov.append(tabletalkRow(s.talk, async (on) => {
        // the host's key speaks for the AIs
        if (on && !claudeKey()) await this.decks.keyEditor();
        this.bridge.lobbyConfig({ talk: on && !!claudeKey() });
        if (on && !claudeKey()) this.update(s, true);
      }));
    }

    if (!s.host && s.talk) ov.append(h('div', 'paste-note', 'Tabletalk is on: the AI opponents chat, and you can talk to them. What you say goes to Claude through the host’s API key.'));

    const seats = h('div', 'seats lobby-seats');
    s.seats.forEach((seat, i) => seats.append(this.seatRow(s, seat, i)));
    ov.append(seats);
    requestAnimationFrame(() => (seats.scrollTop = scroll));

    // footer: ready / start / leave
    const actions = h('div', 'setup-actions');
    const leave = h('button', 'sub-btn', s.host ? 'Close lobby' : 'Leave');
    leave.onclick = async () => {
      if (s.host && s.seats.some((x) => x.kind === 'human') && !(await askYes(this.root, 'Close the lobby?', 'Everyone in it will be sent away.', 'Close lobby'))) return;
      this.bridge.leaveLobby();
      this.clear();
      this.onLeave?.();
    };
    actions.append(leave);
    const me = s.seats[s.you];
    if (s.host) {
      const waiting = s.seats.filter((x) => x.kind === 'human' && x.connected && !x.ready);
      const start = h('button', 'main-btn wide glow', s.playing ? 'Game in progress…' : 'Start game');
      start.disabled = s.playing || waiting.length > 0 || !s.code;
      if (waiting.length) start.title = `Waiting for ${waiting.map((x) => x.name).join(', ')} to be ready`;
      start.onclick = () => {
        // gameplans for the AI seats may still need translating at the start: the key goes along
        const planned = s.talk || s.seats.some((x) => x.gameplan);
        this.bridge.lobbyStart(planned ? claudeKey() || undefined : undefined);
      };
      actions.append(start);
      if (waiting.length) ov.append(h('div', 'paste-note lobby-wait', `Waiting for ${waiting.map((x) => x.name).join(', ')} to press Ready`));
    } else if (me) {
      const ready = h('button', me.ready ? 'sub-btn wide' : 'main-btn wide glow', me.ready ? 'Not ready' : 'Ready');
      ready.disabled = s.playing;
      ready.onclick = () => this.bridge.lobbySeat({ ready: !me.ready });
      actions.append(ready);
      if (me.ready) ov.append(h('div', 'paste-note lobby-wait', 'Waiting for the host to start'));
    }
    ov.append(actions);
    this.root.append(ov);
  }

  /** Called after you leave or close the lobby (back to the menu). */
  onLeave: (() => void) | null = null;

  private seatRow(s: LobbyState, seat: LobbySeat, i: number): HTMLElement {
    const row = h('div', `seat-row${i === s.you ? ' mine' : ''}`);
    const badge = h('div', 'seat-badge', (seat.name.trim()[0] ?? '?').toUpperCase());
    badge.style.setProperty('--hue', String(SEAT_HUES[i % 4]));
    const who = h('div', 'seat-who');

    if (i === s.you) {
      // your name, editable before the game
      const input = h('input', 'seat-name-input');
      input.value = seat.name;
      input.maxLength = 24;
      input.spellcheck = false;
      input.disabled = s.playing;
      input.title = 'Your name at the table (click to change)';
      input.onchange = () => {
        const name = input.value.trim();
        if (!name) {
          input.value = seat.name;
          return;
        }
        setPlayerName(name);
        this.bridge.lobbySeat({ name });
      };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') input.blur();
      };
      // the name box only stretches inside a row (as on the single-player setup screen)
      const nameRow = h('div', 'seat-name-row');
      const pencil = h('span', 'seat-edit', '✎');
      pencil.onclick = () => input.focus();
      nameRow.append(input, pencil);
      who.append(nameRow);
    } else {
      who.append(h('div', 'seat-name', seat.name));
    }

    const role = { host: 'Host', human: 'Player', ai: 'AI', open: 'Open · AI if nobody joins' }[seat.kind];
    const status = h('div', 'seat-role');
    status.append(h('span', '', i === s.you ? `${role} · you` : role));
    if (seat.kind === 'human' || seat.kind === 'host') {
      if (!seat.connected) status.append(h('span', 'lobby-tag away', 'reconnecting…'));
      else if (seat.kind === 'human') status.append(h('span', `lobby-tag ${seat.ready ? 'ready' : ''}`, seat.ready ? 'ready' : 'choosing'));
    }
    who.append(status);

    // host's controls for the other seats
    const person = seat.kind === 'host' || seat.kind === 'human';
    if (s.host && i !== s.you && !s.playing) {
      const ctl = h('div', 'lobby-seat-ctl');
      if (seat.kind === 'human') {
        const remove = h('button', 'link-btn', 'Give seat to AI');
        remove.onclick = async () => {
          if (await askYes(this.root, `Remove ${seat.name} from the table?`, 'An AI takes their seat.', 'Remove')) this.bridge.lobbyConfig({ seat: i, kind: 'ai' });
        };
        ctl.append(remove);
      } else {
        const toggle = h('button', 'link-btn', seat.kind === 'open' ? 'Keep for AI' : 'Open for a friend');
        toggle.onclick = () => this.bridge.lobbyConfig({ seat: i, kind: seat.kind === 'open' ? 'ai' : 'open' });
        ctl.append(toggle);
        const choice = this.aiChoices.get(i) ?? null;
        const plan = h('button', `gameplan-btn${seat.gameplan ? ' set' : ''}`, seat.gameplan ? '✦ Gameplan (beta)' : '+ Gameplan (beta)');
        plan.title = choice ? 'Tell this AI how to pilot its deck' : 'Choose this seat’s deck first';
        plan.onclick = async () => {
          let c = choice;
          if (!c) {
            const picked = await this.decks.pickDeck(s.format, null);
            if (!picked?.choice) return;
            c = picked.choice;
            this.aiChoices.set(i, c);
            this.bridge.lobbyConfig({ seat: i, deck: picked.spec, info: picked.info });
          }
          const gameplan = await this.decks.editGameplan(s.format, c);
          this.bridge.lobbyConfig({ seat: i, gameplan });
        };
        ctl.append(plan);
      }
      who.append(ctl);
    }

    // the deck: yours to pick, or (host) an AI seat's
    const tile = this.decks.lobbyDeckTile(seat.deck, s.format);
    tile.classList.add('seat-deck');
    const canPick = !s.playing && (i === s.you || (s.host && !person));
    if (canPick) {
      tile.title = 'Choose a deck';
      tile.onclick = async () => {
        const current = i === s.you ? this.myChoice : this.aiChoices.get(i) ?? null;
        const picked = await this.decks.pickDeck(s.format, current);
        if (picked === undefined) return;
        if (i === s.you) {
          this.myChoice = picked.choice;
          this.bridge.lobbySeat({ deck: picked.spec, info: picked.info, ready: false });
        } else {
          this.aiChoices.set(i, picked.choice);
          this.bridge.lobbyConfig({ seat: i, deck: picked.spec, info: picked.info, gameplan: '' });
        }
      };
    } else {
      tile.classList.add('readonly');
    }
    row.append(badge, who, tile);
    return row;
  }

  private copy(text: string, done: string): void {
    void navigator.clipboard?.writeText(text).then(
      () => this.toast(done),
      () => this.toast(text),
    );
  }
}

/** Ask for the name to play under online (remembered). Resolves with it, or null if cancelled. */
export function askName(root: HTMLElement, title: string, action: string): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = h('div', 'modal deck-modal');
    const box = h('div', 'modal-panel gameplan-panel');
    const done = (v: string | null) => {
      modal.remove();
      resolve(v);
    };
    box.append(h('div', 'modal-title', title));
    const input = h('input', 'paste-name');
    input.placeholder = 'Your name';
    input.maxLength = 24;
    input.value = playerName();
    const actions = h('div', 'modal-buttons');
    const cancel = h('button', 'sub-btn', 'Cancel');
    cancel.onclick = () => done(null);
    const ok = h('button', 'main-btn', action);
    ok.onclick = () => {
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return;
      }
      setPlayerName(name);
      done(name);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') ok.click();
      if (e.key === 'Escape') done(null);
    };
    actions.append(cancel, ok);
    box.append(input, actions);
    modal.append(box);
    modal.onclick = (e) => {
      if (e.target === modal) done(null);
    };
    root.append(modal);
    input.focus();
    input.select();
  });
}

/** A join code as typed: letters and digits only, upper case ("k7q-4mx" → "K7Q4MX"). */
export function cleanCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

/**
 * The relay's page (what a friend opens): the logo, their name, the code. Resolves when they press Join.
 * message: why they're here again (the game closed, the code didn't work).
 */
export function joinScreen(root: HTMLElement, prefill: string, message: string | null, onJoin: (code: string, name: string) => void): void {
  root.querySelectorAll('.overlay').forEach((e) => e.remove());
  const ov = h('div', 'overlay menu join');
  const title = h('h1', 'menu-logo');
  const logo = h('img');
  logo.src = '/logo-large.webp';
  logo.srcset = '/logo-360.webp 360w, /logo-large.webp 960w';
  logo.sizes = 'min(560px, 72vw)';
  logo.alt = 'MTGClownfish';
  title.append(logo);
  ov.append(title, h('p', 'sub tagline', 'Join a friend’s game'));
  const form = h('div', 'join-form');
  const name = h('input', 'paste-name');
  name.placeholder = 'Your name';
  name.maxLength = 24;
  name.value = playerName();
  const code = h('input', 'paste-name join-code');
  code.placeholder = 'Game code, e.g. K7Q-4MX';
  code.setAttribute('aria-label', 'Game code');
  code.value = prefill;
  code.autocapitalize = 'characters';
  code.spellcheck = false;
  code.oninput = () => (code.value = cleanCode(code.value).replace(/^(...)(.+)$/, '$1-$2'));
  code.oninput(new Event('input'));
  const go = h('button', 'main-btn wide glow', 'Join');
  const submit = () => {
    const n = name.value.trim();
    const c = cleanCode(code.value);
    if (!n) return name.focus();
    if (c.length !== 6) return code.focus();
    setPlayerName(n);
    onJoin(c, n);
  };
  go.onclick = submit;
  // (a handler that returns false cancels the key, so these must not return the comparison)
  for (const el of [name, code]) {
    el.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
    };
  }
  form.append(name, code, go);
  if (message) form.append(h('div', 'paste-bad', message));
  ov.append(form);
  root.append(ov);
  (prefill && name.value ? go : name.value ? code : name).focus();
}

/**
 * The menu's Online card: host a game here, or join one with a code (which opens the relay's page, where
 * friends' games are joined).
 */
export function onlineChooser(root: HTMLElement, relay: string | null, onHost: (format: 'constructed' | 'commander', players: number) => void): void {
  const modal = h('div', 'modal deck-modal');
  const box = h('div', 'modal-panel gameplan-panel');
  const close = () => modal.remove();
  box.append(h('div', 'modal-title', 'Play online'));
  if (!relay) {
    box.append(h('div', 'paste-bad', 'Online play isn’t set up in this copy: the relay’s address is missing.'));
  } else {
    box.append(h('div', 'modal-sub', 'Host a game on this computer and share its code, or join a friend’s game. Friends only need a browser.'));
    const hostRow = h('div', 'online-row');
    for (const [label, format, players] of [['Host a Duel', 'constructed', 2], ['Host Commander', 'commander', 4]] as const) {
      const b = h('button', 'menu-card');
      b.append(h('div', 'menu-title', label), h('div', 'menu-desc', format === 'commander' ? 'Up to 4 players; AI fills empty seats' : '1 v 1 with a friend'));
      b.onclick = () => {
        close();
        onHost(format, players);
      };
      hostRow.append(b);
    }
    box.append(hostRow);
    box.append(h('div', 'online-label', 'Join a friend’s game'));
    const joinRow = h('div', 'online-join');
    const code = h('input', 'paste-name join-code');
    code.placeholder = 'Code, e.g. K7Q-4MX';
    code.setAttribute('aria-label', 'Friend’s game code');
    code.oninput = () => (code.value = cleanCode(code.value).replace(/^(...)(.+)$/, '$1-$2'));
    const join = h('button', 'sub-btn', 'Join');
    join.onclick = () => {
      const c = cleanCode(code.value);
      if (c.length !== 6) return code.focus();
      // friends' games are joined on the relay's page
      location.href = `${relay}/?join=${c}`;
    };
    code.onkeydown = (e) => {
      if (e.key === 'Enter') join.click();
    };
    joinRow.append(code, join);
    box.append(joinRow);
  }
  const actions = h('div', 'modal-buttons');
  const cancel = h('button', 'sub-btn', 'Close');
  cancel.onclick = close;
  actions.append(cancel);
  box.append(actions);
  modal.append(box);
  modal.onclick = (e) => {
    if (e.target === modal) close();
  };
  root.append(modal);
}
