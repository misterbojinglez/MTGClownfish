import type { CardState, ChoiceOption, GameState, PlayerState, Prompt, RequestMsg, ResolvingSource, Selection } from '../protocol';
import { cardImageUrl, cardZoomUrl } from '../scene/textures';
import { sfx } from '../audio';

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

export interface ViewBarState {
  seats: { id: number; name: string; local: boolean }[];
  /** 'table', a player id, or null for a framing of several seats */
  showing: number | 'table' | null;
  auto: boolean;
}

export interface ViewBarHandlers {
  table(): void;
  seat(id: number): void;
  auto(on: boolean): void;
}

export interface HudHandlers {
  ok(): void;
  cancel(): void;
  player(id: number): void;
  passTurn(): void;
  concede(): void;
  /** undo the last undoable action (a mana tap, a declaration) */
  undo(): void;
  /** pay one Phyrexian (or K'rrik {B}) symbol of the cost being paid with life */
  payLife(): void;
  /** "OK to all": start passing until the stack is resolved, or stop doing so */
  resolveAll(): void;
  /** spend the mana floating in your pool on the cost being paid */
  useFloating(): void;
  /** leave the game for the main menu */
  exitToMenu(): void;
}

export class Hud {
  private readonly root = document.getElementById('hud')!;
  private readonly promptBox = h('div', 'prompt');
  private readonly promptText = h('div', 'prompt-text');
  private readonly promptSource = h('div', 'prompt-source');
  private readonly stackPanel = h('div', 'stack-panel');
  private stackKey = '';
  private promptSourceKey = '';
  private readonly okBtn = h('button', 'main-btn');
  /** the OK button currently means "choose nothing" (an optional target with none picked) */
  private skipping = false;
  private readonly cancelBtn = h('button', 'sub-btn');
  private readonly undoBtn = h('button', 'sub-btn undo-btn', 'Undo');
  private readonly lifeBtn = h('button', 'sub-btn life-btn');
  private readonly resolveAllBtn = h('button', 'sub-btn resolve-all-btn');
  private readonly floatingBtn = h('button', 'sub-btn floating-btn');
  private readonly phaseBar = h('div', 'phase-bar');
  private readonly turnLabel = h('div', 'turn-label');
  private readonly zoom = h('div', 'zoom');
  private readonly zoomImg = h('img');
  private readonly zoomText = h('div', 'zoom-text');
  /** where a battlefield creature's P/T comes from, when it differs from the printed card */
  private readonly zoomStats = h('div', 'zoom-stats');
  private readonly plates = new Map<number, HTMLDivElement>();
  private readonly toasts = h('div', 'toasts');
  private readonly status = h('div', 'status');
  private zoomFor = -1;
  private readonly viewBarEl = h('div', 'view-bar');
  private handlers!: HudHandlers;

  constructor() {
    // the button column at the bottom right, top to bottom: Pass Turn, Undo, Pay 2 life (when a cost allows it), the prompt's secondary, OK
    const pass = h('button', 'main-btn pass-btn', 'Pass Turn');
    pass.title = 'Pass priority until end of turn (Shift+Enter)';
    pass.onclick = () => this.handlers.passTurn();
    const undo = this.undoBtn;
    undo.title = 'Undo the last thing you did, where the rules allow (Z while paying)';
    undo.onclick = () => this.handlers.undo();
    const pair = h('div', 'actions');
    pair.append(this.cancelBtn, this.okBtn);
    const column = h('div', 'action-column');
    const life = this.lifeBtn;
    life.title = 'Pay this symbol with life instead of mana (or tap more mana)';
    life.onclick = () => this.handlers.payLife();
    const all = this.resolveAllBtn;
    all.title = 'Keep pressing OK until the stack is resolved (stops if an opponent adds something)';
    all.onclick = () => this.handlers.resolveAll();
    all.style.display = 'none';
    const floating = this.floatingBtn;
    floating.title = 'Spend the mana floating in your pool on this cost';
    floating.onclick = () => this.handlers.useFloating();
    floating.style.display = 'none';
    column.append(pass, undo, life, floating, all, pair);
    this.promptBox.append(this.promptSource, this.promptText, column);
    const phaseWrap = h('div', 'phase-wrap');
    phaseWrap.append(this.turnLabel, this.phaseBar);
    for (const key of PHASE_GROUPS) {
      const label = PHASES.find(([k]) => k === key)![1];
      const pip = h('div', 'phase', label);
      pip.dataset.phase = key;
      this.phaseBar.append(pip);
    }
    this.zoom.append(this.zoomImg, this.zoomText, this.zoomStats);
    this.root.append(this.promptBox, this.stackPanel, phaseWrap, this.zoom, this.toasts, this.status);
    this.okBtn.onclick = () => this.handlers.ok();
    this.cancelBtn.onclick = () => this.handlers.cancel();

    const menu = h('div', 'corner-menu');
    const concede = h('button', 'chip danger', 'Concede');
    concede.onclick = () => this.leaveMenu();
    // sound menu: everything, or effects and music separately, plus volume
    const sound = h('button', 'chip', 'Sound');
    const soundWrap = h('div', 'sound-wrap');
    const soundMenu = h('div', 'sound-menu');
    const row = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const r = h('label', 'sound-row');
      const box = h('input');
      box.type = 'checkbox';
      box.onchange = () => {
        set(box.checked);
        showSound();
      };
      r.append(box, h('span', '', label));
      soundMenu.append(r);
      return () => (box.checked = get());
    };
    const syncs = [
      row('All sound', () => !sfx.muted, (v) => sfx.setMuted(!v)),
      row('Sound effects', () => sfx.fx, (v) => sfx.setFx(v)),
      row('Music', () => sfx.music, (v) => sfx.setMusic(v)),
    ];
    const vol = h('input', 'sound-volume');
    vol.type = 'range';
    vol.min = '0';
    vol.max = '100';
    vol.oninput = () => sfx.setVolume(Number(vol.value) / 100);
    const volRow = h('label', 'sound-row');
    volRow.append(h('span', '', 'Volume'), vol);
    soundMenu.append(volRow);
    const showSound = () => {
      syncs.forEach((f) => f());
      vol.value = String(Math.round(sfx.volume * 100));
      soundMenu.querySelectorAll<HTMLElement>('.sound-row').forEach((r, i) => i > 0 && r.classList.toggle('dim', sfx.muted));
      sound.textContent = sfx.muted ? 'Sound off' : !sfx.fx && !sfx.music ? 'Sound off' : 'Sound';
      sound.classList.toggle('off', sfx.muted || (!sfx.fx && !sfx.music));
    };
    sound.title = 'Sound settings (M mutes everything)';
    sound.onclick = (e) => {
      e.stopPropagation();
      soundWrap.classList.toggle('open');
    };
    soundMenu.onclick = (e) => e.stopPropagation();
    document.addEventListener('click', () => soundWrap.classList.remove('open'));
    soundWrap.append(sound, soundMenu);
    showSound();
    menu.append(soundWrap, concede);
    // every button gets a soft click
    document.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest?.('button, .thumb')) sfx.click();
    }, true);
    this.root.append(menu, this.viewBarEl);

    window.addEventListener('keydown', (e) => {
      // typing a deck name or list mustn't trigger shortcuts (an "m" used to mute everything)
      if ((e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'm' || e.key === 'M') {
        sfx.toggleMute();
        showSound();
        return;
      }
      if (document.querySelector('.modal')) return;
      if ((e.key === ' ' || e.key === 'Enter') && e.shiftKey) {
        e.preventDefault();
        this.handlers.passTurn();
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (!this.okBtn.disabled && !this.skipping) this.handlers.ok();
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

  menu(onStart: (format: 'constructed' | 'commander', players: number, title: string) => void, onOnline?: () => void): void {
    this.closeOverlay();
    const ov = h('div', 'overlay menu');
    const title = h('h1', 'menu-logo');
    const logo = h('img');
    logo.src = '/logo-large.webp';
    logo.srcset = '/logo-360.webp 360w, /logo-large.webp 960w';
    logo.sizes = 'min(560px, 72vw)';
    logo.alt = 'MTGClownfish';
    title.append(logo);
    ov.append(title, h('p', 'sub tagline', 'Test your deck against Forge-Driven Competition'));
    const opts: [string, string, 'constructed' | 'commander', number][] = [
      ['Duel', '1 v 1 with a precon or your own deck', 'constructed', 2],
      ['Commander', 'Free-for-all against three AI opponents', 'commander', 4],
      ['Commander duel', '1 v 1 commander', 'commander', 2],
    ];
    const row = h('div', 'menu-row');
    for (const [title, desc, format, players] of opts) {
      const b = h('button', 'menu-card');
      b.append(h('div', 'menu-title', title), h('div', 'menu-desc', desc));
      b.onclick = () => {
        this.closeOverlay();
        onStart(format, players, title);
      };
      row.append(b);
    }
    if (onOnline) {
      const b = h('button', 'menu-card online');
      b.append(h('div', 'menu-title', 'Online'), h('div', 'menu-desc', 'Host a game for friends, or join one with a code'));
      b.onclick = () => onOnline();
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
    const row = h('div', 'setup-actions');
    const menu = h('button', 'sub-btn wide', 'Main menu');
    menu.onclick = () => this.handlers.exitToMenu();
    const again = h('button', 'main-btn wide', 'Play again');
    again.onclick = onAgain;
    row.append(menu, again);
    ov.append(row);
    this.root.append(ov);
  }

  /** The Concede chip: concede and keep watching, leave for the main menu, or carry on. */
  private leaveMenu(): void {
    if (document.querySelector('.modal.leave')) return;
    const modal = h('div', 'modal leave');
    const panel = h('div', 'modal-panel');
    panel.append(h('div', 'modal-title', 'Leave this game?'), h('div', 'modal-sub', 'Conceding lets the others play on; you can watch. Exiting ends the game.'));
    const row = h('div', 'modal-buttons');
    const close = () => {
      modal.classList.add('out');
      setTimeout(() => modal.remove(), 160);
      window.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const stay = h('button', 'sub-btn wide', 'Keep playing');
    stay.onclick = close;
    const concede = h('button', 'sub-btn wide', 'Concede');
    concede.onclick = () => {
      close();
      this.handlers.concede();
    };
    const exit = h('button', 'main-btn wide', 'Exit to main menu');
    exit.onclick = () => {
      close();
      this.handlers.exitToMenu();
    };
    row.append(stay, concede, exit);
    panel.append(row);
    modal.append(panel);
    modal.onclick = (e) => {
      if (e.target === modal) close();
    };
    window.addEventListener('keydown', onKey, true);
    this.root.append(modal);
  }

  // ---- prompt -------------------------------------------------------------------------------------

  setPrompt(prompt: Prompt, sel: Selection, waiting: boolean, state: GameState | null = null, localId = -1): void {
    // the resolving spell gets a header with its art and text, unless the stack list already shows it on top
    const onTop = !!prompt.source && prompt.source.card != null && state?.stack[0]?.source === prompt.source.card;
    const src = onTop ? null : prompt.source;
    const key = src ? JSON.stringify(src) : '';
    if (key !== this.promptSourceKey) {
      this.promptSourceKey = key;
      this.promptSource.replaceChildren(...(src ? [this.sourceHeader(src, state)] : []));
    }
    // without Forge's bracketed context notes ("[Added once: Summon: Bahamut]", "[Zone Changer: …]")
    let msg = tidyMessage((prompt.message ?? '').replace(/[ \t]*\[[^\]\n]*:[^\]\n]*\]/g, ''));
    // Forge's "(Click on your life total to pay life for …)": the Pay life button does that here
    if (prompt.lifePay) msg = msg.replace(/\n?\(Click on your life total to pay life[^)]*\)/i, '\n(Tap mana, or press Pay life to pay with life instead)');
    // Forge's status line counts game turns; show the active player's own count instead
    const active = state?.players.find((p) => p.id === state.activePlayer);
    if (active?.turns != null) msg = msg.replace(/^Turn: \d+ \((.+?)\)$/m, (_m, who: string) => `Turn: ${active.turns} (${who})`);
    if (sel.cards.length && sel.max > 0) {
      const picked = sel.chosen.length;
      msg += sel.max > 1 ? `\n(${picked}/${sel.max} selected)` : '';
    }
    if (sel.targets.some((t) => t?.player !== undefined)) msg += '\n(Click a player\'s portrait or their side of the table)';
    else if (prompt.input === 'InputAttack' && state && state.players.filter((p) => !p.lost).length > 2) msg += '\n(Drag a creature onto an opponent or their planeswalker, or click your creatures and then who to attack. Drag a box on the table to select several, then drag one of them)';
    else if (prompt.input === 'InputAttack') msg += '\n(Click your creatures, or drag one onto a planeswalker to attack it. Drag a box on the table to select several)';
    else if (prompt.input === 'InputBlock') msg += '\n(Drag a creature onto an attacker to block it. Drag a box on the table to select several, then drag one of them)';
    this.promptText.textContent = msg;
    const ok = prompt.ok;
    const cancel = prompt.cancel;
    // "up to one target" and other choices where nothing is allowed: until something is picked, OK means
    // choosing nothing. Say so, drop the "your move" glow, and keep Space/Enter from doing it by accident
    // (passing through a pile of triggers would otherwise skip Summon: Bahamut's destroy).
    this.skipping = !!ok?.enabled && SKIPPABLE_INPUTS.has(prompt.input ?? '') && sel.min === 0 && sel.chosen.length === 0 && (sel.cards.length > 0 || sel.targets.length > 0);
    this.okBtn.textContent = this.skipping ? 'Choose nothing' : ok?.label || 'OK';
    this.okBtn.disabled = !ok?.enabled || waiting;
    this.okBtn.classList.toggle('glow', !!ok?.enabled && !waiting && !this.skipping);
    this.okBtn.classList.toggle('skip', this.skipping);
    this.okBtn.classList.toggle('end-turn', /end turn|pass/i.test(ok?.label ?? '') || /^OK$/i.test(ok?.label ?? ''));
    this.cancelBtn.textContent = cancel?.label || 'Cancel';
    // "Alpha Strike" wears the purple-and-gold Attack style from the design sheet
    this.cancelBtn.classList.toggle('attack-btn', /alpha strike/i.test(cancel?.label ?? ''));
    // Forge sometimes offers Undo itself (your spell just went on the stack): don't show it twice
    this.undoBtn.style.visibility = /^undo$/i.test(cancel?.label ?? '') && cancel?.enabled ? 'hidden' : 'visible';
    this.cancelBtn.style.visibility = cancel?.enabled && !waiting ? 'visible' : 'hidden';
    this.cancelBtn.disabled = !cancel?.enabled || waiting;
    this.promptBox.classList.toggle('waiting', waiting);
    // Phyrexian mana (and K'rrik's {B}): life pays a symbol at a time, alongside whatever mana you tap
    const lp = prompt.lifePay;
    const canPayLife = !!lp && !waiting && lp.life - lp.committed >= lp.each;
    this.lifeBtn.style.display = canPayLife ? '' : 'none';
    // mana already floating in your pool: Forge spends it only when asked (its Auto can be off, as when the
    // rest of a cost is being paid with life)
    const me = state?.players.find((p) => p.id === localId);
    const floating = me ? Object.values(me.mana ?? {}).reduce((a, b) => a + b, 0) : 0;
    const paying = !!prompt.input?.startsWith('InputPayMana') && !waiting;
    this.floatingBtn.style.display = paying && floating > 0 ? '' : 'none';
    if (paying && floating > 0) this.floatingBtn.textContent = `Use floating mana (${floating})`;
    if (lp && canPayLife) this.lifeBtn.textContent = lp.shards > 1 ? `Pay ${lp.each} life · ${lp.shards} left` : `Pay ${lp.each} life`;
  }

  /** The "OK to all" button: offered with several things on the stack, or showing how many are left while it runs. */
  setResolveAll(mode: 'hidden' | 'offer' | 'running', left: number): void {
    const b = this.resolveAllBtn;
    b.style.display = mode === 'hidden' ? 'none' : '';
    b.classList.toggle('running', mode === 'running');
    if (mode === 'offer') b.textContent = `OK to all (${left})`;
    else if (mode === 'running') b.textContent = `Stop · ${left} left`;
  }

  /**
   * Nothing but life can pay the rest of a cost (no mana left that could): ask before spending it, rather
   * than leaving the player to find Forge's "click your life total".
   */
  confirmLifePayment(total: number, life: number, onPay: () => void): void {
    if (document.querySelector('.modal.life-pay')) return;
    const modal = h('div', 'modal life-pay');
    const panel = h('div', 'modal-panel');
    panel.append(
      h('div', 'modal-title', `Pay ${total} life?`),
      h('div', 'modal-sub', `There's no mana left for the rest of this cost. Paying with life takes you from ${life} to ${life - total}.`),
    );
    const row = h('div', 'modal-buttons');
    const close = () => {
      modal.classList.add('out');
      setTimeout(() => modal.remove(), 160);
      window.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const later = h('button', 'sub-btn wide', 'Not now');
    later.onclick = close;
    const pay = h('button', 'main-btn wide', `Pay ${total} life`);
    pay.onclick = () => {
      close();
      onPay();
    };
    row.append(later, pay);
    panel.append(row);
    modal.append(panel);
    modal.onclick = (e) => {
      if (e.target === modal) close();
    };
    window.addEventListener('keydown', onKey, true);
    this.root.append(modal);
    pay.focus();
  }

  /** The life question no longer applies (the payment finished or was cancelled). */
  dismissLifePayment(): void {
    const m = document.querySelector('.modal.life-pay:not(.out)');
    if (!m) return;
    m.classList.add('out');
    setTimeout(() => m.remove(), 160);
  }

  /**
   * What's on the stack, newest (next to resolve) first: each spell or ability with its card's art, so
   * it's clear which card every trigger comes from. Hover a row for the card.
   */
  /**
   * The Stack panel (from the design): each item as a card, the one that resolves next first and lit, with
   * what it does written under the row. Hover a card for the full view.
   */
  setStack(state: GameState | null, localId: number): void {
    const items = state?.stack ?? [];
    const key = items.map((i) => `${i.id}:${i.source}:${i.text}`).join(',');
    if (key === this.stackKey) return;
    this.stackKey = key;
    this.stackPanel.replaceChildren();
    this.stackPanel.classList.toggle('show', !!state && items.length > 0);
    if (!state || items.length === 0) return;
    const head = h('div', 'stack-head');
    head.append(h('span', 'stack-title', 'The Stack'), h('span', 'stack-count', String(items.length)));
    const row = h('div', 'stack-cards');
    const shown = items.slice(0, 8);
    shown.forEach((item, i) => {
      const card = item.source != null ? state.cards[item.source] : undefined;
      const name = card?.name ?? item.text.split(' - ')[0] ?? 'Effect';
      const kind = item.trigger ? 'Trigger' : item.ability ? 'Ability' : 'Spell';
      const who = item.controller === localId ? 'You' : state.players.find((p) => p.id === item.controller)?.name ?? '';
      const text = effectText(tidyMessage(item.text), name);
      const el = h('div', `stack-card ${item.trigger || item.ability ? 'ability' : 'spell'}${i === 0 ? ' top' : ''}`);
      el.title = `${name} · ${kind}${who ? ` · ${who}` : ''}${text && text !== name ? `\n${text}` : ''}`;
      const face = h('div', 'stack-face');
      if (card?.visible) void cardImageUrl(card).then((url) => { if (url) face.style.backgroundImage = `url("${url}")`; });
      else face.textContent = name;
      el.append(face, h('div', 'stack-tag', who ? `${kind} · ${who}` : kind));
      if (card) {
        el.onmouseenter = () => this.showZoom(card, 'right');
        el.onmouseleave = () => this.showZoom(null);
      }
      row.append(el);
    });
    if (items.length > shown.length) row.append(h('div', 'stack-more', `+${items.length - shown.length}`));
    // what the next item to resolve does
    const top = items[0];
    const topCard = top.source != null ? state.cards[top.source] : undefined;
    const topText = effectText(tidyMessage(top.text), topCard?.name ?? '');
    this.stackPanel.append(head, row);
    if (topText) this.stackPanel.append(h('div', 'stack-text', topText));
  }

  /** "Preordain · Spell" with its art and rules text: what is asking the current question. Hover for the card. */
  private sourceHeader(src: ResolvingSource, state: GameState | null): HTMLElement {
    const el = h('div', 'source-header');
    const card = src.card != null ? state?.cards[src.card] : undefined;
    const art = h('div', 'source-art');
    if (card) void cardImageUrl(card).then((url) => { if (url) art.style.backgroundImage = `url("${url}")`; });
    const body = h('div', 'source-body');
    const kind = src.trigger ? 'Triggered ability' : src.ability ? 'Ability' : 'Spell';
    const who = src.controller != null ? state?.players.find((p) => p.id === src.controller)?.name : undefined;
    body.append(h('div', 'source-name', src.name ?? 'Effect'), h('div', 'source-kind', who ? `${kind} · ${who}` : kind));
    // the stack text repeats the name ("Preordain - Scry 2…"); keep just the effect
    const text = effectText(src.text ?? '', src.name ?? '');
    if (text) body.append(h('div', 'source-text', text));
    el.append(art, body);
    if (card) {
      el.onmouseenter = () => this.showZoom(card, 'right');
      el.onmouseleave = () => this.showZoom(null);
    }
    return el;
  }

  setPhase(state: GameState, localId: number): void {
    const active = state.players.find((p) => p.id === state.activePlayer);
    const n = active?.turns ?? state.turn;
    this.turnLabel.textContent = active ? (active.id === localId ? `Your turn ${n}` : `${active.name} · turn ${n}`) : '';
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

  // ---- camera views (multiplayer) ----------------------------------------------------------------

  viewBar(state: ViewBarState | null, on: ViewBarHandlers): void {
    const bar = this.viewBarEl;
    bar.replaceChildren();
    bar.classList.toggle('show', !!state);
    if (!state) return;
    const btn = (label: string, active: boolean, title: string, fn: () => void) => {
      const b = h('button', `view-btn${active ? ' on' : ''}`, label);
      b.title = title;
      b.onclick = fn;
      bar.append(b);
      return b;
    };
    btn('Table', state.showing === 'table', 'See the whole table (0)', on.table);
    state.seats.forEach((seat, i) => btn(seat.local ? 'You' : seat.name, state.showing === seat.id, `Look at ${seat.local ? 'your side' : seat.name} (${i + 1})`, () => on.seat(seat.id)));
    const auto = btn('Auto', state.auto, 'Camera follows the game: whose turn it is, combat, what you need to pick (C)', () => on.auto(!state.auto));
    auto.classList.add('auto');
  }

  // ---- player plates ------------------------------------------------------------------------------

  updatePlayers(state: GameState, localId: number, screen: Map<number, { x: number; y: number }>, targetable: Set<number>, defender: number | null = null): void {
    const spots = this.placePlates(state, screen, localId);
    // seat colours in turn order from you: green, blue, purple (you're red)
    const at = state.players.findIndex((p) => p.id === localId);
    const seatOf = (pid: number) => {
      const i = state.players.findIndex((p) => p.id === pid);
      return ((i - at + state.players.length) % state.players.length) || 0;
    };
    for (const p of state.players) {
      let plate = this.plates.get(p.id);
      if (!plate) {
        plate = this.buildPlate(p, p.id === localId, seatOf(p.id));
        this.plates.set(p.id, plate);
        this.root.append(plate);
      }
      const spot = p.id === localId ? undefined : spots.get(p.id);
      if (spot) {
        plate.style.left = `${spot.x}px`;
        plate.style.top = `${spot.y}px`;
        plate.classList.toggle('edge', spot.edge);
      }
      plate.classList.toggle('local', p.id === localId);
      plate.classList.toggle('active', p.id === state.activePlayer);
      plate.classList.toggle('priority', p.priority);
      plate.classList.toggle('lost', p.lost);
      plate.classList.toggle('targetable', targetable.has(p.id) && defender !== p.id);
      plate.classList.toggle('defending', defender === p.id);
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
      const counts = plate.querySelector<HTMLDivElement>('.counts')!;
      const avail = p.manaAvailable;
      const key = `${p.zones.Hand.length}|${p.zones.LibraryCount}|${p.zones.Graveyard.length}|${avail}`;
      if (counts.dataset.v !== key) {
        counts.dataset.v = key;
        counts.replaceChildren(
          stat('hand', p.zones.Hand.length, `${p.zones.Hand.length} in hand`),
          stat('grave', p.zones.Graveyard.length, `${p.zones.Graveyard.length} in graveyard`),
          stat('library', p.zones.LibraryCount, `${p.zones.LibraryCount} in library`),
          // what they could spend right now: untapped mana sources plus anything floating
          ...(avail != null ? [stat('mana', avail, `${avail} mana available`)] : []),
        );
      }
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

  /**
   * Plates sit on their seats. A seat out of view keeps its plate at the screen edge nearest to it,
   * above your hand and clear of the prompt, and plates never pile onto each other.
   */
  private placePlates(state: GameState, screen: Map<number, { x: number; y: number }>, localId: number): Map<number, { x: number; y: number; edge: boolean }> {
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    const PW = 236;
    const PH = 78;
    const out = new Map<number, { x: number; y: number; edge: boolean }>();
    for (const p of state.players) {
      // your panel lives in the bottom-left corner
      if (p.id === localId) continue;
      const pos = screen.get(p.id);
      if (!pos) continue;
      const inside = pos.x > PW / 2 && pos.x < w - PW / 2 && pos.y > 60 && pos.y < hgt - 40;
      if (inside) {
        out.set(p.id, { x: pos.x, y: pos.y, edge: false });
        continue;
      }
      out.set(p.id, { x: Math.min(w - PW / 2 - 8, Math.max(PW / 2 + 8, pos.x)), y: Math.min(hgt - 230, Math.max(70, pos.y)), edge: true });
    }
    // push overlapping edge plates apart (plates on screen stay put)
    const ids = [...out.keys()];
    for (let iter = 0; iter < 8; iter++) {
      let moved = false;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = out.get(ids[i])!;
          const b = out.get(ids[j])!;
          const ox = PW - Math.abs(a.x - b.x);
          const oy = PH - Math.abs(a.y - b.y);
          if (ox <= 0 || oy <= 0 || (!a.edge && !b.edge)) continue;
          moved = true;
          const mover = b.edge ? b : a;
          const other = mover === b ? a : b;
          // slide along the edge it's pinned to: vertically on the sides, sideways on the top
          const onSide = mover.x <= PW / 2 + 9 || mover.x >= w - PW / 2 - 9;
          if (onSide) mover.y += (mover.y >= other.y ? 1 : -1) * (oy + 4);
          else mover.x += (mover.x >= other.x ? 1 : -1) * (ox + 6);
          mover.x = Math.min(w - PW / 2 - 8, Math.max(PW / 2 + 8, mover.x));
          mover.y = Math.min(hgt - 230, Math.max(70, mover.y));
        }
      }
      if (!moved) break;
    }
    // nothing sits on the prompt and stack list in the bottom-right corner: slide left of it, then up past
    // any plate already there
    const box = this.promptBox.getBoundingClientRect();
    if (box.width > 0) {
      const hits = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < PW && Math.abs(a.y - b.y) < PH;
      for (const [id, spot] of out) {
        const overlapX = spot.x + PW / 2 > box.left - 6 && spot.x - PW / 2 < box.right;
        const overlapY = spot.y + PH / 2 > box.top - 6 && spot.y - PH / 2 < box.bottom;
        if (!overlapX || !overlapY) continue;
        spot.x = box.left - PW / 2 - 14;
        spot.edge = true;
        for (let k = 0; k < 6 && [...out].some(([o, other]) => o !== id && hits(spot, other)); k++) spot.y -= PH + 6;
      }
    }
    return out;
  }

  /** A player's plate recoils from a blow: the harder the hit, the bigger the jolt. */
  hitPlate(pid: number, amount: number): void {
    const plate = this.plates.get(pid);
    if (!plate) return;
    plate.style.setProperty('--jolt', `${Math.min(18, 5 + amount * 1.6)}px`);
    plate.classList.remove('struck');
    void plate.offsetWidth;
    plate.classList.add('struck');
    window.setTimeout(() => plate.classList.remove('struck'), 650);
  }

  /**
   * A player's badge. Opponents: a life medallion ringed in their seat colour with a side panel of counts
   * (the design's Player Status Badge). You: the "You (Player)" panel fixed at the bottom left, with your
   * life on a red shield. Both keep .life / .counts / .extras / .mana, which updatePlayers fills in.
   */
  private buildPlate(p: PlayerState, local: boolean, seat: number): HTMLDivElement {
    const plate = h('div', local ? 'plate you-panel' : `plate badge seat-${seat}`);
    plate.dataset.pid = String(p.id);
    const info = h('div', 'plate-info');
    info.append(h('div', 'counts'), h('div', 'extras'), h('div', 'mana'));
    if (local) {
      const body = h('div', 'you-body');
      body.append(h('div', 'life'), info);
      plate.append(h('div', 'pname you-title', `${p.name === 'You' ? 'You' : p.name} (Player)`), body);
    } else {
      const medal = h('div', 'medal');
      medal.append(h('div', 'pname', p.name), h('div', 'life'));
      plate.append(medal, info);
    }
    plate.onclick = () => this.handlers.player(p.id);
    return plate;
  }

  /** Light up the plate an attacker is being dragged onto (null clears it). */
  aimPlate(playerId: number | null): void {
    for (const [pid, plate] of this.plates) plate.classList.toggle('aim', pid === playerId);
  }

  plateRect(playerId: number): DOMRect | null {
    return this.plates.get(playerId)?.getBoundingClientRect() ?? null;
  }

  resetPlayers(): void {
    this.plates.forEach((p) => p.remove());
    this.plates.clear();
  }

  // ---- zoom ---------------------------------------------------------------------------------------

  /** notes: extra chips above the card (how many are in a hovered stack) */
  showZoom(card: CardState | null, side: 'left' | 'right' = 'left', notes: string[] = []): void {
    if (!card || !card.visible) {
      this.zoom.classList.remove('show');
      this.zoomFor = -1;
      return;
    }
    this.zoom.classList.toggle('right', side === 'right');
    this.zoomStats.replaceChildren(...notes.map((n) => h('span', 'zs-total', n)), ...ptBreakdown(card));
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
      if (req.source) panel.append(this.sourceHeader(req.source, state));
      const title = h('div', 'modal-title', tidyMessage(req.message ?? ''));
      panel.append(title);
      // Forge's caption for trigger ordering is just "Resolve first"; say how the picking works instead
      const caption = req.kind === 'order' && /^resolve first$/i.test(req.caption ?? '')
        ? 'Click them in the order they should resolve: 1 resolves first.'
        : req.caption;
      if (caption && caption !== req.message) panel.append(h('div', 'modal-sub', caption));
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
        input.onkeydown = (e) => {
          if (e.key === 'Enter') done(input.value);
        };
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

    // when every option must be placed, the last one has nowhere else to go: fill it in
    const answer = (): number[] => {
      if (ordering && min === n && picked.length === n - 1) return [...picked, options.findIndex((_, i) => !picked.includes(i))];
      return picked;
    };
    const refresh = () => {
      const full = answer();
      items.forEach((el, i) => {
        const at = full.indexOf(i);
        el.classList.toggle('picked', at >= 0);
        el.classList.toggle('implied', at >= 0 && !picked.includes(i));
        const badge = el.querySelector('.order-badge');
        if (badge) badge.textContent = ordering && at >= 0 ? String(at + 1) : '';
      });
      confirm.disabled = !reveal && (full.length < min || full.length > max);
      if (ordering) confirm.textContent = 'Confirm order';
      else if (!reveal && max > 1) confirm.textContent = picked.length ? `Confirm (${picked.length}${max < n ? '/' + max : ''})` : 'Confirm';
    };

    options.forEach((o: ChoiceOption, i) => {
      const card = cardOf(o);
      let el: HTMLElement;
      if (hasCards && card?.visible) {
        el = this.cardThumb(card);
        if (o.ability != null || (o.label && o.label !== card.name)) el.append(h('div', 'thumb-label', choiceLabel(o.label)));
      } else {
        el = h('button', 'choice-item', choiceLabel(o.label));
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
          // a single pick from a text list (which ability, which mode) resolves on the click
          if (max === 1 && picked.length === 1 && !hasCards) done([...picked]);
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
      const all = h('button', 'sub-btn wide', 'Keep as shown');
      all.title = 'Resolve them left to right';
      all.onclick = () => done(options.map((_, i) => i));
      row.append(all);
    }
    confirm.onclick = () => done(reveal ? [] : [...answer()]);
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
      const minus = h('button', 'sub-btn icon', '−');
      const plus = h('button', 'sub-btn icon', '+');
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

  /**
   * Browse a pile (graveyard, exile): every card, newest first. Cards you could use right now glow and
   * can be clicked. Closes on the button, a click outside, or Escape.
   */
  showPile(title: string, cards: CardState[], usable: Set<number>, onUse: (id: number) => void): void {
    document.querySelector('.pile-viewer')?.remove();
    const modal = h('div', 'modal pile-viewer');
    const panel = h('div', 'modal-panel');
    panel.append(h('div', 'modal-title', `${title} · ${cards.length}`));
    const close = () => {
      modal.remove();
      this.showZoom(null);
      window.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    if (cards.length === 0) {
      panel.append(h('div', 'modal-sub', 'Empty'));
    } else {
      const list = h('div', 'choice-cards pile');
      if (cards.length > 8) list.classList.add('many');
      for (const c of [...cards].reverse()) {
        const t = this.cardThumb(c);
        if (usable.has(c.id)) {
          t.classList.add('usable');
          t.title = 'Use this card';
          t.onclick = () => {
            close();
            onUse(c.id);
          };
        } else {
          t.classList.add('inert');
        }
        list.append(t);
      }
      panel.append(list);
    }
    const row = h('div', 'modal-buttons');
    const done = h('button', 'main-btn wide', 'Close');
    done.onclick = close;
    row.append(done);
    panel.append(row);
    modal.append(panel);
    modal.onclick = (e) => {
      if (e.target === modal) close();
    };
    this.root.append(modal);
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

/** Forge tags card names with their object ids ("Island (70)"); players don't need those. */
/** "5/5 · base 2/2 · counters +2/+2 · effects +1/+1", as coloured spans; empty when nothing changed. */
function ptBreakdown(c: CardState): HTMLElement[] {
  if (c.zone !== 'Battlefield' || !c.creature || c.power === undefined || c.basePower === undefined || c.baseToughness === undefined) return [];
  const t = c.toughness ?? 0;
  const dmg = c.damage ?? 0;
  const cp = c.counterPower ?? 0;
  const ct = c.counterToughness ?? 0;
  const ep = c.power - c.basePower - cp;
  const et = t - c.baseToughness - ct;
  if (!cp && !ct && !ep && !et && !dmg) return [];
  const sign = (n: number) => (n < 0 ? `−${-n}` : `+${n}`);
  const tone = (a: number, b: number) => (a >= 0 && b >= 0 ? 'up' : a <= 0 && b <= 0 ? 'down' : '');
  const out = [h('span', `zs-total ${tone(c.power - c.basePower, t - c.baseToughness - dmg)}`, `${c.power}/${t - dmg}`), h('span', 'zs-part', `base ${c.basePower}/${c.baseToughness}`)];
  if (cp || ct) out.push(h('span', `zs-part ${tone(cp, ct)}`, `counters ${sign(cp)}/${sign(ct)}`));
  if (ep || et) out.push(h('span', `zs-part ${tone(ep, et)}`, `effects ${sign(ep)}/${sign(et)}`));
  if (dmg) out.push(h('span', 'zs-part down', `${dmg} damage`));
  return out;
}

/**
 * An option's text without Forge's trailing context, e.g. "… mill two cards. [Zone Changer: Massacre
 * Wurm (84)]": the card art beside it already says which card it is.
 */
function choiceLabel(text: string): string {
  return tidyMessage(text.replace(/\s*\[[^\]]*:[^\]]*\]\s*$/, ''));
}

/** Small line icons for the badge counts (inline SVG, so they render the same everywhere). */
const STAT_ICONS: Record<string, string> = {
  hand: '<path d="M4 6.5 11 4l3 11-7 2.5z" /><path d="M10 5.2 16 4l2.5 11.5-5 1" />',
  grave: '<path d="M6 20V9a6 6 0 0 1 12 0v11z" /><path d="M4 20h16M12 9v6M9.5 11.5h5" />',
  library: '<rect x="5" y="4" width="13" height="16" rx="1.5" /><path d="M8 4v16" />',
  mana: '<path d="M12 3 19 12 12 21 5 12z" /><path d="M12 7 15.5 12 12 17 8.5 12z" />',
};

/** One count on a badge: icon + number, with a tooltip. */
function stat(kind: string, n: number, title: string): HTMLElement {
  const el = h('span', `stat stat-${kind}`);
  el.title = title;
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${STAT_ICONS[kind] ?? ''}</svg><b>${n}</b>`;
  return el;
}

/** Forge inputs where picking nothing can be a legal answer that's easy to give by accident. */
const SKIPPABLE_INPUTS = new Set(['InputSelectTargets', 'InputSelectCardsFromList', 'InputSelectEntitiesFromList']);

function tidyMessage(text: string): string {
  return text.replace(/ \(\d+\)/g, '').trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Forge's stack text for display: drop the "Opt (6) - " prefix, and turn its third-person phrasing for
 * the local player ("You scries 1. You draw a card.") into plain imperatives ("Scry 1. Draw a card.").
 */
function effectText(raw: string, name: string): string {
  let t = tidyMessage(raw).replace(new RegExp(`^${escapeRe(name)}\\s*-\\s*`), '');
  t = t.replace(/(^|[.!?]\s+)You (\w+)/g, (m, lead: string, verb: string) => {
    if (/^(may|can|must|might|control|have)$/i.test(verb)) return m;
    const base = /(ch|sh|ss|x)es$/.test(verb) ? verb.slice(0, -2) : /ies$/.test(verb) && verb !== 'dies' ? verb.slice(0, -3) + 'y' : /[^s]s$/.test(verb) ? verb.slice(0, -1) : verb;
    return lead + base.charAt(0).toUpperCase() + base.slice(1);
  });
  return t;
}
