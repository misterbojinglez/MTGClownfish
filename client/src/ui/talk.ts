import type { OfferState, TalkDeal, TalkLine } from '../protocol';

/**
 * Tabletalk: what the players say, in bubbles at their badges, and a small chat in the lower-left corner with a
 * field to answer in and the deals in force. Shown only in a game started with Tabletalk on.
 */

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** thumbs, drawn so they match on every system */
const THUMB = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 10h4v11H2zM8 21V10l5-8c1.6 0 2.6 1.3 2.2 2.9L14.2 9H20c1.3 0 2.2 1.2 1.9 2.4l-1.9 8c-.2.9-1 1.6-2 1.6z"/></svg>';

const HIDDEN_KEY = 'mtgclownfish.talkHidden';

export class TableTalk {
  private readonly panel = h('div', 'talk');
  private readonly log = h('div', 'talk-log');
  private readonly dealsEl = h('div', 'talk-deals');
  private readonly input = h('input', 'talk-input');
  private readonly toggle = h('button', 'talk-toggle');
  /** one bubble per player: the newest thing they said */
  private readonly bubbles = new Map<number, { el: HTMLDivElement; timer: number }>();
  private seen = new Set<number>();
  /** your own lines, shown the moment you send them, until the table's copy arrives */
  private pending: { text: string; row: HTMLElement }[] = [];
  private readonly rows = new Map<number, { row: HTMLElement; line: TalkLine }>();
  private hidden = false;
  private unread = 0;

  /** badge: where a player's badge is on screen; send: say something to the table */
  constructor(
    private readonly root: HTMLElement,
    private readonly badge: (player: number) => { x: number; y: number } | null,
    private readonly isMe: (player: number) => boolean,
    send: (text: string) => void,
    private readonly answer: (id: number, accept: boolean) => void,
    private readonly me: () => { id: number; name: string },
  ) {
    try {
      this.hidden = localStorage.getItem(HIDDEN_KEY) === '1';
    } catch {
      /* shown */
    }
    this.log.setAttribute('role', 'log');
    this.log.setAttribute('aria-label', 'Table talk');
    this.input.placeholder = 'Talk to the table (T)';
    this.input.maxLength = 300;
    this.input.setAttribute('aria-label', 'Talk to the table');
    this.input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.input.blur();
      if (e.key !== 'Enter' || e.isComposing) return;
      const text = this.input.value.trim();
      if (text) {
        this.echo(text);
        send(text);
      }
      this.input.value = '';
    };
    this.toggle.onclick = () => this.setHidden(!this.hidden);
    const head = h('div', 'talk-head');
    head.append(h('span', 'talk-title', 'Tabletalk'), this.toggle);
    this.panel.append(head, this.dealsEl, this.log, this.input);
    this.root.append(this.panel);
    window.addEventListener('keydown', (e) => {
      if ((e.key !== 't' && e.key !== 'T') || e.metaKey || e.ctrlKey || e.altKey || !this.panel.classList.contains('show')) return;
      if ((e.target as HTMLElement).closest?.('input, textarea, select') || document.querySelector('.modal:not(.out):not(.peek):not(.on-table)')) return;
      e.preventDefault();
      this.setHidden(false);
      this.input.focus();
    });
    this.setHidden(this.hidden);
  }

  private setHidden(v: boolean): void {
    this.hidden = v;
    if (!v) this.unread = 0;
    this.panel.classList.toggle('closed', v);
    this.label();
    this.log.scrollTop = this.log.scrollHeight;
    try {
      localStorage.setItem(HIDDEN_KEY, v ? '1' : '0');
    } catch {
      /* not remembered */
    }
  }

  private idle = 0;

  /** Something was said: the chat comes forward for a while, then fades back (it's also solid in use). */
  private wake(): void {
    this.panel.classList.add('lively');
    clearTimeout(this.idle);
    this.idle = window.setTimeout(() => this.panel.classList.remove('lively'), 6000);
  }

  private label(): void {
    this.toggle.textContent = this.hidden ? (this.unread ? `Show (${this.unread})` : 'Show') : 'Hide';
    this.toggle.setAttribute('aria-expanded', String(!this.hidden));
  }

  /** A new game, or leaving one: no talk until the bridge says it's on. */
  clear(): void {
    this.panel.classList.remove('show');
    this.log.replaceChildren();
    this.dealsEl.replaceChildren();
    this.bubbles.forEach((b) => {
      clearTimeout(b.timer);
      b.el.remove();
    });
    this.bubbles.clear();
    this.seen.clear();
    this.pending = [];
    this.rows.clear();
    this.unread = 0;
    this.input.value = '';
  }

  /** Tabletalk is on: what's been said so far (none, or after reconnecting). */
  start(lines: TalkLine[], deals: TalkDeal[]): void {
    this.clear();
    this.panel.classList.add('show');
    lines.forEach((l) => this.add(l, false));
    this.deals(deals);
    this.label();
  }

  /** What you just said, at once; it's firmed up when the table's copy comes back. */
  private echo(text: string): void {
    const clean = text.replace(/[\x00-\x1f\x7f<>]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const row = this.row({ type: 'talk', id: 0, name: this.me().name, text: clean, human: true });
    row.classList.add('sending');
    this.log.append(row);
    this.log.scrollTop = this.log.scrollHeight;
    this.pending.push({ text: clean, row });
    this.wake();
    this.bubble(this.me().id, clean);
  }

  private row(line: TalkLine): HTMLElement {
    const row = h('div', `talk-line${line.system ? ' system' : ''}${line.human ? ' human' : ''}`);
    if (!line.system) row.append(h('b', '', `${line.name ?? ''} `));
    row.append(document.createTextNode(line.text));
    if (line.offer) {
      const foot = h('div', 'talk-offer');
      this.offerFoot(foot, line);
      row.append(foot);
    }
    return row;
  }

  /** Thumbs for an offer made to you, until it's answered; then how it went. */
  private offerFoot(foot: HTMLElement, line: TalkLine): void {
    const o = line.offer!;
    if (o.state !== 'open') {
      foot.replaceChildren(h('span', 'talk-left', { accepted: 'Accepted', declined: 'Turned down', lapsed: 'No longer on offer' }[o.state]));
      return;
    }
    if (!this.isMe(o.to)) {
      foot.replaceChildren(h('span', 'talk-left', 'Waiting for an answer'));
      return;
    }
    const thumb = (accept: boolean) => {
      const b = h('button', `talk-thumb ${accept ? 'up' : 'down'}`);
      b.innerHTML = THUMB;
      b.title = accept ? 'Accept the deal' : 'Turn it down';
      b.setAttribute('aria-label', `${b.title}: ${line.text}`);
      b.onclick = () => {
        foot.querySelectorAll('button').forEach((x) => (x.disabled = true));
        this.answer(line.id, accept);
      };
      return b;
    };
    foot.replaceChildren(thumb(true), thumb(false));
  }

  /** An offer was answered, or lapsed. */
  settle(id: number, state: OfferState): void {
    const at = this.rows.get(id);
    if (!at?.line.offer) return;
    at.line.offer = { ...at.line.offer, state };
    this.offerFoot(at.row.querySelector<HTMLElement>('.talk-offer')!, at.line);
    this.offersOpen();
  }

  /** While an offer waits for you the chat stays forward, so its thumbs can be seen. */
  private offersOpen(): void {
    this.panel.classList.toggle('offered', [...this.rows.values()].some((r) => r.line.offer?.state === 'open' && this.isMe(r.line.offer.to)));
  }

  add(line: TalkLine, live = true): void {
    if (this.seen.has(line.id)) return;
    this.seen.add(line.id);
    // your own words, back from the table: the copy already showing is firmed up
    const mine = line.human && line.player != null && this.isMe(line.player) ? this.pending.findIndex((p) => p.text === line.text) : -1;
    if (mine >= 0) {
      const [p] = this.pending.splice(mine, 1);
      p.row.classList.remove('sending');
      return;
    }
    const row = this.row(line);
    this.rows.set(line.id, { row, line });
    if (line.offer) this.offersOpen();
    const atEnd = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
    this.log.append(row);
    while (this.log.children.length > 60) this.log.firstElementChild!.remove();
    if (atEnd || !live) this.log.scrollTop = this.log.scrollHeight;
    if (!live) return;
    if (this.hidden) {
      this.unread++;
      this.label();
    }
    this.wake();
    if (line.player != null && !line.system) this.bubble(line.player, line.text);
  }

  deals(list: TalkDeal[]): void {
    this.dealsEl.replaceChildren(
      ...list.map((d) => {
        const el = h('div', 'talk-deal');
        el.append(h('span', '', d.summary), h('span', 'talk-left', d.left > 1 ? `${d.left} turns` : d.left === 1 ? '1 turn' : 'this turn'));
        return el;
      }),
    );
  }

  private bubble(player: number, text: string): void {
    let b = this.bubbles.get(player);
    if (!b) {
      b = { el: h('div', 'talk-bubble'), timer: 0 };
      this.bubbles.set(player, b);
      this.root.append(b.el);
    }
    clearTimeout(b.timer);
    b.el.textContent = text;
    b.el.classList.toggle('me', this.isMe(player));
    b.el.classList.remove('out', 'pop');
    void b.el.offsetWidth;
    b.el.classList.add('pop');
    // long enough to read: longer lines stay longer
    b.timer = window.setTimeout(() => {
      b!.el.classList.add('out');
      b!.timer = window.setTimeout(() => {
        b!.el.remove();
        this.bubbles.delete(player);
      }, 260);
    }, 3200 + text.length * 55);
    this.follow();
  }

  /** Keep each bubble at its speaker's badge (every frame): under a badge high on the screen, over a low one. */
  follow(): void {
    const taken: DOMRect[] = [];
    for (const [player, b] of this.bubbles) {
      const at = this.badge(player);
      b.el.style.visibility = at ? '' : 'hidden';
      if (!at) continue;
      const w = b.el.offsetWidth;
      const hgt = b.el.offsetHeight;
      const below = at.y < window.innerHeight / 2;
      const x = Math.max(12, Math.min(window.innerWidth - w - 12, at.x - w / 2));
      let y = below ? at.y + 54 : at.y - hgt - 54;
      for (const t of taken) if (x < t.right && x + w > t.left && y < t.bottom + 6 && y + hgt > t.top - 6) y = below ? t.bottom + 10 : t.top - hgt - 10;
      y = Math.max(8, Math.min(window.innerHeight - hgt - 8, y));
      b.el.classList.toggle('below', below);
      b.el.style.setProperty('--tail', `${Math.round(Math.max(16, Math.min(w - 16, at.x - x)))}px`);
      b.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      taken.push(new DOMRect(x, y, w, hgt));
    }
  }
}
