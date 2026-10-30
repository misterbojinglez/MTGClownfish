import type { CardState, ChoiceOption, GameState, PlayerState, Prompt, RequestMsg, Selection } from '../protocol';
import { cardImageUrl, cardZoomUrl } from '../scene/textures';

const PHASES: [string, string][] = [
  ['UNTAP', 'Untap'],
  ['UPKEEP', 'Upkeep'],
  ['DRAW', 'Draw'],
  ['MAIN1', 'Main 1'],
  ['COMBAT_BEGIN', 'Combat'],
  ['COMBAT_DECLARE_ATTACKERS', 'Attack'],
  ['COMBAT_DECLARE_BLOCKERS', 'Block'],
  ['COMBAT_DAMAGE', 'Damage'],
  ['COMBAT_END', 'End Combat'],
  ['MAIN2', 'Main 2'],
  ['END_OF_TURN', 'End'],
  ['CLEANUP', 'Cleanup'],
];

const PHASE_GROUPS = ['UPKEEP', 'DRAW', 'MAIN1', 'COMBAT_DECLARE_ATTACKERS', 'COMBAT_DECLARE_BLOCKERS', 'COMBAT_DAMAGE', 'MAIN2', 'END_OF_TURN'];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

export interface HudHandlers {
  ok(): void;
  cancel(): void;
  player(id: number): void;
  passTurn(): void;
  concede(): void;
}

export class Hud {
  private readonly root = document.getElementById('hud')!;
  private readonly promptBox = h('div', 'prompt');
  private readonly promptText = h('div', 'prompt-text');
  private readonly okBtn = h('button', 'main-btn');
  private readonly cancelBtn = h('button', 'sub-btn');
  private readonly phaseBar = h('div', 'phase-bar');
  private readonly turnLabel = h('div', 'turn-label');
  private readonly zoom = h('div', 'zoom');
  private readonly zoomImg = h('img');
  private readonly zoomText = h('div', 'zoom-text');
  private readonly plates = new Map<number, HTMLDivElement>();
  private readonly toasts = h('div', 'toasts');
  private readonly status = h('div', 'status');
  private zoomFor = -1;
  private handlers!: HudHandlers;

  constructor() {
    const actions = h('div', 'actions');
    actions.append(this.cancelBtn, this.okBtn);
    this.promptBox.append(this.promptText, actions);
    const phaseWrap = h('div', 'phase-wrap');
    phaseWrap.append(this.turnLabel, this.phaseBar);
    for (const key of PHASE_GROUPS) {
      const label = PHASES.find(([k]) => k === key)![1];
      const pip = h('div', 'phase', label);
      pip.dataset.phase = key;
      this.phaseBar.append(pip);
    }
    this.zoom.append(this.zoomImg, this.zoomText);
    this.root.append(this.promptBox, phaseWrap, this.zoom, this.toasts, this.status);
    this.okBtn.onclick = () => this.handlers.ok();
    this.cancelBtn.onclick = () => this.handlers.cancel();

    const menu = h('div', 'corner-menu');
    const pass = h('button', 'chip', 'Pass turn');
    pass.title = 'Pass priority until end of turn (Shift+Enter)';
    pass.onclick = () => this.handlers.passTurn();
    const concede = h('button', 'chip danger', 'Concede');
    concede.onclick = () => confirm('Concede this game?') && this.handlers.concede();
    menu.append(pass, concede);
    this.root.append(menu);

    window.addEventListener('keydown', (e) => {
      if (document.querySelector('.modal')) return;
      if ((e.key === ' ' || e.key === 'Enter') && e.shiftKey) {
        e.preventDefault();
        this.handlers.passTurn();
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (!this.okBtn.disabled) this.handlers.ok();
      } else if (e.key === 'Escape' || e.key === 'z') {
        if (!this.cancelBtn.disabled) this.handlers.cancel();
      }
    });
  }

  bind(handlers: HudHandlers): void {
    this.handlers = handlers;
  }

  setConnection(connected: boolean): void {
    this.status.textContent = connected ? '' : 'Connecting to the rules engine…';
    this.status.classList.toggle('show', !connected);
  }

  // ---- menu / game over -------------------------------------------------------------------------

  menu(onStart: (format: 'constructed' | 'commander', players: number) => void): void {
    this.closeOverlay();
    const ov = h('div', 'overlay menu');
    ov.append(h('h1', '', 'MTG Tabletop'), h('p', 'sub', 'Play against Forge AI opponents'));
    const opts: [string, string, 'constructed' | 'commander', number][] = [
      ['Duel', '1 v 1 with random preconstructed decks', 'constructed', 2],
      ['Commander', '4-player free-for-all with commander precons', 'commander', 4],
      ['Commander duel', '1 v 1 commander', 'commander', 2],
    ];
    const row = h('div', 'menu-row');
    for (const [title, desc, format, players] of opts) {
      const b = h('button', 'menu-card');
      b.append(h('div', 'menu-title', title), h('div', 'menu-desc', desc));
      b.onclick = () => {
        this.closeOverlay();
        onStart(format, players);
      };
      row.append(b);
    }
    ov.append(row);
    this.root.append(ov);
  }

  loading(text: string): void {
    this.closeOverlay();
    const ov = h('div', 'overlay loading');
    ov.append(h('div', 'spinner'), h('p', '', text));
    this.root.append(ov);
  }

  closeOverlay(): void {
    this.root.querySelectorAll('.overlay').forEach((e) => e.remove());
  }

  gameOver(won: boolean, winner: string | null, onAgain: () => void): void {
    this.closeOverlay();
    const ov = h('div', `overlay gameover ${won ? 'won' : 'lost'}`);
    ov.append(h('h1', '', won ? 'Victory' : 'Defeat'), h('p', 'sub', winner ? `${winner} wins` : 'Draw'));
    const again = h('button', 'main-btn wide', 'Play again');
    again.onclick = onAgain;
    ov.append(again);
    this.root.append(ov);
  }

  // ---- prompt -------------------------------------------------------------------------------------

  setPrompt(prompt: Prompt, sel: Selection, waiting: boolean): void {
    let msg = prompt.message ?? '';
    if (sel.cards.length && sel.max > 0) {
      const picked = sel.chosen.length;
      msg += sel.max > 1 ? `\n(${picked}/${sel.max} selected)` : '';
    }
    if (sel.targets.some((t) => t?.player !== undefined)) msg += '\n(Click a player\'s portrait or their side of the table)';
    this.promptText.textContent = msg;
    const ok = prompt.ok;
    const cancel = prompt.cancel;
    this.okBtn.textContent = ok?.label || 'OK';
    this.okBtn.disabled = !ok?.enabled || waiting;
    this.okBtn.classList.toggle('glow', !!ok?.enabled && !waiting);
    this.okBtn.classList.toggle('end-turn', /end turn|pass/i.test(ok?.label ?? '') || /^OK$/i.test(ok?.label ?? ''));
    this.cancelBtn.textContent = cancel?.label || 'Cancel';
    this.cancelBtn.style.visibility = cancel?.enabled && !waiting ? 'visible' : 'hidden';
    this.cancelBtn.disabled = !cancel?.enabled || waiting;
    this.promptBox.classList.toggle('waiting', waiting);
  }

  setPhase(state: GameState, localId: number): void {
    const active = state.players.find((p) => p.id === state.activePlayer);
    this.turnLabel.textContent = active ? `Turn ${state.turn} · ${active.id === localId ? 'Your turn' : active.name}` : '';
    this.turnLabel.classList.toggle('mine', active?.id === localId);
    const phase = state.phase ?? '';
    const group =
      phase === 'COMBAT_BEGIN' ? 'COMBAT_DECLARE_ATTACKERS'
      : phase === 'COMBAT_FIRST_STRIKE_DAMAGE' ? 'COMBAT_DAMAGE'
      : phase === 'COMBAT_END' ? 'COMBAT_DAMAGE'
      : phase === 'CLEANUP' ? 'END_OF_TURN'
      : phase === 'UNTAP' ? 'UPKEEP'
      : phase;
    this.phaseBar.querySelectorAll<HTMLDivElement>('.phase').forEach((p) => p.classList.toggle('on', p.dataset.phase === group));
  }

  // ---- player plates ------------------------------------------------------------------------------

  updatePlayers(state: GameState, localId: number, screen: Map<number, { x: number; y: number }>, targetable: Set<number>): void {
    for (const p of state.players) {
      let plate = this.plates.get(p.id);
      if (!plate) {
        plate = this.buildPlate(p);
        this.plates.set(p.id, plate);
        this.root.append(plate);
      }
      const pos = screen.get(p.id);
      if (pos) {
        plate.style.left = `${pos.x}px`;
        plate.style.top = `${pos.y}px`;
      }
      plate.classList.toggle('local', p.id === localId);
      plate.classList.toggle('active', p.id === state.activePlayer);
      plate.classList.toggle('priority', p.priority);
      plate.classList.toggle('lost', p.lost);
      plate.classList.toggle('targetable', targetable.has(p.id));
      const lifeEl = plate.querySelector<HTMLDivElement>('.life')!;
      if (lifeEl.textContent !== String(p.life)) {
        const prev = Number(lifeEl.textContent);
        lifeEl.textContent = String(p.life);
        if (!Number.isNaN(prev) && lifeEl.dataset.init) {
          lifeEl.classList.remove('hurt', 'heal');
          void lifeEl.offsetWidth;
          lifeEl.classList.add(p.life < prev ? 'hurt' : 'heal');
        }
        lifeEl.dataset.init = '1';
      }
      plate.querySelector('.counts')!.textContent = `✋ ${p.zones.Hand.length}   ▤ ${p.zones.LibraryCount}`;
      const extras: string[] = [];
      if (p.poison > 0) extras.push(`☠ ${p.poison}`);
      if (p.commanderDamage) {
        for (const [cid, dmg] of Object.entries(p.commanderDamage)) {
          const name = state.cards[cid]?.name ?? 'Commander';
          extras.push(`⚔ ${dmg} from ${name}`);
        }
      }
      plate.querySelector('.extras')!.textContent = extras.join(' · ');
      const mana = plate.querySelector<HTMLDivElement>('.mana')!;
      mana.innerHTML = '';
      for (const [color, n] of Object.entries(p.mana)) {
        const pip = h('span', `pip pip-${color}`, String(n));
        mana.append(pip);
      }
    }
  }

  private buildPlate(p: PlayerState): HTMLDivElement {
    const plate = h('div', 'plate');
    const portrait = h('div', 'portrait');
    portrait.textContent = p.name.slice(0, 1).toUpperCase();
    portrait.style.setProperty('--hue', String((p.id * 97) % 360));
    const info = h('div', 'plate-info');
    info.append(h('div', 'pname', p.name), h('div', 'counts'), h('div', 'extras'), h('div', 'mana'));
    plate.append(portrait, h('div', 'life'), info);
    plate.onclick = () => this.handlers.player(p.id);
    return plate;
  }

  plateRect(playerId: number): DOMRect | null {
    return this.plates.get(playerId)?.getBoundingClientRect() ?? null;
  }

  resetPlayers(): void {
    this.plates.forEach((p) => p.remove());
    this.plates.clear();
  }

  // ---- zoom ---------------------------------------------------------------------------------------

  showZoom(card: CardState | null, side: 'left' | 'right' = 'left'): void {
    if (!card || !card.visible) {
      this.zoom.classList.remove('show');
      this.zoomFor = -1;
      return;
    }
    this.zoom.classList.toggle('right', side === 'right');
    if (this.zoomFor === card.id) {
      this.zoom.classList.add('show');
      return;
    }
    this.zoomFor = card.id;
    this.zoomText.textContent = '';
    this.zoomImg.removeAttribute('src');
    this.zoom.classList.add('show');
    const id = card.id;
    cardZoomUrl(card).then((url) => {
      if (this.zoomFor !== id) return;
      if (url) this.zoomImg.src = url;
      else this.zoomText.textContent = `${card.name}\n${card.typeLine ?? ''}\n\n${card.text ?? ''}`;
    });
  }

  // ---- card browser -------------------------------------------------------------------------------

  private browser: HTMLDivElement | null = null;
  private browserKey = '';

  /**
   * Arena-style browser for selections over cards that aren't on the table (searching a library,
   * looking at a hand). Clicking a card toggles it through the normal card action; the prompt's
   * OK / Cancel buttons finish the selection.
   */
  setBrowser(cards: CardState[] | null, chosen: Set<number>, title: string, onPick: (id: number) => void): void {
    if (!cards || cards.length === 0) {
      this.browser?.remove();
      this.browser = null;
      this.browserKey = '';
      return;
    }
    const key = cards.map((c) => c.id).join(',');
    if (!this.browser || key !== this.browserKey) {
      this.browser?.remove();
      this.browserKey = key;
      const ov = h('div', 'browser');
      const head = h('div', 'browser-title');
      const row = h('div', cards.length > 8 ? 'browser-cards many' : 'browser-cards');
      for (const c of cards) {
        const thumb = this.cardThumb(c);
        thumb.dataset.id = String(c.id);
        thumb.onclick = () => onPick(c.id);
        row.append(thumb);
      }
      ov.append(head, row);
      this.root.append(ov);
      this.browser = ov;
    }
    this.browser.querySelector('.browser-title')!.textContent = title;
    this.browser.querySelectorAll<HTMLElement>('.thumb').forEach((el) => el.classList.toggle('picked', chosen.has(Number(el.dataset.id))));
  }

  // ---- opponent cast reveal ------------------------------------------------------------------------

  /**
   * An opponent's spell shown big before play moves on. Resolves after `ms` (held while hovered);
   * a click or Space ends it early.
   */
  revealCast(card: CardState, caption: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const el = h('div', 'cast-reveal');
      const img = h('img');
      const fallback = h('div', 'thumb-fallback', `${card.name ?? ''}\n${card.typeLine ?? ''}\n\n${card.text ?? ''}`);
      el.append(h('div', 'cast-caption', caption), img);
      cardImageUrl(card).then((url) => (url ? (img.src = url) : el.append(fallback)));
      this.root.append(el);
      let hovered = false;
      let elapsed = 0;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        window.removeEventListener('keydown', onKey, true);
        el.classList.add('out');
        setTimeout(() => el.remove(), 220);
        resolve();
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === ' ' || e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation(); // don't also press the prompt's OK
          finish();
        }
      };
      const timer = window.setInterval(() => {
        if (!hovered) elapsed += 100;
        if (elapsed >= ms) finish();
      }, 100);
      el.onmouseenter = () => (hovered = true);
      el.onmouseleave = () => (hovered = false);
      el.onclick = finish;
      window.addEventListener('keydown', onKey, true);
    });
  }

  // ---- toasts -------------------------------------------------------------------------------------

  toast(text: string, kind = ''): void {
    const t = h('div', `toast ${kind}`, text);
    this.toasts.append(t);
    setTimeout(() => t.classList.add('out'), 3200);
    setTimeout(() => t.remove(), 3800);
  }

  // ---- requests -----------------------------------------------------------------------------------

  request(req: RequestMsg, state: GameState | null): Promise<unknown> {
    return new Promise((resolve) => {
      const modal = h('div', 'modal');
      const panel = h('div', 'modal-panel');
      modal.append(panel);
      const title = h('div', 'modal-title', req.message ?? '');
      panel.append(title);
      if (req.caption && req.caption !== req.message) panel.append(h('div', 'modal-sub', req.caption));
      const done = (value: unknown) => {
        modal.classList.add('out');
        setTimeout(() => modal.remove(), 160);
        resolve(value);
      };

      if (req.kind === 'confirm') {
        const row = h('div', 'modal-buttons');
        if (req.card != null && state?.cards[req.card]) panel.append(this.cardThumb(state.cards[req.card]));
        (req.buttons ?? ['Yes', 'No']).forEach((label, i) => {
          const b = h('button', i === 0 ? 'main-btn wide' : 'sub-btn wide', label);
          b.onclick = () => done(i);
          row.append(b);
        });
        panel.append(row);
      } else if (req.kind === 'distribute') {
        this.buildDistribute(req, state, panel, done);
      } else if (req.kind === 'input') {
        const input = h('input', 'modal-input');
        input.type = req.numeric ? 'number' : 'text';
        input.value = req.initial ?? '';
        const b = h('button', 'main-btn wide', 'OK');
        b.onclick = () => done(input.value);
        input.onkeydown = (e) => e.key === 'Enter' && done(input.value);
        panel.append(input, b);
        setTimeout(() => input.focus(), 50);
      } else {
        this.buildChoice(req, state, panel, done);
      }
      this.root.append(modal);
    });
  }

  private buildChoice(req: RequestMsg, state: GameState | null, panel: HTMLElement, done: (v: unknown) => void): void {
    const options = req.options ?? [];
    const reveal = req.kind === 'reveal';
    const ordering = req.kind === 'order';
    const n = options.length;
    let min = req.min ?? 1;
    let max = req.max ?? 1;
    if (ordering) {
      // Forge passes how many may stay behind; a negative bound means "no limit" (e.g. scry: any number
      // to the bottom), while 0/0 means every option must be placed in order
      const minRem = req.minRemaining ?? 0;
      const maxRem = req.maxRemaining ?? 0;
      max = minRem >= 0 ? n - minRem : n;
      min = maxRem >= 0 ? n - maxRem : 0;
      if (minRem === 0 && maxRem === 0) min = max = n;
    }
    const picked: number[] = [];
    const cardOf = (o: ChoiceOption): CardState | undefined => (o.card != null ? state?.cards[o.card] ?? o.cardData : undefined);
    const hasCards = options.some((o) => cardOf(o)?.visible);
    const list = h('div', hasCards ? 'choice-cards' : 'choice-list');
    if (hasCards && n > 8) list.classList.add('many');
    const items: HTMLElement[] = [];
    const confirm = h('button', 'main-btn wide', reveal ? 'OK' : 'Confirm');

    const refresh = () => {
      items.forEach((el, i) => {
        const at = picked.indexOf(i);
        el.classList.toggle('picked', at >= 0);
        const badge = el.querySelector('.order-badge');
        if (badge) badge.textContent = ordering && at >= 0 ? String(at + 1) : '';
      });
      confirm.disabled = !reveal && (picked.length < min || picked.length > max);
      if (!reveal && max > 1) confirm.textContent = `Confirm (${picked.length}${max < n ? '/' + max : ''})`;
    };

    options.forEach((o: ChoiceOption, i) => {
      const card = cardOf(o);
      let el: HTMLElement;
      if (hasCards && card?.visible) {
        el = this.cardThumb(card);
        if (o.ability != null || (o.label && o.label !== card.name)) el.append(h('div', 'thumb-label', o.label));
      } else {
        el = h('button', 'choice-item', o.label);
      }
      el.append(h('span', 'order-badge'));
      if (!reveal) {
        el.onclick = () => {
          const at = picked.indexOf(i);
          if (at >= 0) picked.splice(at, 1);
          else {
            if (max === 1) picked.length = 0;
            if (picked.length < max) picked.push(i);
          }
          refresh();
          // single picks with no minimum ambiguity resolve immediately
          if (max === 1 && min === 1 && picked.length === 1 && !hasCards) done([...picked]);
        };
        // double-clicking a card takes it and confirms, when that alone is a complete answer
        el.ondblclick = () => {
          if (max === 1 && picked.length === 1 && picked[0] === i) done([i]);
        };
      }
      items.push(el);
      list.append(el);
    });
    panel.append(list);

    const row = h('div', 'modal-buttons');
    if (!reveal && min === 0 && max >= 1) {
      const skip = h('button', 'sub-btn wide', 'None');
      skip.onclick = () => done([]);
      row.append(skip);
    }
    if (ordering && min === n) {
      const all = h('button', 'sub-btn wide', 'Keep this order');
      all.onclick = () => done(options.map((_, i) => i));
      row.append(all);
    }
    confirm.onclick = () => done(reveal ? [] : [...picked]);
    row.append(confirm);
    panel.append(row);
    refresh();
  }

  /** Split an amount among targets: +/− per row, confirm once the whole amount is placed. */
  private buildDistribute(req: RequestMsg, state: GameState | null, panel: HTMLElement, done: (v: unknown) => void): void {
    const options = req.options ?? [];
    const total = req.amount ?? 0;
    const min: number = req.atLeastOne ? 1 : 0;
    const shares: number[] = options.map(() => min);
    // start with an even split so the common case is one click
    let left = total - shares.reduce((a, b) => a + b, 0);
    for (let i = 0; left > 0 && options.length; i = (i + 1) % options.length) {
      if (shares[i] < (options[i].max ?? total)) {
        shares[i]++;
        left--;
      } else if (shares.every((v, j) => v >= (options[j].max ?? total))) break;
    }
    const list = h('div', 'distribute');
    const remaining = h('div', 'modal-sub');
    const confirm = h('button', 'main-btn wide', 'Confirm');
    const rows: HTMLElement[] = [];
    const refresh = () => {
      const used = shares.reduce((a, b) => a + b, 0);
      remaining.textContent = used === total ? 'All assigned' : `${total - used} left to assign`;
      confirm.disabled = used !== total;
      rows.forEach((r, i) => (r.querySelector('.share')!.textContent = String(shares[i])));
    };
    options.forEach((o, i) => {
      const card = o.card != null ? state?.cards[o.card] ?? o.cardData : undefined;
      const player = o.player != null ? state?.players.find((p) => p.id === o.player) : undefined;
      const row = h('div', 'dist-row');
      const label = h('div', 'dist-label', player ? `${player.name} (${player.life} life)` : card?.name ?? o.label);
      if (o.color) label.classList.add(`pip-${o.color}`, 'dist-color');
      const minus = h('button', 'sub-btn', '−');
      const plus = h('button', 'sub-btn', '+');
      minus.onclick = () => {
        if (shares[i] > min) shares[i]--;
        refresh();
      };
      plus.onclick = () => {
        if (shares.reduce((a, b) => a + b, 0) < total && shares[i] < (o.max ?? total)) shares[i]++;
        refresh();
      };
      if (card) {
        row.onmouseenter = () => this.showZoom(card, 'right');
        row.onmouseleave = () => this.showZoom(null);
      }
      row.append(label, minus, h('div', 'share'), plus);
      rows.push(row);
      list.append(row);
    });
    confirm.onclick = () => done([...shares]);
    panel.append(list, remaining, confirm);
    refresh();
  }

  private cardThumb(card: CardState): HTMLElement {
    const el = h('button', 'thumb');
    const img = h('img');
    img.alt = card.name ?? '';
    el.append(img);
    cardZoomUrl(card).then((url) => {
      if (url) img.src = url;
      else el.append(h('div', 'thumb-fallback', card.name ?? ''));
    });
    el.onmouseenter = () => this.showZoom(card, 'right');
    el.onmouseleave = () => this.showZoom(null);
    return el;
  }
}
