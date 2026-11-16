/**
 * MTGClownfish online relay.
 *
 * The game itself runs on the host's computer (the Forge bridge). Home routers don't accept incoming
 * connections, so the bridge connects *out* to this relay, which gives the lobby a short code; friends open the
 * relay's page (it serves the web client), enter the code, and their browser's messages are passed to the host's
 * bridge and back. The relay never looks inside game messages.
 *
 *   wss://<relay>/host                     the host's bridge opens a lobby → {t: "hosted", code, secret}
 *   wss://<relay>/host?code=…&secret=…     the bridge reconnects to its lobby
 *   wss://<relay>/join/<code>              a friend's browser joins
 *
 * One Durable Object per lobby code holds the sockets. To the bridge each friend is a numbered connection:
 *   relay → host   {t: "open", c} · {t: "msg", c, d} · {t: "close", c}
 *   host → relay   {t: "msg", c, d} · {t: "kick", c}
 * Friends' sockets carry the plain game protocol.
 *
 * Close codes a friend's browser can see: 4404 no such game (stop trying), 4000 the host is reconnecting and
 * 4001 the host is away (try again shortly).
 */
import { DurableObject } from 'cloudflare:workers';

export interface Env {
  LOBBY: DurableObjectNamespace<Lobby>;
  ASSETS: Fetcher;
}

/** no 0/O, 1/I/L: codes get read out loud and typed on phones */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
/** how long a lobby waits for its host to come back after the bridge's connection drops */
const HOST_GRACE_MS = 3 * 60 * 1000;
/** the largest message passed along (a full table update is well under this) */
const MAX_MESSAGE = 1024 * 1024;
const MAX_FRIENDS = 8;

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

function isUpgrade(req: Request): boolean {
  return req.headers.get('Upgrade')?.toLowerCase() === 'websocket';
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/host') {
      if (!isUpgrade(req)) return new Response('WebSocket expected', { status: 426 });
      const resume = url.searchParams.get('code')?.toUpperCase();
      if (resume) {
        if (!CODE_RE.test(resume)) return new Response('Bad code', { status: 400 });
        return env.LOBBY.get(env.LOBBY.idFromName(resume)).fetch(req);
      }
      // a fresh lobby: find a code nobody is using
      for (let i = 0; i < 8; i++) {
        const code = newCode();
        const inner = new URL(req.url);
        inner.searchParams.set('new', code);
        const res = await env.LOBBY.get(env.LOBBY.idFromName(code)).fetch(new Request(inner.toString(), req));
        if (res.status !== 409) return res;
      }
      return new Response('No free code, try again', { status: 503 });
    }

    const join = url.pathname.match(/^\/join\/([A-Za-z0-9]+)$/);
    if (join) {
      if (!isUpgrade(req)) return new Response('WebSocket expected', { status: 426 });
      const code = join[1].toUpperCase();
      if (!CODE_RE.test(code)) return rejectSocket(4404, 'No game has that code.');
      return env.LOBBY.get(env.LOBBY.idFromName(code)).fetch(req);
    }

    // everything else is the web client
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

/** Answer a WebSocket request with a socket that closes straight away with a reason the browser can read. */
function rejectSocket(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(code, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

type Attachment = { role: 'host' } | { role: 'friend'; c: number };

export class Lobby extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/host') return this.host(url);
    const join = url.pathname.match(/^\/join\/([A-Za-z0-9]+)$/);
    if (join) return this.join();
    return new Response('Not found', { status: 404 });
  }

  private hostSocket(): WebSocket | undefined {
    return this.ctx.getWebSockets('host')[0];
  }

  private friend(c: number): WebSocket | undefined {
    return this.ctx.getWebSockets(`c${c}`)[0];
  }

  /** The host's bridge: opening a new lobby (?new=CODE) or coming back to its own (?code=…&secret=…). */
  private async host(url: URL): Promise<Response> {
    const fresh = url.searchParams.get('new');
    const storage = this.ctx.storage;
    let code: string;
    let secret: string;
    if (fresh) {
      // this code is taken while a lobby holds it
      if (await storage.get('active')) return new Response('Code in use', { status: 409 });
      code = fresh;
      secret = crypto.randomUUID();
      await storage.put({ active: true, code, secret, nextConn: 1 });
    } else {
      const active = await storage.get<boolean>('active');
      if (!active) return rejectSocket(4404, 'That lobby has closed.');
      if (url.searchParams.get('secret') !== (await storage.get<string>('secret'))) return rejectSocket(4403, 'Not this lobby\'s host.');
      code = (await storage.get<string>('code'))!;
      secret = (await storage.get<string>('secret'))!;
      // a stale connection of the same host gives way
      for (const old of this.ctx.getWebSockets('host')) old.close(1000, 'replaced');
    }
    await storage.deleteAlarm();
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ['host']);
    pair[1].serializeAttachment({ role: 'host' } satisfies Attachment);
    pair[1].send(JSON.stringify({ t: 'hosted', code, secret }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** A friend's browser. The host must be here to take them in. */
  private async join(): Promise<Response> {
    const storage = this.ctx.storage;
    if (!(await storage.get('active'))) return rejectSocket(4404, 'No game has that code.');
    const host = this.hostSocket();
    if (!host) return rejectSocket(4001, 'The host is away. Trying again…');
    if (this.ctx.getWebSockets('friend').length >= MAX_FRIENDS) return rejectSocket(4404, 'That table is full.');
    const c = (await storage.get<number>('nextConn')) ?? 1;
    await storage.put('nextConn', c + 1);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ['friend', `c${c}`]);
    pair[1].serializeAttachment({ role: 'friend', c } satisfies Attachment);
    host.send(JSON.stringify({ t: 'open', c }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE) return;
    const who = ws.deserializeAttachment() as Attachment;
    if (who.role === 'friend') {
      this.hostSocket()?.send(JSON.stringify({ t: 'msg', c: who.c, d: message }));
      return;
    }
    let m: { t?: string; c?: number; d?: string };
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }
    if (typeof m.c !== 'number') return;
    const target = this.friend(m.c);
    if (!target) return;
    if (m.t === 'msg' && typeof m.d === 'string') target.send(m.d);
    else if (m.t === 'kick') target.close(1000, 'left the lobby');
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
    await this.gone(ws, code);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.gone(ws, 1011);
  }

  private async gone(ws: WebSocket, code: number): Promise<void> {
    const who = ws.deserializeAttachment() as Attachment | null;
    if (!who) return;
    if (who.role === 'friend') {
      this.hostSocket()?.send(JSON.stringify({ t: 'close', c: who.c }));
      return;
    }
    // the host's bridge went away. Friends reconnect on their own (with their tokens) once it's back.
    if (this.ctx.getWebSockets('host').some((h) => h !== ws)) return; // replaced by a newer connection
    const closing = code === 1000;
    for (const f of this.ctx.getWebSockets('friend')) {
      f.close(closing ? 4404 : 4000, closing ? 'The host closed the lobby.' : 'The host is reconnecting…');
    }
    if (closing) {
      await this.ctx.storage.deleteAll();
    } else {
      await this.ctx.storage.setAlarm(Date.now() + HOST_GRACE_MS);
    }
  }

  /** The host never came back: the lobby (and its code) is gone. */
  async alarm(): Promise<void> {
    if (this.hostSocket()) return;
    for (const f of this.ctx.getWebSockets('friend')) f.close(4404, 'The host left.');
    await this.ctx.storage.deleteAll();
  }
}
