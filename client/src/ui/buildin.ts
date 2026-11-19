/**
 * Build-ins and build-outs for the menus (theme.css "menu build-ins"), in the start screen's manner: pieces rise
 * into place one after another on arrival, and lift away together, quicker, on leaving.
 */

/** Each element rises into place in turn, `step` seconds apart after `start` (long lists stop staggering at `cap`). */
export function buildIn(els: Iterable<Element | null | undefined>, start = 0, step = 0.06, cap = 10): void {
  let i = 0;
  for (const el of els) {
    if (!(el instanceof HTMLElement)) continue;
    el.classList.add('bi');
    el.style.setProperty('--bi-delay', `${(start + Math.min(i, cap) * step).toFixed(3)}s`);
    // once landed the element is plain again, so later re-renders and hover transforms behave as before
    el.addEventListener('animationend', (e) => {
      if (e.target === el && e.animationName.startsWith('bi-')) el.classList.remove('bi');
    });
    i++;
  }
}

/** Lifts a menu away (its .leaving styles), then runs `done` once the build-out has played. */
export function buildOut(el: HTMLElement, done: () => void, ms = 220): void {
  if (el.classList.contains('leaving')) return;
  el.classList.add('leaving');
  setTimeout(done, ms);
}

/** A dialog leaves: it fades and drops while whatever opened it carries on underneath. */
export function closeModal(modal: HTMLElement): void {
  buildOut(modal, () => modal.remove(), 170);
}
