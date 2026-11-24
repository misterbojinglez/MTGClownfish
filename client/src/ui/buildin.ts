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

/** A yes/no question in the app's own dress (never the system's pop-up). */
export function askYes(root: HTMLElement, title: string, text: string, yes: string): Promise<boolean> {
  return new Promise((resolve) => {
    const el = (tag: 'div' | 'button', cls: string, t = ''): HTMLElement => {
      const x = document.createElement(tag);
      x.className = cls;
      x.textContent = t;
      return x;
    };
    const modal = el('div', 'modal deck-modal ask');
    const panel = el('div', 'modal-panel');
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-label', title);
    const done = (v: boolean) => {
      window.removeEventListener('keydown', onKey, true);
      modal.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      done(false);
    };
    const row = el('div', 'modal-buttons');
    const no = el('button', 'sub-btn wide', 'Cancel');
    no.onclick = () => done(false);
    const ok = el('button', 'main-btn wide', yes);
    ok.onclick = () => done(true);
    row.append(no, ok);
    panel.append(el('div', 'modal-title', title));
    if (text) panel.append(el('div', 'modal-sub', text));
    panel.append(row);
    modal.append(panel);
    modal.onclick = (e) => {
      if (e.target === modal) done(false);
    };
    window.addEventListener('keydown', onKey, true);
    root.append(modal);
    no.focus();
  });
}
