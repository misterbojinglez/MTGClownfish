import { sfx } from '../audio';

/**
 * "How many?" at the pointer, for a stack of identical creatures (Arena's number row): a button for each count
 * up to ten, or a stepper with All past that. Picking calls pick(n); Escape or a click elsewhere closes it with
 * nothing done.
 */

let lastClick = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
window.addEventListener('pointerdown', (e) => (lastClick = { x: e.clientX, y: e.clientY }), { capture: true, passive: true });

let open: (() => void) | null = null;

export function countPicker(title: string, max: number, pick: (n: number) => void): void {
  open?.();
  const root = document.createElement('div');
  root.className = 'count-picker';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', title);
  const head = document.createElement('div');
  head.className = 'count-title';
  head.textContent = title;
  const row = document.createElement('div');
  row.className = 'count-row';
  root.append(head, row);

  const close = () => {
    if (open !== close) return;
    open = null;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointerdown', onOutside, true);
    root.classList.remove('in');
    setTimeout(() => root.remove(), 140);
  };
  const choose = (n: number) => {
    sfx.click();
    close();
    pick(n);
  };
  const button = (label: string, n: number, cls = '') => {
    const b = document.createElement('button');
    b.className = `count-btn ${cls}`.trim();
    b.textContent = label;
    b.onclick = () => choose(n);
    return b;
  };

  if (max <= 10) {
    for (let n = 1; n <= max; n++) row.append(button(String(n), n, n === max ? 'all' : ''));
  } else {
    let n = max;
    const less = document.createElement('button');
    less.className = 'count-step';
    less.textContent = '−';
    less.setAttribute('aria-label', 'Fewer');
    const more = document.createElement('button');
    more.className = 'count-step';
    more.textContent = '+';
    more.setAttribute('aria-label', 'More');
    const go = button('', n);
    const show = () => {
      go.textContent = `Attack with ${n}`;
      go.onclick = () => choose(n);
      less.disabled = n <= 1;
      more.disabled = n >= max;
    };
    less.onclick = () => {
      n = Math.max(1, n - 1);
      show();
    };
    more.onclick = () => {
      n = Math.min(max, n + 1);
      show();
    };
    show();
    row.append(less, go, more, button(`All ${max}`, max, 'all'));
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close();
      return;
    }
    const d = Number(e.key);
    if (max <= 10 && Number.isInteger(d) && d >= 1 && d <= Math.min(max, 9)) {
      e.stopPropagation();
      choose(d);
    }
  };
  const onOutside = (e: PointerEvent) => {
    if (!root.contains(e.target as Node)) close();
  };
  window.addEventListener('keydown', onKey, true);
  // (after this click has finished, or it would close the picker it opened)
  setTimeout(() => window.addEventListener('pointerdown', onOutside, true), 0);

  document.body.append(root);
  const w = root.offsetWidth;
  const hgt = root.offsetHeight;
  root.style.left = `${Math.min(Math.max(lastClick.x - w / 2, 12), window.innerWidth - w - 12)}px`;
  root.style.top = `${Math.min(Math.max(lastClick.y - hgt - 18, 12), window.innerHeight - hgt - 12)}px`;
  requestAnimationFrame(() => root.classList.add('in'));
  open = close;
}
