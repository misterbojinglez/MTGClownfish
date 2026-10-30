import type { Action, ServerMsg } from './protocol';

type Listener = (msg: ServerMsg) => void;

/** WebSocket link to the Forge bridge. Reconnects quietly while the bridge boots. */
export class Bridge {
  private ws: WebSocket | null = null;
  private listeners: Listener[] = [];
  private statusListeners: ((connected: boolean) => void)[] = [];
  connected = false;

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

  start(format: 'constructed' | 'commander', players: number): void {
    this.send({ type: 'start', format, players });
  }

  act(a: Action): void {
    this.send({ type: 'action', ...a });
  }

  respond(id: number, value: unknown): void {
    this.send({ type: 'response', id, value });
  }
}
