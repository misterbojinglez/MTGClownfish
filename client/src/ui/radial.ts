import { sfx } from '../audio';

/**
 * A radial menu of the prompt's actions around the pointer: hold Command (Mac) or Control (elsewhere), move
 * toward an action and click it. Letting go of the key closes it. Each action keeps its own slot (OK on top,
 * Pass Turn to the right, the secondary to the left, Undo below, the occasional extras on the diagonals) so
 * the hand learns where things are; ones that don't apply right now show dimmed, extras only when offered.
 */

export type RadialSlot = 'ok' | 'pass' | 'cancel' | 'undo' | 'all' | 'life' | 'floating';

export interface RadialAction {
  slot: RadialSlot;
  label: string;
  enabled: boolean;
  /** shown at all (the four main slots always are, dimmed when they don't apply) */
  visible: boolean;
  /** the move the game is waiting on: drawn in gold */
  primary?: boolean;
  run(): void;
}

/** each slot's direction, in degrees clockwise from straight up */
const ANGLE: Record<RadialSlot, number> = { ok: 0, all: 45, pass: 90, floating: 135, undo: 180, life: 225, cancel: 270 };
const RADIUS = 84;
/** within this distance of the centre nothing is picked */
const DEAD_ZONE = 24;

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  chevron: svg('<path d="M9 5l7 7-7 7"/>'),
  chevrons: svg('<path d="M5 5l7 7-7 7"/><path d="M12 5l7 7-7 7"/>'),
  none: svg('<circle cx="12" cy="12" r="7.5"/><path d="M6.7 17.3L17.3 6.7"/>'),
  cross: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>'),
  swords: svg('<path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6M16 16l4 4M19 21l2-2"/><path d="M9.5 6.5L13 3h3v3l-3.5 3.5"/><path d="M5 14l4 4M7 17l-3 3M3 19l2 2"/>'),
  recall: svg('<path d="M20 12H6"/><path d="M11 6l-6 6 6 6"/>'),
  heart: svg('<path d="M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z"/>'),
  drop: svg('<path d="M12 3s6 6.6 6 11a6 6 0 01-12 0c0-4.4 6-11 6-11z"/><path d="M9.5 14.5a2.5 2.5 0 002.5 2.5"/>'),
  layers: svg('<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>'),
  play: svg('<path d="M7 5l11 7-11 7V5z"/>'),
};

function iconFor(a: RadialAction): string {
  const l = a.label.toLowerCase();
  switch (a.slot) {
    case 'ok':
      if (/choose nothing/.test(l)) return ICONS.none;
      if (/pass priority|end turn/.test(l)) return ICONS.chevron;
      if (/attack|alpha/.test(l)) return ICONS.swords;
      if (/^play|keep/.test(l)) return ICONS.play;
      return ICONS.check;
    case 'pass': return ICONS.chevrons;
    case 'undo': return ICONS.undo;
    case 'all': return ICONS.layers;
    case 'life': return ICONS.heart;
    case 'floating': return ICONS.drop;
    case 'cancel':
      if (/alpha strike|attack/.test(l)) return ICONS.swords;
      if (/call back/.test(l)) return ICONS.recall;
      if (/^undo/.test(l)) return ICONS.undo;
      if (/pass priority|^ok$/.test(l)) return ICONS.chevron;
      return ICONS.cross;
  }
}

const IS_MAC = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
const HOTKEY = IS_MAC ? 'Meta' : 'Control';

export class RadialMenu {
  private readonly root = document.createElement('div');
  private readonly ring = document.createElement('div');
  private readonly sweep = document.createElement('div');
  private readonly hub = document.createElement('div');
  private readonly tip = document.createElement('div');
  private items: { action: RadialAction; el: HTMLButtonElement; angle: number }[] = [];
  private open = false;
  private hovered = -1;
  private cx = 0;
  private cy = 0;
  private px = window.innerWidth / 2;
  private py = window.innerHeight / 2;

  /** `actions` is asked each time the menu opens; `allowed` says whether it may open now (in a game, no dialog up) */
  constructor(private readonly actions: () => RadialAction[], private readonly allowed: () => boolean) {
    this.root.className = 'radial';
    this.ring.className = 'radial-ring';
    this.sweep.className = 'radial-sweep';
    this.hub.className = 'radial-hub';
    this.hub.innerHTML = `<span>${IS_MAC ? '⌘' : 'Ctrl'}</span>`;
    this.tip.className = 'radial-tip';
    this.ring.append(this.sweep, this.hub);
    this.root.append(this.ring, this.tip);
    document.body.append(this.root);

    window.addEventListener('pointermove', (e) => {
      this.px = e.clientX;
      this.py = e.clientY;
      if (this.open) this.track();
    }, { passive: true });
    window.addEventListener('keydown', (e) => {
      if (e.key === HOTKEY) {
        if (!e.repeat && !this.open) this.show();
      } else if (this.open) {
        // Cmd+Tab, Ctrl+C and friends: the key was held for something else
        this.hide();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === HOTKEY) this.hide();
    });
    window.addEventListener('blur', () => this.hide());
    document.addEventListener('visibilitychange', () => this.hide());
    // while open, a click anywhere picks the action pointed at, and never reaches the table underneath
    this.root.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.px = e.clientX;
      this.py = e.clientY;
      this.track();
      const it = this.items[this.hovered];
      if (it?.action.enabled) {
        sfx.click();
        this.hide();
        it.action.run();
      }
    });
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private show(): void {
    if (!this.allowed()) return;
    const actions = this.actions().filter((a) => a.visible);
    if (!actions.some((a) => a.enabled)) return;
    // keep the ring and its labels on screen
    const m = RADIUS + 40;
    this.cx = Math.min(Math.max(this.px, m), window.innerWidth - m);
    this.cy = Math.min(Math.max(this.py, m), window.innerHeight - m);
    this.ring.style.left = `${this.cx}px`;
    this.ring.style.top = `${this.cy}px`;
    for (const it of this.items) it.el.remove();
    this.items = actions.map((action, i) => {
      const el = document.createElement('button');
      const angle = ANGLE[action.slot];
      const rad = (angle * Math.PI) / 180;
      el.className = 'radial-item';
      el.classList.toggle('primary', !!action.primary && action.enabled);
      el.disabled = !action.enabled;
      el.tabIndex = -1;
      el.setAttribute('aria-label', action.label);
      el.innerHTML = iconFor(action);
      el.style.setProperty('--x', `${Math.sin(rad) * RADIUS}px`);
      el.style.setProperty('--y', `${-Math.cos(rad) * RADIUS}px`);
      el.style.setProperty('--i', String(i));
      this.ring.append(el);
      return { action, el, angle };
    });
    this.hovered = -1;
    this.open = true;
    this.root.classList.add('open');
    this.track();
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('open');
    this.tip.classList.remove('show');
  }

  /** pick the action in the direction of the pointer (anywhere past the dead zone, however far) */
  private track(): void {
    const dx = this.px - this.cx;
    const dy = this.py - this.cy;
    let best = -1;
    if (Math.hypot(dx, dy) > DEAD_ZONE) {
      const a = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
      let bestD = 361;
      this.items.forEach((it, i) => {
        const d = Math.abs(((a - it.angle + 540) % 360) - 180);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      // a slot owns at most the 60° around it, so an empty diagonal stays empty
      if (bestD > 30 && this.items.length > 1) best = -1;
    }
    if (best === this.hovered) return;
    this.hovered = best;
    this.items.forEach((it, i) => it.el.classList.toggle('hover', i === best));
    const it = this.items[best];
    this.sweep.classList.toggle('show', !!it);
    this.sweep.classList.toggle('dim', !!it && !it.action.enabled);
    if (!it) {
      this.tip.classList.remove('show');
      return;
    }
    if (it.action.enabled) sfx.hover();
    this.sweep.style.setProperty('--a', `${it.angle}deg`);
    const rad = (it.angle * Math.PI) / 180;
    const sx = Math.sin(rad);
    const sy = -Math.cos(rad);
    const r = RADIUS + 38;
    this.tip.textContent = it.action.enabled ? it.action.label : `${it.action.label} (not now)`;
    this.tip.style.left = `${this.cx + sx * r}px`;
    this.tip.style.top = `${this.cy + sy * r}px`;
    // grow away from the ring: rightward on the right, leftward on the left, centred above and below
    this.tip.style.transform = `translate(${-50 + sx * 50}%, ${-50 + sy * 50}%)`;
    this.tip.classList.toggle('show', true);
    this.tip.classList.toggle('dim', !it.action.enabled);
  }
}
