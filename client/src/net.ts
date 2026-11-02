import type { Action, DeckInfo, PreconInfo, SeatDeckSpec, ServerMsg } from './protocol';

type Listener = (msg: ServerMsg) => void;

/** WebSocket link to the Forge bridge. Reconnects quietly while the bridge boots. */
export class Bridge {
  private ws: WebSocket | null = null;
  private listeners: Listener[] = [];
  private statusListeners: ((connected: boolean) => void)[] = [];
  connected = false;
  private deckSeq = 0;
  private readonly deckWaiters = new Map<number, (info: DeckInfo) => void>();
  private readonly preconWaiters = new Map<string, ((decks: PreconInfo[]) => void)[]>();
  private readonly precons = new Map<string, PreconInfo[]>();

  constructor(private url = 'ws://127.0.0.1:7777') {}

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => this.setConnected(true);
    ws.onclose = () => {
      this.setConnected(false);
      setTimeout(() => this.connect(), 1000);
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

  /** deck: optional "4 Forest" per line list for the local player (others get precons) */
  /** names: what to call each seat (index 0 is you; opponents can be named) */
  /** Stop the current game (leaving for the main menu). */
  endGame(): void {
    this.send({ type: 'endGame' });
  }

  start(format: 'constructed' | 'commander', players: number, deck?: string, decks?: (SeatDeckSpec | null)[], names?: string[]): void {
    this.send({ type: 'start', format, players, ...(deck ? { deck } : {}), ...(decks ? { decks } : {}), ...(names ? { names } : {}) });
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
