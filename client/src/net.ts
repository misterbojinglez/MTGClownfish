import type { Action, DeckInfo, GameplanInfo, PreconInfo, SeatDeckSpec, ServerMsg } from './protocol';

type Listener = (msg: ServerMsg) => void;

const TOKEN_KEY = 'mtg-tabletop.token';
const NAME_KEY = 'mtg-tabletop.playerName';

/** This browser's identity: sent in every hello, so a dropped connection gets its seat (and game) back. */
export function playerToken(): string {
  try {
    let t = localStorage.getItem(TOKEN_KEY);
    if (!t || !/^[A-Za-z0-9_-]{16,64}$/.test(t)) {
      const bytes = crypto.getRandomValues(new Uint8Array(18));
      t = Array.from(bytes, (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b % 64]).join('');
      localStorage.setItem(TOKEN_KEY, t);
    }
    return t;
  } catch {
    // no storage (private window): one identity for this page
    return (playerToken as unknown as { t?: string }).t ??= Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => (b % 36).toString(36)).join('');
  }
}

/** The name you play under online. */
export function playerName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setPlayerName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name.trim().slice(0, 24));
  } catch {
    /* not remembered */
  }
}

/** WebSocket link to the Forge bridge. Reconnects quietly while the bridge boots. */
export class Bridge {
  private ws: WebSocket | null = null;
  private listeners: Listener[] = [];
  private statusListeners: ((connected: boolean) => void)[] = [];
  connected = false;
  private deckSeq = 0;
  private readonly deckWaiters = new Map<number, (info: DeckInfo) => void>();
  private readonly planWaiters = new Map<number, (info: GameplanInfo) => void>();
  private readonly preconWaiters = new Map<string, ((decks: PreconInfo[]) => void)[]>();
  private readonly precons = new Map<string, PreconInfo[]>();

  private closedListeners: ((reason: string) => void)[] = [];
  /** a game through the relay that's gone for good: stop reconnecting */
  private stopped = false;
  private retries = 0;

  constructor(private url = 'ws://127.0.0.1:7777') {}

  /** Point at another endpoint (the relay, for a friend's game) and connect there. */
  setUrl(url: string): void {
    this.url = url;
    this.stopped = false;
    this.retries = 0;
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onclose = null;
      old.close();
    }
    this.connect();
  }

  /** Called when the relay says the game is gone (no such code, the host closed it): no more reconnecting. */
  onClosed(l: (reason: string) => void): void {
    this.closedListeners.push(l);
  }

  connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      // who this is: a returning token gets its seat (and its game) back
      ws.send(JSON.stringify({ type: 'hello', token: playerToken(), name: playerName() }));
      this.setConnected(true);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.setConnected(false);
      if (ev.code === 4404 || ev.code === 4403) {
        this.stopped = true;
        for (const l of this.closedListeners) l(ev.reason || 'That game has closed.');
        return;
      }
      // the bridge booting, the host reconnecting (4000) or away (4001): keep trying, gently
      this.retries++;
      setTimeout(() => this.connect(), Math.min(5000, 600 * this.retries));
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as ServerMsg;
      // deck checks answer the setup screen directly, outside the game's message queue
      if (msg.type === 'deckInfo') {
        this.deckWaiters.get(msg.id)?.(msg);
        this.deckWaiters.delete(msg.id);
        return;
      }
      if (msg.type === 'gameplan') {
        this.planWaiters.get(msg.id)?.(msg);
        this.planWaiters.delete(msg.id);
        return;
      }
      if (msg.type === 'precons') {
        this.precons.set(msg.format, msg.decks);
        for (const w of this.preconWaiters.get(msg.format) ?? []) w(msg.decks);
        this.preconWaiters.delete(msg.format);
        return;
      }
      for (const l of this.listeners) l(msg);
    };
  }

  private setConnected(v: boolean): void {
    this.connected = v;
    for (const l of this.statusListeners) l(v);
  }

  onMessage(l: Listener): void {
    this.listeners.push(l);
  }

  onStatus(l: (connected: boolean) => void): void {
    this.statusListeners.push(l);
  }

  private send(obj: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // ---- online lobby ----

  /** Open an online lobby (this computer hosts; the relay gives it a code). */
  hostLobby(format: 'constructed' | 'commander', players: number, name: string): void {
    this.send({ type: 'hostLobby', format, players, name });
  }

  /** Your own seat in the lobby: its deck (and what to show for it), your readiness, your name. */
  lobbySeat(update: { deck?: SeatDeckSpec | null; info?: unknown; ready?: boolean; name?: string }): void {
    this.send({ type: 'lobbySeat', ...update });
  }

  /** Host only: the table (format, seats) and the AI seats' decks and gameplans. */
  lobbyConfig(update: Record<string, unknown>): void {
    this.send({ type: 'lobbyConfig', ...update });
  }

  /** Host only: start the game. */
  lobbyStart(apiKey?: string): void {
    this.send({ type: 'lobbyStart', ...(apiKey ? { apiKey } : {}) });
  }

  /** Leave the lobby (the host closes it). */
  leaveLobby(): void {
    this.send({ type: 'leaveLobby' });
  }

  /** deck: optional "4 Forest" per line list for the local player (others get precons) */
  /** names: what to call each seat (index 0 is you; opponents can be named) */
  /** Stop the current game (leaving for the main menu). */
  endGame(): void {
    this.send({ type: 'endGame' });
  }

  /** apiKey: the player's Claude API key, for opponents' gameplans not yet turned into AI settings */
  start(format: 'constructed' | 'commander', players: number, deck?: string, decks?: (SeatDeckSpec | null)[], names?: string[], apiKey?: string): void {
    this.send({ type: 'start', format, players, ...(deck ? { deck } : {}), ...(decks ? { decks } : {}), ...(names ? { names } : {}), ...(apiKey ? { apiKey } : {}) });
  }

  /**
   * Turn an opponent's plain-language gameplan into AI settings (one Claude request on the bridge, then cached
   * there) and get back how the AI will read it. Can take a minute the first time.
   */
  compileGameplan(spec: SeatDeckSpec, format: 'constructed' | 'commander', gameplan: string, apiKey?: string): Promise<GameplanInfo> {
    const id = ++this.deckSeq;
    return new Promise((resolve) => {
      this.planWaiters.set(id, resolve);
      this.send({ type: 'compileGameplan', id, spec, format, gameplan, ...(apiKey ? { apiKey } : {}) });
      setTimeout(() => {
        if (!this.planWaiters.has(id)) return;
        this.planWaiters.delete(id);
        resolve({ type: 'gameplan', id, ok: false, error: 'The rules engine did not answer in time. Try again.' });
      }, 300000);
    });
  }

  /** Forge's precon decks for a format (fetched once, then remembered). */
  listPrecons(format: 'constructed' | 'commander'): Promise<PreconInfo[]> {
    const have = this.precons.get(format);
    if (have) return Promise.resolve(have);
    return new Promise((resolve) => {
      const waiting = this.preconWaiters.get(format);
      if (waiting) return waiting.push(resolve);
      this.preconWaiters.set(format, [resolve]);
      this.send({ type: 'listPrecons', format });
      setTimeout(() => {
        const w = this.preconWaiters.get(format);
        if (!w) return;
        this.preconWaiters.delete(format);
        w.forEach((f) => f([]));
      }, 30000);
    });
  }

  /** Ask the engine to read a pasted deck list (Moxfield, MTGA, MTGO or plain text). */
  validateDeck(list: string, format: 'constructed' | 'commander', commanders?: string[]): Promise<DeckInfo> {
    const id = ++this.deckSeq;
    return new Promise((resolve) => {
      this.deckWaiters.set(id, resolve);
      this.send({ type: 'validateDeck', id, list, format, ...(commanders?.length ? { commanders } : {}) });
      setTimeout(() => {
        if (!this.deckWaiters.has(id)) return;
        this.deckWaiters.delete(id);
        resolve({ type: 'deckInfo', id, ok: false, needsCommander: false, unknown: [], warnings: [], candidates: [], problem: 'The rules engine did not answer' });
      }, 20000);
    });
  }

  /**
   * The prompt the player is looking at. The client animates a beat behind Forge, so prompt answers carry
   * it and the bridge drops any that arrive after Forge has moved on to a different prompt.
   */
  shownInput: number | undefined;

  act(a: Action, input = this.shownInput): void {
    this.send({ type: 'action', ...a, ...(input != null ? { input } : {}) });
  }

  respond(id: number, value: unknown): void {
    this.send({ type: 'response', id, value });
  }
}
