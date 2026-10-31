import type { CardState, ChoiceOption, GameState, PlayerState, Prompt, RequestMsg, ResolvingSource, Selection } from '../protocol';
import { cardArtUrl, cardImageUrl, cardZoomUrl } from '../scene/textures';
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
  private readonly cancelBtn = h('button', 'sub-btn');
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
    const actions = h('div', 'actions');
    actions.append(this.cancelBtn, this.okBtn);
    this.promptBox.append(this.stackPanel, this.promptSource, this.promptText, actions);
    const phaseWrap = h('div', 'phase-wrap');
    phaseWrap.append(this.turnLabel, this.phaseBar);
    for (const key of PHASE_GROUPS) {
      const label = PHASES.find(([k]) => k === key)![1];
      const pip = h('div', 'phase', label);
      pip.dataset.phase = key;
      this.phaseBar.append(pip);
    }
    this.zoom.append(this.zoomImg, this.zoomText, this.zoomStats);
    this.root.append(this.promptBox, phaseWrap, this.zoom, this.toasts, this.status);
    this.okBtn.onclick = () => this.handlers.ok();
    this.cancelBtn.onclick = () => this.handlers.cancel();

    const menu = h('div', 'corner-menu');
    const pass = h('button', 'chip', 'Pass turn');
    pass.title = 'Pass priority until end of turn (Shift+Enter)';
    pass.onclick = () => this.handlers.passTurn();
    const concede = h('button', 'chip danger', 'Concede');
    concede.onclick = () => confirm('Concede this game?') && this.handlers.concede();
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
    menu.append(soundWrap, pass, concede);
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

  menu(onStart: (format: 'constructed' | 'commander', players: number, title: string) => void): void {
    this.closeOverlay();
    const ov = h('div', 'overlay menu');
    ov.append(h('h1', '', 'MTG Tabletop'), h('p', 'sub', 'Play against Forge AI opponents'));
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

  setPrompt(prompt: Prompt, sel: Selection, waiting: boolean, state: GameState | null = null): void {
    // the resolving spell gets a header with its art and text, unless the stack list already shows it on top
    const onTop = !!prompt.source && prompt.source.card != null && state?.stack[0]?.source === prompt.source.card;
    const src = onTop ? null : prompt.source;
    const key = src ? JSON.stringify(src) : '';
    if (key !== this.promptSourceKey) {
      this.promptSourceKey = key;
      this.promptSource.replaceChildren(...(src ? [this.sourceHeader(src, state)] : []));
    }
    let msg = tidyMessage(prompt.message ?? '');
    // Forge's status line counts game turns; show the active player's own count instead
    const active = state?.players.find((p) => p.id === state.activePlayer);
    if (active?.turns != null) msg = msg.replace(/^Turn: \d+ \((.+?)\)$/m, (_m, who: string) => `Turn: ${active.turns} (${who})`);
    if (sel.cards.length && sel.max > 0) {
      const picked = sel.chosen.length;
      msg += sel.max > 1 ? `\n(${picked}/${sel.max} selected)` : '';
    }
    if (sel.targets.some((t) => t?.player !== undefined)) msg += '\n(Click a player\'s portrait or their side of the table)';
    else if (prompt.input === 'InputAttack' && state && state.players.filter((p) => !p.lost).length > 2) msg += '\n(Click your creatures and an opponent\'s portrait or side of the table, in either order)';
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

  /**
   * What's on the stack, newest (next to resolve) first: each spell or ability with its card's art, so
   * it's clear which card every trigger comes from. Hover a row for the card.
   */
  setStack(state: GameState | null, localId: number): void {
    const items = state?.stack ?? [];
    const key = items.map((i) => `${i.id}:${i.source}`).join(',');
    if (key === this.stackKey) return;
    this.stackKey = key;
    this.stackPanel.replaceChildren();
    if (!state || items.length === 0) return;
    const head = h('div', 'stack-head', items.length === 1 ? 'Stack · 1 item' : `Stack · ${items.length} items`);
    this.stackPanel.append(head);
    const shown = items.slice(0, 6);
    shown.forEach((item, i) => {
      const card = item.source != null ? state.cards[item.source] : undefined;
      const row = h('div', `stack-row${i === 0 ? ' top' : ''}`);
      const art = h('div', 'stack-art');
      if (card?.visible) void cardArtUrl(card).then((url) => { if (url) art.style.backgroundImage = `url("${url}")`; });
      const body = h('div', 'stack-body');
      const name = card?.name ?? item.text.split(' - ')[0];
      const kind = item.trigger ? 'Trigger' : item.ability ? 'Ability' : 'Spell';
      const who = item.controller === localId ? 'You' : state.players.find((p) => p.id === item.controller)?.name ?? '';
      body.append(h('div', 'stack-name', name ?? 'Effect'), h('div', 'stack-kind', who ? `${kind} · ${who}` : kind));
      const text = effectText(tidyMessage(item.text), name ?? '');
      if (text && text !== name) body.append(h('div', 'stack-text', text));
      row.append(art, body);
      if (card) {
        row.onmouseenter = () => this.showZoom(card, 'right');
        row.onmouseleave = () => this.showZoom(null);
      }
      this.stackPanel.append(row);
    });
    if (items.length > shown.length) this.stackPanel.append(h('div', 'stack-more', `+ ${items.length - shown.length} more`));
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
    const spots = this.placePlates(state, screen);
    for (const p of state.players) {
      let plate = this.plates.get(p.id);
      if (!plate) {
        plate = this.buildPlate(p);
        this.plates.set(p.id, plate);
        this.root.append(plate);
      }
      const spot = spots.get(p.id);
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

  /**
   * Plates sit on their seats. A seat out of view keeps its plate at the screen edge nearest to it,
   * above your hand and clear of the prompt, and plates never pile onto each other.
   */
  private placePlates(state: GameState, screen: Map<number, { x: number; y: number }>): Map<number, { x: number; y: number; edge: boolean }> {
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    const PW = 236;
    const PH = 66;
    const out = new Map<number, { x: number; y: number; edge: boolean }>();
    for (const p of state.players) {
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
    this.zoomStats.replaceChildren(...ptBreakdown(card));
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
