import type { CardState, ChoiceOption, GameState, PlayerState, Prompt, RequestMsg, ResolvingSource, Selection } from '../protocol';
import { DEFAULT_SETTINGS, onSettings, setSetting, type Settings } from '../settings';
import { cardArtUrl, cardImageUrl, cardZoomUrl } from '../scene/textures';
import { STEPS, fullControl, onStops, resetStops, setFullControl, setStop, stopsNow } from '../stops';
import { sfx } from '../audio';
import { startTour } from './tour';
import type { RadialAction } from './radial';

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

/** what passing with an empty stack leads to, on your own turn */
const NEXT_STEP: Record<string, string> = {
  UPKEEP: 'To draw', DRAW: 'To main', MAIN1: 'To combat', COMBAT_BEGIN: 'To attack', COMBAT_DECLARE_ATTACKERS: 'To blocks',
  COMBAT_DECLARE_BLOCKERS: 'To damage', COMBAT_FIRST_STRIKE_DAMAGE: 'To damage', COMBAT_DAMAGE: 'End combat', COMBAT_END: 'To main 2', MAIN2: 'To end step', END_OF_TURN: 'End turn',
};

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
  /** take Pass Turn back */
  resumeTurn(): void;
  /** take all your blocks back */
  clearBlocks(): void;
  /** ask again about orders you chose to keep */
  forgetOrders(): void;
  /** where something is on screen (a card on the table, a player's badge), or null */
  anchor(o: { card?: number; player?: number }): { x: number; y: number } | null;
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
  /** restart the match (at once, or by a vote of the people at the table) */
  restart(): void;
  /** answer a restart vote */
  vote(agree: boolean): void;
  /** every other seat is an AI, so a restart needs nobody's agreement */
  soloTable(): boolean;
}

export class Hud {
  private readonly root = document.getElementById('hud')!;
  private readonly promptBox = h('div', 'prompt');
  private readonly promptText = h('div', 'prompt-text');
  private readonly promptSource = h('div', 'prompt-source');
  private readonly stackPanel = h('div', 'stack-panel');
  private stackKey = '';
  /** The Stack tucked aside to see the board; it opens again for the next stack */
  private stackMin = false;
  private stackLast: { state: GameState | null; localId: number; count: number } = { state: null, localId: -1, count: 0 };
  private promptSourceKey = '';
  private readonly okBtn = h('button', 'main-btn');
  /** the OK button currently means "choose nothing" (an optional target with none picked) */
  private skipping = false;
  private readonly cancelBtn = h('button', 'sub-btn');
  private readonly undoBtn = h('button', 'sub-btn undo-btn', 'Undo');
  private readonly passBtn = h('button', 'main-btn pass-btn', 'Pass Turn');
  private readonly lifeBtn = h('button', 'sub-btn life-btn');
  private readonly resolveAllBtn = h('button', 'sub-btn resolve-all-btn');
  private readonly floatingBtn = h('button', 'sub-btn floating-btn');
  private readonly phaseBar = h('div', 'phase-bar');
  private readonly fullChip = h('button', 'full-chip');
  /** Pass Turn is in effect: the button takes it back */
  private passing = false;
  /** the secondary button clears your blocks (Forge offers none there) */
  private clearing = false;
  private readonly turnLabel = h('div', 'turn-label');
  private readonly zoom = h('div', 'zoom');
  private readonly zoomImg = h('img');
  private readonly zoomText = h('div', 'zoom-text');
  /** where a battlefield creature's P/T comes from, when it differs from the printed card */
  private readonly zoomStats = h('div', 'zoom-stats');
  private readonly plates = new Map<number, HTMLDivElement>();
  /** each player's commanders as last seen (they stay known while in a hidden zone), by player then card id */
  private readonly commanders = new Map<number, Map<number, CardState>>();
  private readonly toasts = h('div', 'toasts');
  private readonly status = h('div', 'status');
  private zoomFor = -1;
  private readonly viewBarEl = h('div', 'view-bar');
  private handlers!: HudHandlers;

  constructor() {
    // the button column at the bottom right, top to bottom: Pass Turn, Undo, Pay 2 life (when a cost allows it), the prompt's secondary, OK
    const pass = this.passBtn;
    pass.title = 'Pass priority until end of turn (Shift+Enter)';
    pass.onclick = () => (this.passing ? this.handlers.resumeTurn() : this.handlers.passTurn());
    const undo = this.undoBtn;
    undo.title = 'Undo the last thing you did, where the rules allow (Z)';
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
      pip.append(h('i', 'stop-mark mine'), h('i', 'stop-mark theirs'));
      this.phaseBar.append(pip);
    }
    // the bar opens the stops: where the game waits for you
    this.phaseBar.setAttribute('role', 'button');
    this.phaseBar.tabIndex = 0;
    this.phaseBar.title = 'Choose where the game stops for you';
    this.phaseBar.onclick = () => this.toggleStops();
    this.phaseBar.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      this.toggleStops();
    };
    this.fullChip.onclick = () => setFullControl('off');
    phaseWrap.append(this.fullChip);
    onStops(() => this.showStops());
    this.showStops();
    this.zoom.append(this.zoomImg, this.zoomText, this.zoomStats);
    this.root.append(this.promptBox, this.stackPanel, phaseWrap, this.zoom, this.toasts, this.status);
    this.okBtn.onclick = () => this.handlers.ok();
    this.cancelBtn.onclick = () => (this.clearing ? this.handlers.clearBlocks() : this.handlers.cancel());

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
    // the game's track, switched with the arrows (or the arrow keys while this menu is open)
    const trackRow = h('div', 'sound-row track-row');
    const prev = h('button', 'track-step', '‹');
    const next = h('button', 'track-step', '›');
    const trackName = h('span', 'track-name');
    prev.title = 'Previous track (←)';
    next.title = 'Next track (→)';
    prev.setAttribute('aria-label', 'Previous track');
    next.setAttribute('aria-label', 'Next track');
    prev.onclick = () => sfx.stepTrack(-1);
    next.onclick = () => sfx.stepTrack(1);
    trackRow.append(prev, trackName, next);
    soundMenu.append(trackRow);
    const showTrack = () => {
      const t = sfx.track;
      trackName.textContent = t ? `♪ ${t.artist}` : '♪ —';
      trackName.title = t ? `Now playing: music by ${t.artist} (Pixabay)` : '';
    };
    sfx.onTrack(showTrack);
    showTrack();
    window.addEventListener('keydown', (e) => {
      if (!soundWrap.classList.contains('open') || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      if ((e.target as HTMLElement).closest?.('input[type="range"], textarea')) return;
      e.preventDefault();
      e.stopPropagation();
      sfx.stepTrack(e.key === 'ArrowLeft' ? -1 : 1);
    }, true);
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
      soundMenu.querySelectorAll<HTMLElement>('.sound-row').forEach((r, i) => i > 0 && r.classList.toggle('dim', sfx.muted || (r === trackRow && !sfx.music)));
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
    const settingsChip = h('button', 'chip', 'Settings');
    settingsChip.title = 'Frame rate, effects and graphics detail';
    settingsChip.onclick = () => this.openSettings();
    menu.append(settingsChip, soundWrap, concede);
    // every button gets a soft click
    document.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest?.('button, .thumb')) sfx.click();
    }, true);
    this.root.append(menu, this.viewBarEl);

    window.addEventListener('resize', () => this.placeStack());
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
      } else if (e.key === 's' || e.key === 'S') {
        this.toggleStack();
      } else if (e.key === 'z' || e.key === 'Z') {
        if (this.undoBtn.style.visibility !== 'hidden') this.handlers.undo();
        else if (!this.cancelBtn.disabled) this.cancelBtn.click();
      } else if (e.key === 'f' || e.key === 'F') {
        if (document.body.classList.contains('in-game')) setFullControl(fullControl() === 'off' ? (e.shiftKey ? 'held' : 'turn') : 'off');
      } else if (e.key === 'Escape') {
        if (!this.cancelBtn.disabled) this.cancelBtn.click();
      }
    });
  }

  /**
   * The prompt's buttons as the radial menu offers them, read from the buttons themselves so the two never
   * disagree: each is visible and enabled exactly when its button is, and pressing one presses the button.
   */
  radialActions(): RadialAction[] {
    const shown = (b: HTMLElement) => b.style.display !== 'none' && b.style.visibility !== 'hidden';
    const of = (slot: RadialAction['slot'], b: HTMLButtonElement, always = false): RadialAction => ({
      slot,
      label: b.textContent ?? '',
      visible: always || shown(b),
      enabled: shown(b) && !b.disabled,
      primary: b.classList.contains('glow'),
      run: () => b.click(),
    });
    return [
      of('ok', this.okBtn, true),
      of('pass', this.passBtn, true),
      of('cancel', this.cancelBtn, true),
      of('undo', this.undoBtn, true),
      of('all', this.resolveAllBtn),
      of('life', this.lifeBtn),
      of('floating', this.floatingBtn),
    ];
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
    // "start": the screen builds in on arrival and out again when a game is chosen (theme.css)
    const ov = h('div', 'overlay menu start');
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
        if (ov.classList.contains('leaving')) return;
        ov.classList.add('leaving');
        // on to the game as soon as the (quick) build-out is over: the last option is the last to go
        let started = false;
        const start = () => {
          if (started) return;
          started = true;
          this.closeOverlay();
          onStart(format, players, title);
        };
        row.lastElementChild?.addEventListener('animationend', (e) => {
          if ((e as AnimationEvent).animationName.startsWith('start-') && (e as AnimationEvent).animationName.includes('out')) start();
        });
        setTimeout(start, 450);
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
    const settingsChip = h('button', 'chip menu-settings', 'Settings');
    settingsChip.title = 'Frame rate, effects and graphics detail';
    settingsChip.onclick = () => this.openSettings();
    const links = h('div', 'menu-links');
    const tutorial = h('button', 'menu-link', 'Tutorial');
    tutorial.onclick = () => startTour(this.root);
    const credits = h('button', 'menu-link', 'Credits');
    credits.onclick = () => this.openCredits();
    links.append(tutorial, h('span', 'menu-link-sep', '·'), credits);
    ov.append(settingsChip, links);
    this.root.append(ov);
  }

  /** Who made the pieces this runs on: the rules engine, the card images and the music. */
  openCredits(): void {
    if (document.querySelector('.modal.credits')) return;
    const modal = h('div', 'modal credits');
    const panel = h('div', 'modal-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Credits');
    panel.append(h('div', 'modal-title', 'Credits'));
    const list = h('div', 'credits-list');
    const group = (head: string, name: string, note: string) => {
      const g = h('div', 'credits-group');
      g.append(h('div', 'credits-head', head), h('div', 'credits-name', name), h('div', 'credits-note', note));
      list.append(g);
    };
    group('Rules engine', 'Forge AI', 'The rules engine and AI that power the gameplay');
    group('Card images', 'Scryfall', 'The images that power the cards');
    group('Music', 'leberch · delosound · sonican', 'For their work, licensed from Pixabay');
    group('Sound effects', 'universfield · olivia_parker', 'Punch and impact sounds, licensed from Pixabay');
    panel.append(list);
    const buttons = h('div', 'modal-buttons');
    const done = h('button', 'main-btn wide', 'Close');
    const close = () => {
      window.removeEventListener('keydown', onKey, true);
      modal.classList.add('out');
      setTimeout(() => modal.remove(), 160);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    done.onclick = close;
    modal.onclick = (e) => {
      if (e.target === modal) close();
    };
    window.addEventListener('keydown', onKey, true);
    buttons.append(done);
    panel.append(buttons);
    modal.append(panel);
    this.root.append(modal);
    done.focus();
  }

  /** Graphics and performance settings: each choice applies at once and is remembered on this device. */
  openSettings(): void {
    if (document.querySelector('.modal.settings')) return;
    const modal = h('div', 'modal settings');
    const panel = h('div', 'modal-panel');
    panel.append(h('div', 'modal-title', 'Settings'), h('div', 'modal-sub', 'Changes apply right away. Lower graphics settings run cooler and quieter.'));
    const rows = h('div', 'settings-rows');
    const syncs: ((st: Readonly<Settings>) => void)[] = [];
    const row = <K extends keyof Settings>(key: K, label: string, hint: string, choices: [Settings[K], string][]) => {
      const r = h('div', 'settings-row');
      const text = h('div', 'settings-text');
      text.append(h('div', 'settings-label', label), h('div', 'settings-hint', hint));
      const seg = h('div', 'seg');
      const buttons = choices.map(([value, name]) => {
        const b = h('button', '', name);
        b.onclick = () => setSetting(key, value);
        seg.append(b);
        return [value, b] as const;
      });
      syncs.push((st) => buttons.forEach(([value, b]) => b.classList.toggle('on', st[key] === value)));
      r.append(text, seg);
      rows.append(r);
    };
    row('frameRate', 'Frame rate', 'Auto draws 60 frames a second while things move and 30 when the table is still. Max matches your display.', [
      ['auto', 'Auto'],
      ['30', '30'],
      ['60', '60'],
      ['max', 'Max'],
    ]);
    row('particles', 'Effects', 'Spell and combat effects, sparks, and the embers rising off the floor.', [
      ['full', 'Full'],
      ['reduced', 'Reduced'],
      ['off', 'Off'],
    ]);
    row('floorDetail', 'Table detail', 'The carved stone and lava cracks around each player’s mat.', [
      ['high', 'High'],
      ['low', 'Low'],
    ]);
    row('resolution', 'Resolution', 'High uses your screen’s full sharpness. Standard draws fewer pixels on high-density screens.', [
      ['high', 'High'],
      ['standard', 'Standard'],
    ]);
    row('stackHold', 'Stack pace', 'The least time each spell or ability stays on The Stack before it resolves, so you can follow what happens when nobody stops to respond.', [
      ['0', 'Quick'],
      ['1', '1 s'],
      ['2', '2 s'],
      ['3', '3 s'],
    ]);
    rows.append(h('div', 'settings-group', 'Gameplay'));
    const onOff: ['off' | 'on', string][] = [['off', 'Off'], ['on', 'On']];
    row('warnings', 'Warnings', 'Ask before aiming something harmful at yourself, targeting a card with ward, or playing a second copy of a legendary.', onOff);
    row('autoPassOwn', 'Pass on your own', 'Pass priority for you when your own spell or ability is next to resolve. Full control (F) still stops there.', onOff);
    row('autoTriggers', 'Order triggers for me', 'Your triggers go on the stack in the order the game lists them.', onOff);
    row('autoReplacements', 'Order replacements for me', 'When several effects would change the same event, the game picks the order.', onOff);
    row('autoDamage', 'Assign damage for me', 'Combat damage goes lethal to each blocker in turn, and the rest tramples over.', onOff);
    panel.append(rows);
    const unsubscribe = onSettings((st) => syncs.forEach((f) => f(st)));
    const buttons = h('div', 'modal-buttons');
    const reset = h('button', 'sub-btn wide', 'Reset to defaults');
    reset.onclick = () => (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).forEach((k) => setSetting(k, DEFAULT_SETTINGS[k] as never));
    const done = h('button', 'main-btn wide', 'Done');
    const close = () => {
      unsubscribe();
      window.removeEventListener('keydown', onKey, true);
      modal.classList.add('out');
      setTimeout(() => modal.remove(), 160);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    done.onclick = close;
    modal.onclick = (e) => {
      if (e.target === modal) close();
    };
    window.addEventListener('keydown', onKey, true);
    const forget = h('button', 'sub-btn wide', 'Forget kept orders');
    forget.title = 'Ask again about trigger and replacement orders you chose to keep this game';
    forget.onclick = () => {
      this.handlers.forgetOrders();
      forget.textContent = 'Forgotten';
    };
    if (document.body.classList.contains('in-game')) buttons.append(forget);
    buttons.append(reset, done);
    panel.append(buttons);
    modal.append(panel);
    this.root.append(modal);
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
    ov.append(h('h1', '', won ? 'Victory' : 'Defeat'), h('p', 'sub', winner ? (winner === 'You' ? 'You win' : `${winner} wins`) : 'Draw'));
    const row = h('div', 'setup-actions');
    const menu = h('button', 'sub-btn wide', 'Main menu');
    menu.onclick = () => this.handlers.exitToMenu();
    const again = h('button', 'main-btn wide', 'Play again');
    again.onclick = onAgain;
    row.append(menu, again);
    ov.append(row);
    this.root.append(ov);
  }

  private voteModal: { id: number; el: HTMLElement; timer: number } | null = null;

  /**
   * A restart vote: someone else's asks you to agree or keep playing; once you've agreed (or if you called it)
   * it shows who has so far. A result closes it with a toast.
   */
  showVote(v: import('../protocol').VoteMsg): void {
    const cur = this.voteModal;
    if (v.result) {
      if (cur && cur.id === v.id) this.closeVote();
      this.toast(v.reason ?? (v.result === 'passed' ? 'Restarting the match…' : 'The game carries on.'), 'message');
      return;
    }
    if (cur && cur.id !== v.id) this.closeVote();
    let modal = this.voteModal?.el;
    if (!modal) {
      modal = h('div', 'modal vote');
      const ends = Date.now() + v.seconds * 1000;
      const timer = window.setInterval(() => {
        const left = Math.max(0, Math.ceil((ends - Date.now()) / 1000));
        const t = modal!.querySelector('.vote-time');
        if (t) t.textContent = `${left}s left to answer`;
      }, 250);
      this.voteModal = { id: v.id, el: modal, timer };
      this.root.append(modal);
    }
    modal.replaceChildren();
    const panel = h('div', 'modal-panel');
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-label', 'Restart vote');
    const mine = v.voted;
    panel.append(
      h('div', 'modal-title', mine ? 'Vote to restart' : `${v.by} wants to restart the match`),
      h('div', 'modal-sub', mine
        ? 'Waiting for everyone at the table. The match restarts with the same decks once all agree.'
        : 'Same seats, same decks, a fresh deal. Everyone has to agree.'),
    );
    const list = h('div', 'vote-list');
    for (const name of v.voters) {
      const yes = v.agreed.includes(name);
      const r = h('div', `vote-voter${yes ? ' yes' : ''}`);
      r.append(h('span', 'vote-mark', yes ? '✓' : '…'), h('span', '', name), h('span', 'vote-state', yes ? 'Agreed' : 'Deciding'));
      list.append(r);
    }
    panel.append(list, h('div', 'modal-sub vote-time', `${v.seconds}s left to answer`));
    const row = h('div', 'modal-buttons');
    if (mine) {
      const withdraw = h('button', 'sub-btn wide', 'Call it off');
      withdraw.onclick = () => this.handlers.vote(false);
      row.append(withdraw);
    } else {
      const no = h('button', 'sub-btn wide', 'Keep playing');
      no.onclick = () => this.handlers.vote(false);
      const yes = h('button', 'main-btn wide', 'Restart');
      yes.onclick = () => this.handlers.vote(true);
      row.append(no, yes);
    }
    panel.append(row);
    modal.append(panel);
  }

  closeVote(): void {
    const cur = this.voteModal;
    if (!cur) return;
    clearInterval(cur.timer);
    cur.el.classList.add('out');
    setTimeout(() => cur.el.remove(), 160);
    this.voteModal = null;
  }

  /** The Concede chip: concede and keep watching, leave for the main menu, or carry on. */
  private leaveMenu(): void {
    if (document.querySelector('.modal.leave')) return;
    const modal = h('div', 'modal leave');
    const panel = h('div', 'modal-panel');
    const solo = this.handlers.soloTable();
    panel.append(
      h('div', 'modal-title', 'Leave this game?'),
      h('div', 'modal-sub', solo
        ? 'Conceding lets the others play on; you can watch. Restarting deals a new game with the same decks. Exiting ends the game.'
        : 'Conceding lets the others play on; you can watch. A restart needs everyone at the table to agree. Exiting ends the game.'),
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
    const restart = h('button', 'sub-btn wide', solo ? 'Restart Match' : 'Vote to Restart');
    restart.onclick = () => {
      close();
      this.handlers.restart();
    };
    row.append(stay, concede, restart, exit);
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
    this.placeStack();
    const ok = prompt.ok;
    // your priority prompt: Forge's own "End Turn" secondary does what Pass Turn does (minus its guards against
    // stale presses and unseen opponent spells), so it isn't offered, and OK, which passes priority once, says so
    const priority = prompt.input === 'InputPassPriority';
    const cancel = priority && /^end turn$/i.test(prompt.cancel?.label ?? '') ? undefined : prompt.cancel;
    const okLabel = this.okLabel(prompt, state, localId);
    // "up to one target" and other choices where nothing is allowed: until something is picked, OK means
    // choosing nothing. Say so, drop the "your move" glow, and keep Space/Enter from doing it by accident
    // (passing through a pile of triggers would otherwise skip Summon: Bahamut's destroy).
    this.skipping = !!ok?.enabled && SKIPPABLE_INPUTS.has(prompt.input ?? '') && sel.min === 0 && sel.chosen.length === 0 && (sel.cards.length > 0 || sel.targets.length > 0);
    this.okBtn.textContent = this.skipping ? 'Choose nothing' : okLabel;
    this.okBtn.disabled = !ok?.enabled || waiting;
    this.okBtn.classList.toggle('glow', !!ok?.enabled && !waiting && !this.skipping);
    this.okBtn.classList.toggle('skip', this.skipping);
    this.okBtn.classList.toggle('end-turn', /end turn|pass/i.test(ok?.label ?? '') || /^OK$/i.test(ok?.label ?? ''));
    const myBlocks = prompt.input === 'InputBlock' && state ? this.myBlockers(state, localId).length : 0;
    this.clearing = myBlocks > 0 && !cancel?.enabled;
    this.cancelBtn.textContent = this.clearing ? 'Clear blocks' : /^alpha strike$/i.test(cancel?.label ?? '') ? 'Attack with all' : cancel?.label || 'Cancel';
    this.passing = !!prompt.passing;
    this.passBtn.textContent = this.passing ? 'Resume turn' : 'Pass Turn';
    this.passBtn.classList.toggle('resuming', this.passing);
    // "Alpha Strike" wears the purple-and-gold Attack style from the design sheet
    this.cancelBtn.classList.toggle('attack-btn', /alpha strike/i.test(cancel?.label ?? ''));
    // Forge sometimes offers Undo itself (your spell just went on the stack): don't show it twice
    this.undoBtn.style.visibility = /^undo$/i.test(cancel?.label ?? '') && cancel?.enabled ? 'hidden' : 'visible';
    const canCancel = (!!cancel?.enabled || this.clearing) && !waiting;
    this.cancelBtn.style.visibility = canCancel ? 'visible' : 'hidden';
    this.cancelBtn.disabled = !canCancel;
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

  private myBlockers(state: GameState, localId: number): number[] {
    return Object.values(state.cards).filter((c) => c.zone === 'Battlefield' && c.controller === localId && c.blocking).map((c) => c.id);
  }

  /** What OK does right now, in words. */
  private okLabel(prompt: Prompt, state: GameState | null, localId: number): string {
    const label = prompt.ok?.label ?? '';
    if (!/^OK$/i.test(label)) return label || 'OK';
    if (prompt.input === 'InputAttack' && state) {
      const n = Object.values(state.cards).filter((c) => c.zone === 'Battlefield' && c.controller === localId && c.attacking).length;
      return n ? `Attack with ${n}` : 'No attack';
    }
    if (prompt.input === 'InputBlock' && state) {
      const n = this.myBlockers(state, localId).length;
      return n ? `Block with ${n}` : 'No blocks';
    }
    if (prompt.input !== 'InputPassPriority') return 'OK';
    // your turn with nothing waiting: passing moves the turn on
    if (state && state.activePlayer === localId && state.stack.length === 0) {
      const next = NEXT_STEP[state.phase ?? ''];
      if (next) return next;
    }
    return 'Pass Priority';
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
    const key = `${this.stackMin ? 'min|' : ''}${items.map((i) => `${i.id}:${i.source}:${i.text}`).join(',')}`;
    if (key === this.stackKey) return;
    this.stackKey = key;
    // something new joined while it was tucked aside: the tab pulses so it isn't missed
    const grew = items.length > this.stackLast.count;
    this.stackLast = { state, localId, count: items.length };
    // an emptied stack ends it: the next one opens in full
    if (items.length === 0) this.stackMin = false;
    this.stackPanel.replaceChildren();
    this.stackPanel.classList.toggle('show', !!state && items.length > 0);
    this.stackPanel.classList.toggle('min', this.stackMin);
    // one item: its text wraps under the card instead of stretching the panel (theme.css)
    this.stackPanel.classList.toggle('single', items.length === 1);
    if (!state || items.length === 0) return;
    if (this.stackMin) {
      const tab = h('button', `stack-tab${grew ? ' pulse' : ''}`);
      tab.title = 'Show The Stack (S)';
      tab.append(h('span', 'stack-tab-arrow', '‹'), h('span', 'stack-title', 'The Stack'), h('span', 'stack-count', String(items.length)));
      tab.onclick = () => this.toggleStack();
      this.stackPanel.append(tab);
      return;
    }
    const head = h('div', 'stack-head');
    const hide = h('button', 'stack-hide', '›');
    hide.title = 'Move The Stack aside to see the board (S)';
    hide.setAttribute('aria-label', 'Move The Stack aside');
    hide.onclick = () => this.toggleStack();
    head.append(h('span', 'stack-title', 'The Stack'), h('span', 'stack-count', String(items.length)), hide);
    const row = h('div', 'stack-cards');
    const shown = items.slice(0, 8);
    shown.forEach((item, i) => {
      const card = item.source != null ? state.cards[item.source] : undefined;
      const name = card?.name ?? item.text.split(' - ')[0] ?? 'Effect';
      const kind = item.trigger ? 'Trigger' : item.ability ? 'Ability' : 'Spell';
      const who = item.controller === localId ? 'You' : state.players.find((p) => p.id === item.controller)?.name ?? '';
      const text = effectText(tidyMessage(item.text), name);
      const el = h('div', `stack-card ${item.trigger || item.ability ? 'ability' : 'spell'}${i === 0 ? ' top' : ''}`);
      el.dataset.item = String(item.id);
      el.title = `${name} · ${kind}${who ? ` · ${who}` : ''}${text && text !== name ? `\n${text}` : ''}`;
      const face = h('div', 'stack-face');
      if (card?.visible) void cardImageUrl(card).then((url) => { if (url) face.style.backgroundImage = `url("${url}")`; });
      else face.textContent = name;
      el.append(face, h('div', 'stack-tag', who ? `${kind} · ${who}` : kind));
      // hovering an item shows what it targets (the table draws its tethers), and its card's full view
      el.onmouseenter = () => {
        if (card) this.showZoom(card, 'left');
        this.onStackHover?.(item.id);
      };
      el.onmouseleave = () => {
        if (card) this.showZoom(null);
        this.onStackHover?.(null);
      };
      row.append(el);
    });
    if (items.length > shown.length) row.append(h('div', 'stack-more', `+${items.length - shown.length}`));
    // what the next item to resolve does
    const top = items[0];
    const topCard = top.source != null ? state.cards[top.source] : undefined;
    const topText = effectText(tidyMessage(top.text), topCard?.name ?? '');
    this.stackPanel.append(head, row);
    if (topText) this.stackPanel.append(h('div', 'stack-text', topText));
    this.placeStack();
  }

  /** Told which Stack item the pointer is over (null when it leaves), so the table can show its targets. */
  onStackHover: ((itemId: number | null) => void) | null = null;

  /**
   * Where a Stack item is on screen, for the tethers to what it targets: the left edge of its card in the
   * panel, or the tab's when the panel is tucked aside. Null when it isn't shown.
   */
  stackAnchor(itemId: number): { x: number; y: number } | null {
    if (!this.stackPanel.classList.contains('show')) return null;
    const el = this.stackPanel.querySelector<HTMLElement>(`.stack-card[data-item="${itemId}"]`) ?? this.stackPanel.querySelector<HTMLElement>('.stack-tab');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 ? { x: r.left + 4, y: r.top + r.height / 2 } : null;
  }

  /**
   * The Stack sits at the right, 30% down, but never over the prompt's message under it (what you're being
   * asked matters more): when the two would meet, the panel rides up, stopping below the phase tracker.
   */
  private placeStack(): void {
    const panel = this.stackPanel;
    panel.style.top = '';
    panel.style.removeProperty('--stack-card');
    if (!panel.classList.contains('show') || panel.classList.contains('min')) return;
    const above = [this.promptSource, this.promptText]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.height > 0)
      .reduce((top, r) => Math.min(top, r.top), Infinity);
    if (!Number.isFinite(above)) return;
    const TOP = 84; // below the phase tracker
    const limit = above - 14;
    let r = panel.getBoundingClientRect();
    if (r.bottom <= limit) return;
    // on a short window even the highest spot isn't enough: smaller cards (never below the old 96px)
    const room = limit - TOP;
    const face = panel.querySelector('.stack-face');
    if (r.height > room && face) {
      const width = face.getBoundingClientRect().width;
      const fit = Math.max(96, Math.floor(width - (r.height - room) * (488 / 680)));
      panel.style.setProperty('--stack-card', `${fit}px`);
      r = panel.getBoundingClientRect();
    }
    panel.style.top = `${Math.max(TOP, limit - r.height)}px`;
  }

  /** Tuck The Stack aside to see the board, or bring it back. */
  toggleStack(): void {
    if (!this.stackLast.state?.stack.length) return;
    this.stackMin = !this.stackMin;
    this.showZoom(null);
    this.setStack(this.stackLast.state, this.stackLast.localId);
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

  // ---- stops ---------------------------------------------------------------------------------------

  /** The marks on the phase bar (your turns' stops above, opponents' below) and the full-control chip. */
  private showStops(): void {
    const stops = stopsNow();
    this.phaseBar.querySelectorAll<HTMLElement>('.phase').forEach((pip) => {
      const key = pip.dataset.phase!;
      const steps = key === 'COMBAT_DECLARE_ATTACKERS' ? ['COMBAT_BEGIN', key] : key === 'COMBAT_DAMAGE' ? [key, 'COMBAT_END'] : [key];
      for (const side of ['mine', 'theirs']) {
        const mark = pip.querySelector(`.stop-mark.${side}`)!;
        const set = steps.map((k) => stops[`${side}:${k}`]);
        mark.classList.toggle('on', set.includes('on'));
        mark.classList.toggle('once', set.includes('once'));
      }
    });
    const full = fullControl();
    this.fullChip.classList.toggle('show', full !== 'off');
    this.fullChip.textContent = full === 'held' ? 'Full control, held · F to release' : 'Full control this turn · F to release';
    this.syncStops?.();
  }

  private syncStops: (() => void) | null = null;

  /** The stops, by step: for your turns and for opponents'. Each goes off → on → once. */
  toggleStops(): void {
    const open = document.querySelector('.stops');
    if (open) {
      (open as HTMLElement & { close?: () => void }).close?.();
      return;
    }
    const pop = h('div', 'stops');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Stops');
    const grid = h('div', 'stops-grid');
    grid.append(h('span', 'stops-head', ''), h('span', 'stops-head', 'Your turn'), h('span', 'stops-head', 'Opponents'));
    const cells: { key: string; b: HTMLButtonElement; what: string }[] = [];
    for (const [step, name] of STEPS) {
      grid.append(h('span', 'stops-step', name));
      for (const side of ['mine', 'theirs']) {
        const b = h('button', 'stop-cell');
        const key = `${side}:${step}`;
        b.onclick = () => {
          const now = stopsNow()[key];
          setStop(key, now === 'on' ? 'once' : now === 'once' ? null : 'on');
        };
        cells.push({ key, b, what: `${name}, ${side === 'mine' ? 'your turn' : "opponents' turns"}` });
        grid.append(b);
      }
    }
    const full = h('button', 'sub-btn wide', '');
    full.onclick = () => setFullControl(fullControl() === 'off' ? 'turn' : 'off');
    const reset = h('button', 'sub-btn wide', 'Reset stops');
    reset.onclick = () => resetStops();
    const row = h('div', 'modal-buttons');
    row.append(full, reset);
    pop.append(
      h('div', 'stops-note', 'The game waits for you at these steps when you could do something. A stop set to Once waits the next time whatever you could do, then comes off.'),
      grid,
      row,
      h('div', 'stops-note', 'Full control stops at every chance to act: F until the turn ends, Shift+F to hold it.'),
    );
    this.syncStops = () => {
      for (const c of cells) {
        const v = stopsNow()[c.key];
        c.b.textContent = v === 'on' ? 'Stop' : v === 'once' ? 'Once' : '·';
        c.b.classList.toggle('on', v === 'on');
        c.b.classList.toggle('once', v === 'once');
        c.b.setAttribute('aria-label', `${c.what}: ${v === 'on' ? 'stop' : v === 'once' ? 'stop once' : 'no stop'}`);
      }
      full.textContent = fullControl() === 'off' ? 'Full control this turn' : 'Release full control';
    };
    this.syncStops();
    const outside = (e: Event) => {
      if (!pop.contains(e.target as Node) && !this.phaseBar.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    const close = () => {
      this.syncStops = null;
      pop.remove();
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', onKey, true);
    };
    (pop as HTMLElement & { close?: () => void }).close = close;
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', onKey, true);
    this.root.append(pop);
  }

  /** Ask before something that's probably a mistake. */
  confirmChoice(title: string, text: string, yes: string, onYes: () => void, card?: CardState): void {
    if (document.querySelector('.modal.sure')) return;
    const modal = h('div', 'modal sure');
    const panel = h('div', 'modal-panel');
    panel.setAttribute('role', 'alertdialog');
    panel.append(h('div', 'modal-title', title), h('div', 'modal-sub', text));
    if (card) panel.append(this.cardThumb(card));
    const row = h('div', 'modal-buttons');
    const close = () => {
      window.removeEventListener('keydown', onKey, true);
      this.showZoom(null);
      modal.remove();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    const no = h('button', 'sub-btn wide', 'Cancel');
    no.onclick = close;
    const ok = h('button', 'main-btn wide', yes);
    ok.onclick = () => {
      close();
      onYes();
    };
    window.addEventListener('keydown', onKey, true);
    row.append(no, ok);
    panel.append(row);
    modal.append(panel);
    this.root.append(modal);
    no.focus();
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
      // your badge comes forward while attackers are coming at you
      if (p.id === localId) plate.classList.toggle('attacked', (state.combat ?? []).some((a) => a.defender?.player === p.id));
      const lifeEl = plate.querySelector<HTMLDivElement>('.life')!;
      if (lifeEl.textContent !== String(p.life)) {
        const prev = Number(lifeEl.textContent);
        lifeEl.textContent = String(p.life);
        if (!Number.isNaN(prev) && lifeEl.dataset.init) {
          lifeEl.classList.remove('hurt', 'heal');
          void lifeEl.offsetWidth;
          lifeEl.classList.add(p.life < prev ? 'hurt' : 'heal');
          if (p.id === localId) this.liven(plate);
        }
        lifeEl.dataset.init = '1';
      }
      const counts = plate.querySelector<HTMLDivElement>('.counts')!;
      const avail = p.manaAvailable;
      const key = `${p.zones.Hand.length}|${p.zones.LibraryCount}|${p.zones.Graveyard.length}|${avail}`;
      if (counts.dataset.v !== key) {
        counts.dataset.v = key;
        const hand = stat('hand', p.zones.Hand.length, `${p.zones.Hand.length} in hand`);
        const grave = stat('grave', p.zones.Graveyard.length, `${p.zones.Graveyard.length} in graveyard`);
        const library = stat('library', p.zones.LibraryCount, `${p.zones.LibraryCount} in library`);
        // what they could spend right now: untapped mana sources plus anything floating
        const mana = avail != null ? [stat('mana', avail, `${avail} mana available`)] : [];
        const right = plate.querySelector<HTMLDivElement>('.counts-r');
        if (right) {
          counts.replaceChildren(library, hand);
          right.replaceChildren(grave, ...mana);
        } else {
          counts.replaceChildren(hand, grave, library, ...mana);
        }
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
    this.noteCommanders(state);
    for (const p of state.players) {
      const plate = this.plates.get(p.id);
      if (plate) this.commanderArt(plate, p.id);
    }
  }

  /** Remember every commander in view, by its owner (a commander keeps its art while hidden in a hand). */
  private noteCommanders(state: GameState): void {
    for (const c of Object.values(state.cards)) {
      if (!c.commander || !c.visible || c.owner == null || !c.name) continue;
      let mine = this.commanders.get(c.owner);
      if (!mine) this.commanders.set(c.owner, (mine = new Map()));
      mine.set(c.id, c);
    }
  }

  /**
   * A player's commander art behind their badge, inside their medallion (partners split it in two).
   * Hovering it shows the card's zoom.
   */
  private commanderArt(plate: HTMLDivElement, pid: number): void {
    const cards = [...(this.commanders.get(pid)?.values() ?? [])].sort((a, b) => a.id - b.id).slice(0, 2);
    const key = cards.map((c) => c.id).join(',');
    if ((plate.dataset.cmd ?? '') === key) return;
    plate.dataset.cmd = key;
    const host = plate.querySelector<HTMLElement>('.medal');
    if (!host) return;
    host.querySelector('.cmd-art')?.remove();
    plate.classList.toggle('has-cmd', cards.length > 0);
    if (cards.length === 0) return;
    const art = h('div', `cmd-art${cards.length > 1 ? ' two' : ''}`);
    for (const c of cards) {
      const face = h('div', 'cmd-art-face');
      void cardArtUrl(c).then((url) => {
        if (!url) return;
        face.style.backgroundImage = `url("${url}")`;
        face.classList.add('loaded');
      });
      // the zoom shows on the far side of the screen from the badge
      face.onmouseenter = () => {
        const latest = this.commanders.get(pid)?.get(c.id) ?? c;
        this.showZoom(latest, plate.getBoundingClientRect().left < window.innerWidth / 2 ? 'right' : 'left');
      };
      face.onmouseleave = () => this.showZoom(null);
      art.append(face);
    }
    host.prepend(art);
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

  /** Your badge, translucent at rest, comes fully forward for a few seconds (a blow, a change of life). */
  private liven(plate: HTMLDivElement): void {
    plate.classList.add('lively');
    window.clearTimeout(Number(plate.dataset.lively ?? 0));
    plate.dataset.lively = String(window.setTimeout(() => plate.classList.remove('lively'), 2800));
  }

  /** A player's plate recoils from a blow: the harder the hit, the bigger the jolt. */
  hitPlate(pid: number, amount: number): void {
    const plate = this.plates.get(pid);
    if (!plate) return;
    if (plate.classList.contains('you-panel')) this.liven(plate);
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
    const plate = h('div', local ? 'plate you-panel seat-0' : `plate badge seat-${seat}`);
    plate.dataset.pid = String(p.id);
    const info = h('div', 'plate-info');
    info.append(h('div', 'counts'), h('div', 'extras'), h('div', 'mana'));
    if (local) {
      // centred above your hand: library and hand to the left of your life, graveyard and mana to its
      // right, your name on a tab beneath; commander damage, poison and floating mana ride above
      info.querySelector('.counts')!.remove();
      // your life on a medallion like everyone else's (your commander's art inside it), in your seat's red
      const body = h('div', 'you-body');
      const medal = h('div', 'medal');
      medal.append(h('div', 'life'));
      body.append(h('div', 'counts'), medal, h('div', 'counts counts-r'));
      plate.append(info, body, h('div', 'pname you-title', `${p.name === 'You' ? 'You' : p.name} (Player)`));
    } else {
      const medal = h('div', 'medal');
      medal.append(h('div', 'pname', p.name), h('div', 'life'));
      plate.append(medal, info);
    }
    plate.onclick = () => this.handlers.player(p.id);
    return plate;
  }

  /**
   * Seat your badge just above your hand: the hand's top edge on screen, in pixels from the bottom
   * (main works it out from the hand's layout and the camera, which widens its view on narrow windows).
   */
  placeYou(localId: number, bottomPx: number): void {
    const plate = this.plates.get(localId);
    if (!plate) return;
    const v = `${Math.round(bottomPx)}px`;
    if (plate.style.bottom !== v) plate.style.bottom = v;
  }

  /** Your badge steps aside (fades, lets the pointer through) while you're looking at a card in your hand. */
  handFocus(on: boolean): void {
    this.root.classList.toggle('hand-focus', on);
  }

  /** Light up the plate an attacker is being dragged onto (null clears it). */
  aimPlate(playerId: number | null): void {
    for (const [pid, plate] of this.plates) plate.classList.toggle('aim', pid === playerId);
  }

  /**
   * Where a player's badge is on screen, for arrows aimed at them: the middle of an opponent's medallion,
   * of the life shield on your own panel. Null before the plate is placed.
   */
  badgeCenter(playerId: number): { x: number; y: number } | null {
    const plate = this.plates.get(playerId);
    if (!plate || !plate.style.left && !plate.classList.contains('you-panel')) return null;
    const r = (plate.querySelector<HTMLElement>('.medal') ?? plate.querySelector<HTMLElement>('.life') ?? plate).getBoundingClientRect();
    return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
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
    // a token copy's art is the real card's: say it's a token
    const tags = card.token && card.zone === 'Battlefield' ? [h('span', 'zs-total zs-token', 'Token')] : [];
    this.zoomStats.replaceChildren(...tags, ...notes.map((n) => h('span', 'zs-total', n)), ...ptBreakdown(card));
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
    if (req.kind === 'distribute' && !req.combat) {
      const onTable = this.distributeOnTable(req, state);
      if (onTable) return onTable;
    }
    return new Promise((resolve) => {
      const modal = h('div', 'modal');
      const panel = h('div', 'modal-panel');
      modal.append(panel);
      // look at the table without answering: the dialog steps aside until you come back to it
      const peek = h('button', 'peek-btn', 'View battlefield');
      peek.onclick = () => {
        const on = modal.classList.toggle('peek');
        peek.textContent = on ? 'Back to the choice' : 'View battlefield';
        this.showZoom(null);
      };
      modal.append(peek);
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
      } else if (req.kind === 'piles') {
        this.buildPiles(req, state, panel, done);
      } else if (req.kind === 'place') {
        this.buildPlace(req, state, panel, done);
      } else if (req.kind === 'modes') {
        this.buildModes(req, state, panel, done);
      } else if (req.kind === 'number') {
        this.buildNumber(req, panel, done);
      } else if (req.kind === 'distribute' && req.combat) {
        this.buildDamage(req, state, panel, done);
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
    const off = new Set(req.disabled ?? []);
    let remember = false;
    // the table's copy of a card when it shows the card, else the face the bridge sent with the option (a card
    // in a hidden hand is on the table face down, but a reveal shows it)
    const cardOf = (o: ChoiceOption): CardState | undefined => {
      if (o.card == null) return undefined;
      const known = state?.cards[o.card];
      return known?.visible ? known : o.cardData ?? known;
    };
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
      if (off.has(i)) {
        el.classList.add('off');
        (el as HTMLButtonElement).setAttribute('aria-disabled', 'true');
      }
      if (!reveal && !off.has(i)) {
        el.onclick = () => {
          const at = picked.indexOf(i);
          if (at < 0 && req.distinct) {
            const same = picked.findIndex((k) => options[k].label === o.label);
            if (same >= 0) picked.splice(same, 1);
          }
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

    const answered = (order: number[]): unknown => (req.canRemember ? { order, remember } : order);
    const row = h('div', 'modal-buttons');
    if (!reveal && min === 0 && max >= 1) {
      const skip = h('button', 'sub-btn wide', 'None');
      skip.onclick = () => done([]);
      row.append(skip);
    }
    if (ordering && min === n) {
      const all = h('button', 'sub-btn wide', 'Keep as shown');
      all.title = 'Resolve them left to right';
      all.onclick = () => done(answered(options.map((_, i) => i)));
      row.append(all);
    }
    confirm.onclick = () => done(reveal ? [] : answered([...answer()]));
    row.append(confirm);
    if (req.canRemember) {
      const keep = h('label', 'keep-order');
      const box = h('input');
      box.type = 'checkbox';
      box.onchange = () => (remember = box.checked);
      keep.append(box, h('span', '', 'Keep this order the next time these come together this game'));
      panel.append(keep);
    }
    panel.append(row);
    refresh();
  }

  /**
   * Two piles side by side, each with its own Select button: the cards are there to look at (hover to zoom),
   * not to pick, since the choice is between whole piles. A face-down pile shows backs; an empty one says so.
   */
  private buildPiles(req: RequestMsg, state: GameState | null, panel: HTMLElement, done: (v: unknown) => void): void {
    const row = h('div', 'piles');
    (req.piles ?? []).forEach((pile, i) => {
      const col = h('div', 'pile-option');
      const head = h('div', 'pile-head');
      head.append(h('span', 'pile-name', pile.label), h('span', 'pile-count', pile.count === 1 ? '1 card' : `${pile.count} cards`));
      const cards = h('div', 'pile-cards');
      if (pile.count === 0) cards.append(h('div', 'pile-empty', 'Empty pile'));
      else if (pile.hidden) {
        for (let k = 0; k < Math.min(pile.count, 12); k++) cards.append(h('div', 'pile-back'));
      } else {
        for (const o of pile.options) {
          const known = o.card != null ? state?.cards[o.card] : undefined;
          const card = known?.visible ? known : o.cardData ?? known;
          const el = card ? this.cardThumb(card) : h('div', 'pile-back');
          el.tabIndex = -1;
          cards.append(el);
        }
      }
      if (pile.count > 8) cards.classList.add('many');
      const pick = h('button', 'main-btn wide pile-pick', `Select ${pile.label}`);
      pick.onclick = () => done(i);
      // pointing at a pile's button lights up the pile it picks
      pick.onmouseenter = () => col.classList.add('hot');
      pick.onmouseleave = () => col.classList.remove('hot');
      col.append(head, cards, pick);
      row.append(col);
    });
    panel.append(row);
  }

  /** A card as a thumbnail: the table's copy when it shows the card, else the face sent with the option. */
  private optionThumb(o: ChoiceOption, state: GameState | null): { el: HTMLElement; name: string; card?: CardState } {
    const known = o.card != null ? state?.cards[o.card] : undefined;
    const card = known?.visible ? known : o.cardData ?? known;
    return { el: card ? this.cardThumb(card) : h('button', 'choice-item', choiceLabel(o.label)), name: card?.name ?? o.label, card };
  }

  /**
   * Cards divided among named places (scry, surveil, explore, "one into your hand, the rest on the bottom"): each
   * sits under the place it's going. With two places a click sends a card to the other; with three, buttons under
   * it name them. Where order matters the cards are numbered as they'll be drawn, and arrows change it. A place
   * that's full gives up its earliest card to a new one. Confirm waits until every place has what it needs.
   */
  private buildPlace(req: RequestMsg, state: GameState | null, panel: HTMLElement, done: (v: unknown) => void): void {
    const options = req.options ?? [];
    const places = req.places ?? [];
    const start = req.start ?? 0;
    const verb = req.verb ?? '';
    const remaining = req.remaining ?? 0;
    const inPlace: number[][] = places.map((_, k) => (k === start ? options.map((_, i) => i) : []));
    const may = (i: number, k: number) => !places[k].allowed || places[k].allowed!.includes(i);
    const at = (i: number) => inPlace.findIndex((p) => p.includes(i));
    const hint = h('div', 'modal-sub', '');
    panel.append(hint);

    const lanes = h('div', options.length > 3 ? 'lanes many' : 'lanes');
    lanes.style.setProperty('--n', String(options.length));
    const laneEls = places.map((p) => {
      const el = h('div', `pile-option lane ${p.kind}`);
      const head = h('div', 'pile-head');
      const note = h('span', 'pile-count');
      head.append(h('span', 'pile-name', p.label), note);
      const cards = h('div', 'pile-cards');
      el.append(head, cards);
      lanes.append(el);
      return { el, cards, note };
    });
    const send = (i: number, k: number): void => {
      const from = at(i);
      if (from === k || !may(i, k)) return;
      if (inPlace[k].length >= places[k].max) {
        // full: its earliest card goes back where this one came from, if it may
        const out = inPlace[k].find((x) => may(x, from));
        if (out === undefined) return;
        inPlace[k] = inPlace[k].filter((x) => x !== out);
        inPlace[from].push(out);
      }
      inPlace[from] = inPlace[from].filter((x) => x !== i);
      inPlace[k].push(i);
      this.showZoom(null);
      refresh();
    };
    const slots = options.map((o, i) => {
      const { el: thumb, name } = this.optionThumb(o, state);
      const slot = h('div', 'lane-card');
      thumb.onclick = () => {
        if (places.length < 2) return;
        const from = at(i);
        const next = places.map((_, d) => (from + 1 + d) % places.length).find((k) => k !== from && may(i, k) && (places.length === 2 || inPlace[k].length < places[k].max));
        if (next !== undefined) send(i, next);
        thumb.focus();
      };
      const badge = h('span', 'order-badge');
      thumb.append(badge);
      const foot = h('div', 'lane-foot');
      const step = (d: number) => {
        const p = inPlace[at(i)];
        const k = p.indexOf(i);
        [p[k], p[k + d]] = [p[k + d], p[k]];
        refresh();
      };
      const left = h('button', 'sub-btn icon', '‹');
      left.title = 'Draw it sooner';
      left.setAttribute('aria-label', `Draw ${name} sooner`);
      left.onclick = () => step(-1);
      const right = h('button', 'sub-btn icon', '›');
      right.title = 'Draw it later';
      right.setAttribute('aria-label', `Draw ${name} later`);
      right.onclick = () => step(1);
      foot.append(left, right);
      const to = h('div', 'lane-to');
      const toBtns = places.length > 2 ? places.map((p, k) => {
        const b = h('button', 'lane-to-btn', p.label.replace(' of library', ''));
        b.title = p.label;
        b.onclick = () => send(i, k);
        to.append(b);
        return b;
      }) : [];
      slot.append(thumb, foot, to);
      return { slot, thumb, badge, foot, left, right, name, toBtns };
    });

    const confirm = h('button', 'main-btn wide', 'Confirm');
    const skip = h('button', 'sub-btn wide', '');
    const count = (n: number) => (n === 1 ? '1 card' : `${n} cards`);
    const refresh = () => {
      places.forEach((p, k) => {
        const ids = inPlace[k];
        laneEls[k].cards.replaceChildren(...(ids.length ? ids.map((i) => slots[i].slot) : [h('div', 'pile-empty', 'None')]));
        const limits = p.min === p.max && p.max < options.length ? `${ids.length} of ${p.max}` : p.max < options.length ? `${ids.length}, up to ${p.max}` : count(ids.length);
        laneEls[k].note.textContent = p.ordered && ids.length > 1 ? `${limits} · 1 is drawn first` : limits;
        laneEls[k].el.classList.toggle('short', ids.length < p.min);
      });
      slots.forEach((s, i) => {
        const k = at(i);
        const p = inPlace[k];
        const n = p.indexOf(i);
        const ordering = places[k].ordered && p.length > 1;
        s.badge.textContent = ordering ? String(n + 1) : '';
        s.foot.classList.toggle('hidden', !ordering);
        s.left.disabled = n <= 0;
        s.right.disabled = n === p.length - 1;
        s.thumb.classList.toggle('fixed', places.length > 1 && !places.some((_, j) => j !== k && may(i, j)));
        s.thumb.setAttribute('aria-label', `${s.name}: ${places[k].label.toLowerCase()}`);
        s.toBtns.forEach((b, j) => {
          b.classList.toggle('on', j === k);
          b.disabled = j !== k && !may(i, j);
        });
      });
      const short = places.findIndex((p, k) => inPlace[k].length < p.min);
      confirm.disabled = short >= 0;
      hint.textContent = short >= 0
        ? `${places[short].label} needs ${places[short].min - inPlace[short].length} more.`
        : places.length === 1 ? 'Use the arrows to change the order they’ll be drawn in.'
          : places.length === 2 ? `Click a card to move it between ${places[0].label.toLowerCase()} and ${places[1].label.toLowerCase()}.`
            : 'Use the buttons under each card to say where it goes.';
      const [keep, away] = [inPlace[0].length, (inPlace[1] ?? []).length];
      const gone = places[1]?.kind === 'graveyard' ? 'graveyard' : 'bottom';
      confirm.textContent = !verb ? (places.length === 1 ? 'Confirm order' : 'Confirm')
        : away === 0 ? (keep > 1 ? 'Keep all on top' : 'Keep on top')
          : keep === 0 ? (gone === 'graveyard' ? 'Put in graveyard' : 'Put on bottom')
            : `Keep ${keep}, ${away} to ${gone}`;
      skip.disabled = keep === 0;
    };
    const answer = (skipRest: boolean) => done({ places: inPlace, skip: skipRest });
    confirm.onclick = () => answer(false);
    const row = h('div', 'modal-buttons');
    if (verb && remaining > 0) {
      const plural = verb === 'Scry' ? 'scries' : `${verb.toLowerCase()}s`;
      skip.textContent = remaining === 1 ? `Confirm & skip the next ${verb.toLowerCase()}` : `Confirm & skip ${remaining} more ${plural}`;
      skip.title = `Do this and keep the top as it is through the ${plural} still on the stack. You'll be asked again if one would show you a new card.`;
      skip.onclick = () => answer(true);
      row.append(skip);
    }
    row.append(confirm);
    panel.append(lanes, row);
    refresh();
  }

  /** Modes, all chosen here: click to take one or give it back; a repeatable one has its own − and +. */
  private buildModes(req: RequestMsg, state: GameState | null, panel: HTMLElement, done: (v: unknown) => void): void {
    const options = req.options ?? [];
    const min = req.min ?? 1;
    const max = req.max ?? 1;
    const counts = options.map(() => 0);
    const total = () => counts.reduce((a, b) => a + b, 0);
    const sub = h('div', 'modal-sub', min === max ? `Choose ${min}` : min === 0 ? `Choose up to ${max}` : `Choose ${min} to ${max}`);
    panel.append(sub);
    const body = h('div', 'modes');
    const host = (req.card != null ? state?.cards[req.card] : undefined);
    const card = host?.visible ? host : req.cardData ?? host;
    if (card) body.append(this.cardThumb(card));
    const list = h('div', 'choice-list');
    const confirm = h('button', 'main-btn wide', 'Confirm');
    const items = options.map((o, i) => {
      const row = h('div', 'mode-row');
      const b = h('button', 'choice-item', choiceLabel(o.label));
      b.append(h('span', 'order-badge'));
      b.onclick = () => {
        if (req.repeat) {
          if (total() < max) counts[i]++;
        } else if (counts[i]) counts[i] = 0;
        else {
          if (total() >= max) {
            // one to choose: the new pick replaces the old
            if (max !== 1) return;
            counts.fill(0);
          }
          counts[i] = 1;
        }
        refresh();
      };
      row.append(b);
      if (req.repeat) {
        const less = h('button', 'sub-btn icon', '−');
        less.setAttribute('aria-label', 'One fewer');
        less.onclick = () => {
          if (counts[i] > 0) counts[i]--;
          refresh();
        };
        row.append(less);
      }
      list.append(row);
      return b;
    });
    const refresh = () => {
      items.forEach((b, i) => {
        b.classList.toggle('picked', counts[i] > 0);
        b.setAttribute('aria-pressed', String(counts[i] > 0));
        b.querySelector('.order-badge')!.textContent = req.repeat && counts[i] > 0 ? `×${counts[i]}` : '';
        b.classList.toggle('spent', counts[i] === 0 && total() >= max && max > 1);
      });
      const n = total();
      confirm.disabled = n < min || n > max;
      confirm.textContent = max > 1 ? `Confirm (${n}/${max})` : 'Confirm';
    };
    body.append(list);
    const row = h('div', 'modal-buttons');
    confirm.onclick = () => done(counts.flatMap((n, i) => Array<number>(n).fill(i)));
    row.append(confirm);
    panel.append(body, row);
    refresh();
  }

  /** A number on a stepper: one at a time, five at a time, or typed. Zero for X asks twice. */
  private buildNumber(req: RequestMsg, panel: HTMLElement, done: (v: unknown) => void): void {
    const min = req.min ?? 0;
    const max = req.max ?? Infinity;
    const isX = /\bX\b/.test(req.message ?? '');
    let value = min;
    let sure = false;
    const box = h('input', 'modal-input number-value');
    box.type = 'number';
    box.min = String(min);
    if (Number.isFinite(max)) box.max = String(max);
    box.setAttribute('aria-label', req.message ?? 'Number');
    const confirm = h('button', 'main-btn wide', '');
    const steps: [HTMLButtonElement, number][] = ([[-5, '−5'], [-1, '−'], [1, '+'], [5, '+5']] as [number, string][]).map(([d, t]) => {
      const b = h('button', 'sub-btn icon', t);
      b.onclick = () => set(value + d);
      return [b, d];
    });
    const set = (v: number, typed = false) => {
      value = Math.max(min, Math.min(max, Math.floor(Number.isFinite(v) ? v : min)));
      sure = false;
      if (!typed) box.value = String(value);
      steps.forEach(([b, d]) => (b.disabled = d < 0 ? value <= min : value >= max));
      confirm.textContent = isX ? `X = ${value}` : `Confirm ${value}`;
    };
    box.oninput = () => set(Number(box.value), true);
    box.onkeydown = (e) => {
      if (e.key === 'Enter') confirm.click();
    };
    confirm.onclick = () => {
      if (isX && value === 0 && !sure) {
        sure = true;
        confirm.textContent = 'Really X = 0?';
        return;
      }
      done(value);
    };
    const row = h('div', 'number-row');
    row.append(steps[0][0], steps[1][0], box, steps[2][0], steps[3][0]);
    const buttons = h('div', 'modal-buttons');
    if (req.cancel) {
      const no = h('button', 'sub-btn wide', 'Cancel');
      no.onclick = () => done(null);
      buttons.append(no);
    }
    buttons.append(confirm);
    panel.append(row, h('div', 'modal-sub', Number.isFinite(max) ? `${min} to ${max}` : `${min} or more`), buttons);
    set(min);
    setTimeout(() => box.select(), 50);
  }

  /**
   * Combat damage: the attacker, its blockers and whoever it's attacking, as cards, with a stepper under each.
   * Starts lethal to each in turn; the arrows change that order and "Lethal in order" deals it out again. A point
   * added with none left comes off another. With trample nothing goes over until every blocker has lethal.
   */
  private buildDamage(req: RequestMsg, state: GameState | null, panel: HTMLElement, done: (v: unknown) => void): void {
    const options = req.options ?? [];
    const total = req.amount ?? 0;
    const shares = options.map((o) => o.initial ?? 0);
    const blockers = options.map((_, i) => i).filter((i) => !options[i].defender);
    const defender = options.findIndex((o) => o.defender);
    let order = [...blockers];
    const left = () => total - shares.reduce((a, b) => a + b, 0);
    const lethal = (i: number) => options[i].lethal ?? 0;
    const allLethal = () => blockers.every((i) => shares[i] >= lethal(i));
    const locked = () => defender >= 0 && !req.freeDefender && !allLethal();
    const note = h('div', 'modal-sub');
    const board = h('div', 'damage-board');
    const attacker = h('div', 'damage-side');
    const host = req.card != null ? state?.cards[req.card] : undefined;
    const src = host?.visible ? host : req.cardData ?? host;
    if (src) attacker.append(this.cardThumb(src));
    const pool = h('div', 'damage-pool');
    attacker.append(pool);
    const row = h('div', 'damage-row');
    const confirm = h('button', 'main-btn wide', 'Deal damage');
    const slots = options.map((o, i) => {
      const slot = h('div', `damage-slot${o.defender ? ' defender' : ''}`);
      const player = o.player != null ? state?.players.find((p) => p.id === o.player) : undefined;
      if (player) {
        const face = h('div', 'damage-player');
        face.append(h('div', 'damage-life', String(player.life)), h('div', '', player.name));
        slot.append(face);
      } else slot.append(this.optionThumb(o, state).el);
      const label = h('div', 'damage-note');
      const name = player?.name ?? o.label;
      const minus = h('button', 'sub-btn icon', '−');
      minus.setAttribute('aria-label', `One less to ${name}`);
      const plus = h('button', 'sub-btn icon', '+');
      plus.setAttribute('aria-label', `One more to ${name}`);
      const value = h('div', 'share');
      const steps = h('div', 'damage-steps');
      steps.append(minus, value, plus);
      minus.onclick = () => {
        if (shares[i] > 0) shares[i]--;
        refresh();
      };
      plus.onclick = () => {
        if (i === defender && locked()) return;
        if (left() <= 0) {
          const from = [...order, defender].reverse().find((j) => j >= 0 && j !== i && shares[j] > 0);
          if (from === undefined) return;
          shares[from]--;
        }
        shares[i]++;
        refresh();
      };
      const move = h('div', 'damage-move');
      const swap = (d: number) => {
        const k = order.indexOf(i);
        [order[k], order[k + d]] = [order[k + d], order[k]];
        refresh();
      };
      const l = h('button', 'lane-to-btn', '‹ sooner');
      l.onclick = () => swap(-1);
      const r = h('button', 'lane-to-btn', 'later ›');
      r.onclick = () => swap(1);
      if (!o.defender && blockers.length > 1) move.append(l, r);
      slot.append(steps, label, move);
      return { slot, value, label, minus, plus, l, r };
    });
    const refresh = () => {
      row.replaceChildren(...order.map((i) => slots[i].slot), ...(defender >= 0 ? [slots[defender].slot] : []));
      const n = left();
      const early = defender >= 0 && shares[defender] > 0 && locked();
      options.forEach((o, i) => {
        const s = slots[i];
        s.value.textContent = String(shares[i]);
        s.minus.disabled = shares[i] <= 0;
        s.plus.disabled = shares[i] >= total || (i === defender && locked());
        const kills = !o.defender && shares[i] >= lethal(i);
        s.slot.classList.toggle('lethal', kills);
        s.slot.classList.toggle('hurt', !o.defender && !kills && shares[i] > 0);
        s.slot.classList.toggle('locked', i === defender && locked());
        s.label.textContent = o.defender ? (locked() ? 'after lethal to every blocker' : 'the rest') : lethal(i) === 0 ? 'already lethal' : kills ? `lethal (${lethal(i)})` : `lethal is ${lethal(i)}`;
        s.l.disabled = order.indexOf(i) <= 0;
        s.r.disabled = order.indexOf(i) === order.length - 1;
      });
      pool.textContent = `${total} damage`;
      note.textContent = early ? 'Every blocker needs lethal damage before any can go over.' : n > 0 ? `${n} left to assign` : 'All assigned';
      note.classList.toggle('warn', early);
      confirm.disabled = n !== 0 || early;
    };
    const auto = h('button', 'sub-btn wide', 'Lethal in order');
    auto.title = 'Deal lethal to each blocker, left to right, and the rest after';
    auto.onclick = () => {
      let rest = total;
      shares.fill(0);
      for (const i of order) {
        shares[i] = Math.min(rest, lethal(i));
        rest -= shares[i];
      }
      if (rest > 0) shares[defender >= 0 ? defender : order[order.length - 1]] += rest;
      refresh();
    };
    confirm.onclick = () => done([...shares]);
    board.append(attacker, row);
    const buttons = h('div', 'modal-buttons');
    buttons.append(auto, confirm);
    panel.append(board, note, buttons);
    refresh();
  }

  /**
   * Dividing damage, counters or shields among targets that are on the table: the steppers sit on the targets
   * themselves, with a small bar to confirm. Null when something can't be pointed at (colours of mana, a card off
   * the table): the dialog does it instead.
   */
  private distributeOnTable(req: RequestMsg, state: GameState | null): Promise<unknown> | null {
    const options = req.options ?? [];
    const place = (o: ChoiceOption) => this.handlers.anchor({ card: o.card, player: o.player });
    if (!options.length || !options.every((o) => !o.color && place(o))) return null;
    const total = req.amount ?? 0;
    const min = req.atLeastOne ? 1 : 0;
    const cap = (i: number) => options[i].max ?? total;
    const shares = options.map((): number => min);
    const left = () => total - shares.reduce((a, b) => a + b, 0);
    for (let i = 0, guard = 0; left() > 0 && guard < total * options.length + options.length; i = (i + 1) % options.length, guard++) if (shares[i] < cap(i)) shares[i]++;
    return new Promise((resolve) => {
      // "modal" so the prompt's keys stay quiet meanwhile; it covers nothing
      const layer = h('div', 'modal on-table');
      const bar = h('div', 'on-table-bar');
      const note = h('span', 'on-table-note');
      const confirm = h('button', 'main-btn wide', 'Confirm');
      bar.append(h('span', 'on-table-title', tidyMessage(req.message ?? 'Divide')), note, confirm);
      layer.append(bar);
      const els = options.map((o, i) => {
        const el = h('div', 'on-table-step');
        const name = (o.card != null ? state?.cards[o.card]?.name : undefined) ?? o.label;
        const minus = h('button', 'sub-btn icon', '−');
        minus.setAttribute('aria-label', `One less to ${name}`);
        const plus = h('button', 'sub-btn icon', '+');
        plus.setAttribute('aria-label', `One more to ${name}`);
        const value = h('div', 'share');
        minus.onclick = () => {
          if (shares[i] > min) shares[i]--;
          refresh();
        };
        plus.onclick = () => {
          if (shares[i] >= cap(i)) return;
          if (left() <= 0) {
            const from = options.map((_, j) => j).reverse().find((j) => j !== i && shares[j] > min);
            if (from === undefined) return;
            shares[from]--;
          }
          shares[i]++;
          refresh();
        };
        el.append(minus, value, plus);
        layer.append(el);
        return { el, value, minus, plus };
      });
      const refresh = () => {
        els.forEach((e, i) => {
          e.value.textContent = String(shares[i]);
          e.minus.disabled = shares[i] <= min;
          e.plus.disabled = shares[i] >= cap(i);
        });
        note.textContent = left() > 0 ? `${left()} left` : 'All assigned';
        confirm.disabled = left() !== 0;
      };
      let frame = 0;
      const follow = () => {
        if (!layer.isConnected) return; // the game was left
        // steppers on neighbouring cards are kept from covering each other
        const taken: { x: number; y: number }[] = [];
        options.forEach((o, i) => {
          const p = place(o);
          if (!p) return;
          const at = { x: Math.max(80, Math.min(window.innerWidth - 80, p.x)), y: Math.max(40, Math.min(window.innerHeight - 120, p.y)) };
          while (taken.some((t) => Math.abs(t.x - at.x) < 140 && Math.abs(t.y - at.y) < 46)) at.y += 48;
          taken.push(at);
          els[i].el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px) translate(-50%, -50%)`;
        });
        frame = requestAnimationFrame(follow);
      };
      confirm.onclick = () => {
        cancelAnimationFrame(frame);
        layer.remove();
        resolve([...shares]);
      };
      refresh();
      this.root.append(layer);
      follow();
      confirm.focus();
    });
  }

  /** Split an amount among targets: +/− per row, confirm once the whole amount is placed. */
  private buildDistribute(req: RequestMsg, state: GameState | null, panel: HTMLElement, done: (v: unknown) => void): void {
    const options = req.options ?? [];
    const total = req.amount ?? 0;
    const min: number = req.atLeastOne ? 1 : 0;
    const combat = !!req.combat;
    // combat starts from the automatic split (lethal to each blocker in turn); anything else from an even one
    const shares: number[] = options.map((o) => (combat ? o.initial ?? 0 : min));
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
    // trample: nothing reaches the defender until every blocker has been assigned lethal damage
    const blockersLethal = () => options.every((o, i) => o.defender || shares[i] >= (o.lethal ?? 0));
    const defenderLocked = (i: number) => combat && !!options[i].defender && !req.freeDefender && !blockersLethal();
    const refresh = () => {
      const used = shares.reduce((a, b) => a + b, 0);
      const early = options.some((_, i) => defenderLocked(i) && shares[i] > 0);
      remaining.textContent = early
        ? 'Every blocker needs lethal damage before any can trample over'
        : used === total ? 'All assigned' : `${total - used} left to assign`;
      remaining.classList.toggle('warn', early);
      confirm.disabled = used !== total || early;
      rows.forEach((r, i) => {
        r.querySelector('.share')!.textContent = String(shares[i]);
        const o = options[i];
        if (combat && !o.defender) r.classList.toggle('lethal', shares[i] >= (o.lethal ?? Infinity));
        if (combat && o.defender) r.classList.toggle('locked', defenderLocked(i));
      });
    };
    options.forEach((o, i) => {
      const known = o.card != null ? state?.cards[o.card] : undefined;
      const card = known?.visible ? known : o.cardData ?? known;
      const player = o.player != null ? state?.players.find((p) => p.id === o.player) : undefined;
      const row = h('div', 'dist-row');
      const label = h('div', 'dist-label', player ? `${player.name} (${player.life} life)` : card?.name ?? o.label);
      if (o.color) label.classList.add(`pip-${o.color}`, 'dist-color');
      if (combat && o.defender) label.append(h('span', 'dist-note', 'tramples over'));
      else if (combat && o.lethal != null) {
        const pt = card?.power !== undefined ? `${card.power}/${card.toughness} · ` : '';
        label.append(h('span', 'dist-note', `${pt}${o.lethal} kills it`));
      }
      const minus = h('button', 'sub-btn icon', '−');
      const plus = h('button', 'sub-btn icon', '+');
      minus.onclick = () => {
        if (shares[i] > min) shares[i]--;
        refresh();
      };
      plus.onclick = () => {
        if (defenderLocked(i)) return;
        if (shares.reduce((a, b) => a + b, 0) < total && shares[i] < (o.max ?? total)) shares[i]++;
        // in combat the total is always fully placed: a point added here comes off the last row that can spare one
        else if (combat && shares[i] < total) {
          const from = [...options.keys()].reverse().find((j) => j !== i && shares[j] > 0);
          if (from != null) {
            shares[from]--;
            shares[i]++;
          }
        }
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
