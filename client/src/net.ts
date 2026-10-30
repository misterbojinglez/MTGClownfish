import type { Action, DeckInfo, SeatDeckSpec, ServerMsg } from './protocol';

type Listener = (msg: ServerMsg) => void;

/** WebSocket link to the Forge bridge. Reconnects quietly while the bridge boots. */
export class Bridge {
  private ws: WebSocket | null = null;
  private listeners: Listener[] = [];
  private statusListeners: ((connected: boolean) => void)[] = [];
  connected = false;
  private deckSeq = 0;
  private readonly deckWaiters = new Map<number, (info: DeckInfo) => void>();

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
  start(format: 'constructed' | 'commander', players: number, deck?: string, decks?: (SeatDeckSpec | null)[]): void {
    this.send({ type: 'start', format, players, ...(deck ? { deck } : {}), ...(decks ? { decks } : {}) });
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

  act(a: Action): void {
    this.send({ type: 'action', ...a });
  }

  respond(id: number, value: unknown): void {
    this.send({ type: 'response', id, value });
  }
}
