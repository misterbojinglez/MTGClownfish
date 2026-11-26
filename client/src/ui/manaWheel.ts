import { sfx } from '../audio';
import type { ChoiceOption } from '../protocol';

/**
 * The mana wheel: which mana a source makes (a dual land's two abilities, "one mana of any color"), picked on a
 * ring around the source like Arena's, rather than from a dialog. Point toward a choice and click, click it, or
 * press its colour's letter (W U B R G C) or its number. Escape, a right click or the hub backs out when that's
 * allowed (choosing which ability to activate); a colour asked for while the mana is being made can't be.
 */

const RADIUS = 78;
const DEAD_ZONE = 22;
const COLOUR_KEYS = ['W', 'U', 'B', 'R', 'G', 'C'];

/** where the last click on the page was, and when: a wheel asked for right after opens there */
let lastClick = { x: 0, y: 0, at: -Infinity };
window.addEventListener('pointerdown', (e) => (lastClick = { x: e.clientX, y: e.clientY, at: performance.now() }), { capture: true, passive: true });

function symbolImgs(symbols: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'mw-symbols';
  const list = [...symbols.matchAll(/\{([^{}]{1,5})\}/g)].map((m) => m[1]);
  wrap.dataset.n = String(Math.min(list.length, 5));
  for (const s of list) {
    const img = document.createElement('img');
    img.alt = `{${s}}`;
    img.src = `https://svgs.scryfall.io/card-symbols/${encodeURIComponent(s.replace(/\//g, '').toUpperCase())}.svg`;
    img.onerror = () => img.replaceWith(`{${s}}`);
    wrap.append(img);
  }
  if (!list.length) wrap.textContent = '✦';
  return wrap;
}

/** Text with its mana and tap symbols drawn as symbols ("{T}: Add {G}."). */
function setRichText(el: HTMLElement, text: string): void {
  const parts: (Node | string)[] = [];
  let at = 0;
  for (const m of text.matchAll(/\{([^{}\s]{1,5})\}/g)) {
    parts.push(text.slice(at, m.index));
    at = m.index + m[0].length;
    const img = document.createElement('img');
    img.className = 'sym';
    img.alt = m[0];
    img.src = `https://svgs.scryfall.io/card-symbols/${encodeURIComponent(m[1].replace(/\//g, '').toUpperCase())}.svg`;
    img.onerror = () => img.replaceWith(m[0]);
    parts.push(img);
  }
  el.replaceChildren(...parts, text.slice(at));
}

/** The single colour letter an option stands for, when it stands for exactly one. */
function colourKey(o: ChoiceOption): string | null {
  const list = [...(o.symbols ?? '').matchAll(/\{([WUBRGC])\}/g)].map((m) => m[1]);
  return list.length > 0 && new Set(list).size === 1 && !o.oneOf ? list[0] : null;
}

/**
 * Shows the wheel and answers the chosen option's index, or null when backed out of.
 * near: the source's place on screen, used when the wheel wasn't asked for right after a click.
 */
export function manaWheel(options: ChoiceOption[], opts: { cancellable: boolean; title: string; near: { x: number; y: number } | null }): Promise<number | null> {
  return new Promise((resolve) => {
    const recent = performance.now() - lastClick.at < 2500;
    const at = recent ? lastClick : opts.near ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const m = RADIUS + 96;
    const cx = Math.min(Math.max(at.x, m), window.innerWidth - m);
    const cy = Math.min(Math.max(at.y, m), window.innerHeight - m);

    const root = document.createElement('div');
    root.className = 'radial mana-wheel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', opts.title);
    const ring = document.createElement('div');
    ring.className = 'radial-ring';
    ring.style.left = `${cx}px`;
    ring.style.top = `${cy}px`;
    const sweep = document.createElement('div');
    sweep.className = 'radial-sweep';
    const hub = document.createElement('button');
    hub.className = 'radial-hub mw-hub';
    hub.tabIndex = -1;
    hub.innerHTML = opts.cancellable ? '<span aria-hidden="true">✕</span>' : '';
    hub.setAttribute('aria-label', opts.cancellable ? 'Cancel' : opts.title);
    const caption = document.createElement('div');
    caption.className = 'mw-caption';
    caption.textContent = opts.title;
    caption.style.left = `${cx}px`;
    caption.style.top = `${cy - RADIUS - 86}px`;
    const tip = document.createElement('div');
    tip.className = 'radial-tip';
    ring.append(sweep, hub);
    root.append(ring, caption, tip);
    document.body.append(root);

    const step = 360 / options.length;
    const items = options.map((o, i) => {
      const angle = i * step;
      const rad = (angle * Math.PI) / 180;
      const el = document.createElement('button');
      el.className = 'radial-item mw-item';
      el.tabIndex = -1;
      el.setAttribute('aria-label', o.label);
      el.append(symbolImgs(o.symbols ?? ''));
      el.style.setProperty('--x', `${Math.sin(rad) * RADIUS}px`);
      el.style.setProperty('--y', `${-Math.cos(rad) * RADIUS}px`);
      el.style.setProperty('--i', String(i));
      ring.append(el);
      return { el, angle, option: o };
    });

    let hovered = -1;
    let px = at.x;
    let py = at.y;
    const point = (i: number) => {
      if (i === hovered) return;
      hovered = i;
      items.forEach((it, j) => it.el.classList.toggle('hover', j === i));
      const it = items[i];
      sweep.classList.toggle('show', !!it);
      if (!it) {
        tip.classList.remove('show');
        return;
      }
      sfx.hover();
      sweep.style.setProperty('--a', `${it.angle}deg`);
      // a wedge as wide as the slot owns (all of it for two choices, capped so it still reads as a direction)
      sweep.style.setProperty('--w', `${Math.min(step, 90)}deg`);
      const rad = (it.angle * Math.PI) / 180;
      const sx = Math.sin(rad);
      const sy = -Math.cos(rad);
      const r = RADIUS + 38;
      setRichText(tip, it.option.label);
      tip.style.left = `${cx + sx * r}px`;
      tip.style.top = `${cy + sy * r}px`;
      tip.style.transform = `translate(${-50 + sx * 50}%, ${-50 + sy * 50}%)`;
      tip.classList.add('show');
    };
    const track = () => {
      const dx = px - cx;
      const dy = py - cy;
      if (Math.hypot(dx, dy) <= DEAD_ZONE) return point(-1);
      const a = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
      let best = -1;
      let bestD = 361;
      items.forEach((it, i) => {
        const d = Math.abs(((a - it.angle + 540) % 360) - 180);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      point(best);
    };

    let finished = false;
    const finish = (value: number | null) => {
      if (finished) return;
      finished = true;
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointermove', onMove);
      root.classList.remove('open');
      setTimeout(() => root.remove(), 180);
      resolve(value);
    };
    const pick = (i: number) => {
      if (i < 0 || i >= items.length) return;
      sfx.click();
      finish(i);
    };
    const back = () => {
      if (opts.cancellable) finish(null);
    };

    const onMove = (e: PointerEvent) => {
      px = e.clientX;
      py = e.clientY;
      track();
    };
    const onKey = (e: KeyboardEvent) => {
      // the wheel has the keyboard while it's up: nothing reaches the game's shortcuts underneath
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        back();
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && hovered >= 0) {
        e.preventDefault();
        pick(hovered);
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= items.length) {
        pick(n - 1);
        return;
      }
      const letter = e.key.toUpperCase();
      if (COLOUR_KEYS.includes(letter)) {
        const i = items.findIndex((it) => colourKey(it.option) === letter);
        if (i >= 0) pick(i);
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointermove', onMove, { passive: true });

    root.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.button === 2) return back();
      px = e.clientX;
      py = e.clientY;
      if ((e.target as HTMLElement).closest('.mw-hub')) return back();
      const direct = items.findIndex((it) => it.el.contains(e.target as Node));
      if (direct >= 0) return pick(direct);
      track();
      if (hovered >= 0) pick(hovered);
      else back();
    });
    root.addEventListener('contextmenu', (e) => e.preventDefault());

    requestAnimationFrame(() => {
      root.classList.add('open');
      track();
    });
  });
}
