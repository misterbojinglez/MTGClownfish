/**
 * The tutorial tour: a few cards walking through the table, shown once at the start of your first game and
 * again whenever it's opened from the start screen. In a game each card lights the part of the screen it talks
 * about; where that part isn't on screen (the start screen, or the camera bar in a duel, which has a fixed
 * camera) the card shows a small picture of it instead.
 */

const SEEN_KEY = 'tabletop.tourSeen';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** A spot on screen: an element (when it's showing), or a rectangle worked out from the window. */
type Target = () => DOMRect | null;

interface Step {
  title: string;
  /** paragraphs; <b> allowed (fixed copy, never player input) */
  body: string[];
  target?: Target;
  /** drawn in place of the spotlight when the target isn't on screen */
  picture?: () => HTMLElement;
}

const visible = (sel: string): Target => () => {
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4 || getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).display === 'none') return null;
  return r;
};

/** your hand: the band across the bottom middle of the screen (it's drawn in 3D, so there's no element) */
const handArea: Target = () => {
  if (!document.body.classList.contains('in-game')) return null;
  const w = window.innerWidth;
  const hgt = window.innerHeight;
  const width = Math.min(w * 0.76, 1320);
  return new DOMRect((w - width) / 2, hgt * 0.74, width, hgt * 0.26 - 6);
};

function cameraPicture(): HTMLElement {
  const p = h('div', 'tour-pic tour-pic-cams');
  for (const [label, on] of [['Table', true], ['You', false], ['Rook', false], ['Wren', false], ['Auto', true]] as const) {
    const b = h('span', `view-btn${on ? ' on' : ''}${label === 'Auto' ? ' auto' : ''}`, label);
    p.append(b);
  }
  return p;
}

function controlsPicture(): HTMLElement {
  const p = h('div', 'tour-pic tour-pic-controls');
  p.append(h('span', 'main-btn pass-btn', 'Pass Turn'), h('span', 'main-btn', 'OK'));
  return p;
}

function handPicture(): HTMLElement {
  const p = h('div', 'tour-pic tour-pic-hand');
  const fan = h('div', 'tour-fan');
  for (let i = 0; i < 5; i++) {
    const c = h('span', 'tour-card');
    c.style.setProperty('--i', String(i - 2));
    fan.append(c);
  }
  const decks = h('div', 'tour-decks');
  decks.append(h('span', 'tour-deck', 'Paste from Moxfield'), h('span', 'tour-deck', 'Precon'));
  p.append(fan, decks);
  return p;
}

const STEPS: Step[] = [
  {
    title: 'Welcome to the table',
    body: [
      'A quick look at the camera, the buttons that move the game along, and your hand. It takes under a minute.',
      'You can open this tour again any time from <b>Tutorial</b> on the start screen.',
    ],
  },
  {
    title: 'The cameras',
    body: [
      '<b>Auto</b> follows the game for you: it zooms in on whoever is taking their turn, both sides of a combat, and whatever you’re asked to pick.',
      '<b>Table</b> pulls back to the whole table. A player’s name (or <b>You</b>) zooms in on that seat. The number keys and the mouse wheel do the same.',
      'Mix the two: leave Auto on and look around whenever you like. Your view holds until the next turn begins, then Auto picks up again. With four players at the table the bar sits at the top left; a duel keeps one fixed view.',
    ],
    target: visible('.view-bar.show'),
    picture: cameraPicture,
  },
  {
    title: 'Moving the game along',
    body: [
      'The buttons at the bottom right answer whatever the game asks. When you have priority, the main button <b>passes priority</b>: for the current step, or for the spell or ability on top of the Stack so it resolves.',
      '<b>Pass Turn</b> yields the rest of the turn. You’re asked again only if something new enters the Stack.',
    ],
    target: visible('.prompt .action-column'),
    picture: controlsPicture,
  },
  {
    title: 'Your hand and your deck',
    body: [
      'Your hand sits along the bottom. Hover a card to read it, and click or drag it to play it.',
      'Before each game, the deck selector takes <b>any deck pasted from Moxfield</b> (Export → Copy for MTGA), or you can just grab a precon and go.',
    ],
    target: handArea,
    picture: handPicture,
  },
];

let open: (() => void) | null = null;

/** Whether the first-game tour has been seen (finished or skipped) on this device. */
export function tourSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* ignore */
  }
}

/** Show the tour (from the first card). */
export function startTour(root: HTMLElement): void {
  if (open) return;
  let index = 0;
  const layer = h('div', 'tour');
  const spot = h('div', 'tour-spot');
  const scrim = h('div', 'tour-scrim');
  const card = h('div', 'tour-card-panel');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-live', 'polite');
  layer.append(scrim, spot, card);
  root.append(layer);
  let raf = 0;
  let shownTarget: DOMRect | null = null;

  const close = () => {
    markSeen();
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey, true);
    layer.classList.add('out');
    setTimeout(() => layer.remove(), 200);
    open = null;
  };

  const go = (i: number) => {
    if (i >= STEPS.length) return close();
    index = Math.max(0, i);
    render();
  };

  const render = () => {
    const step = STEPS[index];
    const rect = step.target?.() ?? null;
    shownTarget = rect;
    card.replaceChildren();
    card.append(h('div', 'tour-count', `${index + 1} of ${STEPS.length}`), h('div', 'tour-title', step.title));
    card.setAttribute('aria-label', step.title);
    if (!rect && step.picture) card.append(step.picture());
    for (const para of step.body) {
      const p = h('p', 'tour-text');
      p.innerHTML = para;
      card.append(p);
    }
    const dots = h('div', 'tour-dots');
    STEPS.forEach((_, i) => dots.append(h('span', `tour-dot${i === index ? ' on' : ''}`)));
    const row = h('div', 'tour-buttons');
    const skip = h('button', 'tour-skip', index === STEPS.length - 1 ? '' : 'Skip tour');
    skip.onclick = close;
    if (index === STEPS.length - 1) skip.style.visibility = 'hidden';
    const back = h('button', 'sub-btn', 'Back');
    back.disabled = index === 0;
    back.onclick = () => go(index - 1);
    const next = h('button', 'main-btn', index === STEPS.length - 1 ? 'Got it' : 'Next');
    next.onclick = () => go(index + 1);
    row.append(skip, dots, back, next);
    card.append(row);
    layer.classList.toggle('lit', !!rect);
    place(rect);
    next.focus({ preventScroll: true });
  };

  /** The spotlight on the target, and the card beside it (above, else to the left, else centred). */
  const place = (rect: DOMRect | null) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const gap = 18;
    if (!rect) {
      card.style.left = `${Math.max(16, (vw - cw) / 2)}px`;
      card.style.top = `${Math.max(16, (vh - ch) / 2)}px`;
      return;
    }
    const pad = 8;
    spot.style.left = `${rect.left - pad}px`;
    spot.style.top = `${rect.top - pad}px`;
    spot.style.width = `${rect.width + pad * 2}px`;
    spot.style.height = `${rect.height + pad * 2}px`;
    const clampX = (x: number) => Math.max(16, Math.min(vw - cw - 16, x));
    const clampY = (y: number) => Math.max(16, Math.min(vh - ch - 16, y));
    let x: number;
    let y: number;
    if (rect.top - pad - gap - ch >= 16) {
      // above
      x = clampX(rect.left + rect.width / 2 - cw / 2);
      y = rect.top - pad - gap - ch;
    } else if (rect.bottom + pad + gap + ch <= vh - 16) {
      // below
      x = clampX(rect.left + rect.width / 2 - cw / 2);
      y = rect.bottom + pad + gap;
    } else if (rect.left - pad - gap - cw >= 16) {
      // left
      x = rect.left - pad - gap - cw;
      y = clampY(rect.top + rect.height / 2 - ch / 2);
    } else {
      x = clampX(rect.right + pad + gap);
      y = clampY(rect.top + rect.height / 2 - ch / 2);
    }
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  };

  // targets move (the HUD re-lays out, the window resizes): follow them, and re-draw if one appears or goes
  const follow = () => {
    const step = STEPS[index];
    const rect = step.target?.() ?? null;
    if (!!rect !== !!shownTarget) render();
    else if (rect && shownTarget && (Math.abs(rect.left - shownTarget.left) > 1 || Math.abs(rect.top - shownTarget.top) > 1 || Math.abs(rect.width - shownTarget.width) > 1)) {
      shownTarget = rect;
      place(rect);
    } else if (!rect) place(null);
    raf = requestAnimationFrame(follow);
  };

  const onKey = (e: KeyboardEvent) => {
    const keys = ['Escape', 'ArrowRight', 'ArrowLeft', 'Enter'];
    if (!keys.includes(e.key)) return;
    // the tour owns the keyboard while it's up (Enter would otherwise press the game's OK)
    e.stopPropagation();
    e.preventDefault();
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(index - 1);
    else if (e.key === 'ArrowRight') go(index + 1);
    else if (e.key === 'Enter') {
      const focused = document.activeElement as HTMLElement | null;
      if (focused && card.contains(focused) && focused.tagName === 'BUTTON') focused.click();
      else go(index + 1);
    }
  };
  window.addEventListener('keydown', onKey, true);
  open = close;
  render();
  raf = requestAnimationFrame(follow);
}

/**
 * The first game on this device: the tour, once your opening hand is on the table (so the hand step has
 * cards to point at) and they've had a moment to land. ready: whether the hand is dealt.
 */
export function maybeFirstGameTour(root: HTMLElement, ready: () => boolean): void {
  if (tourSeen() || open) return;
  const started = performance.now();
  const check = () => {
    if (!document.body.classList.contains('in-game') || tourSeen() || open) return;
    // (after a minute without a hand, go ahead anyway)
    if (!ready() && performance.now() - started < 60000) {
      setTimeout(check, 500);
      return;
    }
    setTimeout(() => {
      if (document.body.classList.contains('in-game') && !tourSeen()) startTour(root);
    }, 1400);
  };
  setTimeout(check, 1000);
}

/** Close the tour if it's up (leaving the game). */
export function closeTour(): void {
  open?.();
}
