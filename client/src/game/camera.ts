import * as THREE from 'three';
import type { GameEvent, GameState, Ref, Selection } from '../protocol';
import { HOME_VIEW, type CameraView, type Stage } from '../scene/stage';
import { computeLayout, seatFrames, tableMats, type SeatFrame } from '../scene/layout';
import { CARD_H } from '../scene/cardMesh';

/**
 * Multiplayer camera. The table is too big to read all at once, so the camera glides between an
 * overview and closer views of one or two seats: the player whose turn it is, the two sides of a combat,
 * everything a prompt asks you to pick from. You can take over at any time (view bar, number keys,
 * mouse wheel, clicking a player's plate); your choice holds until the next turn begins, except that an
 * attack or a spell aimed at another player always pulls back to show both sides and what happens, then
 * returns to your view.
 * Duels keep Arena's fixed camera.
 */

export type ViewMode = { kind: 'table' } | { kind: 'seats'; players: number[] };

const AUTO_KEY = 'mtg-tabletop.autoCamera';

/** Screen area (normalised -1..1) a framed view should fill; the bottom is left to your hand. */
const REGION_TABLE = { x0: -0.96, x1: 0.96, y0: -0.6, y1: 0.86 };
const REGION_SEATS = { x0: -0.9, x1: 0.9, y0: -0.45, y1: 0.84 };
const REGION_LOCAL = { x0: -0.92, x1: 0.92, y0: -0.6, y1: 0.8 };

export class CameraDirector {
  auto = true;
  mode: ViewMode = { kind: 'table' };
  /** a view the player chose; auto framing waits until the next turn */
  private manual = false;
  private manualMode: ViewMode = { kind: 'table' };
  /** seats of the attack or targeted spell being shown ('' when none) */
  private actionKey = '';
  /** going back to the previous view a moment after an action ends, so its result is seen */
  private restoreTimer = 0;
  /** how long the result of an attack or spell stays framed before the camera goes back */
  private static readonly RESULT_HOLD_MS = 1600;
  private frames: SeatFrame[] = [];
  /** the latest game state, for framing a seat around the cards actually on its battlefield */
  private state: GameState | null = null;
  /** how many cards the framed seat had when it was framed; a change re-frames it */
  private framedCount = -1;
  private localId = -1;
  private activePlayer: number | null = null;
  /** what the current prompt needs on screen, so it isn't re-framed on every update */
  private promptKey = '';
  private lastKey = '';
  /** the view bar listens here */
  onChange: (() => void) | null = null;

  constructor(private readonly stage: Stage) {
    try {
      this.auto = localStorage.getItem(AUTO_KEY) !== 'off';
    } catch {
      /* default on */
    }
    window.addEventListener('resize', () => this.multiplayer && this.go(this.mode, 0));
  }

  get multiplayer(): boolean {
    return this.frames.length > 2;
  }

  get seats(): SeatFrame[] {
    return this.frames;
  }

  /** A new game: back to the duel camera until the seats are known. */
  reset(): void {
    this.frames = [];
    this.manual = false;
    this.promptKey = '';
    this.lastKey = '';
    this.actionKey = '';
    clearTimeout(this.restoreTimer);
    this.activePlayer = null;
    this.mode = { kind: 'table' };
    this.stage.setView(HOME_VIEW, 0);
    this.onChange?.();
  }

  /** Called with every update before it animates, so the camera is already looking where things happen. */
  update(state: GameState, localId: number, events: GameEvent[], selection: Selection, targetable: Set<number> = new Set()): void {
    this.state = state;
    if (this.frames.length !== state.players.length || this.localId !== localId) {
      this.localId = localId;
      this.frames = seatFrames(state, localId);
      if (this.multiplayer) {
        this.stage.setTableLayout(tableMats(state, localId), { x: 0, z: 0, r: 14 });
        this.go({ kind: 'table' }, 0);
      } else {
        const mats = tableMats(state, localId);
        if (mats.length === 2) this.stage.setTableLayout(mats, { x: 0, z: -1.25, r: 9 });
        this.stage.setView(HOME_VIEW, 0);
      }
      this.onChange?.();
    }
    if (!this.multiplayer) return;
    // an opponent's board framed on its own grows or shrinks: keep it filling the view
    if (this.mode.kind === 'seats' && this.mode.players.length === 1 && this.mode.players[0] !== localId) {
      const n = state.players.find((p) => p.id === (this.mode as { players: number[] }).players[0])?.zones.Battlefield.length ?? -1;
      if (this.framedCount >= 0 && n !== this.framedCount) this.stage.setView(this.viewFor(this.mode), 0.6);
    }

    const turnBegan = events.find((e) => e.event === 'TurnBegan');
    if (turnBegan) {
      this.manual = false;
      this.promptKey = '';
      this.activePlayer = (turnBegan.turnOwner as Ref)?.player ?? state.activePlayer;
    } else if (this.activePlayer == null) {
      this.activePlayer = state.activePlayer;
    }
    if (!this.auto) return;

    // 1. a prompt that needs things on screen: frame every seat it involves (unless you've picked a view)
    const hadPrompt = this.promptKey !== '';
    if (!this.manual) {
      const needed = this.seatsNeeded(state, selection, targetable);
      const key = [...needed].sort().join(',');
      if (needed.size > 0) {
        if (key !== this.promptKey) {
          this.promptKey = key;
          this.frameSeats([...needed]);
        }
        return;
      }
      this.promptKey = '';
    }

    // 2. an attack, or a spell or ability aimed at another player: always pull back to show both sides
    //    (even over a view you picked), and hold on the result for a moment once it's over
    const sides = this.actionSeats(state);
    if (sides.size > 1) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = 0;
      const key = [...sides].sort().join(',');
      if (key !== this.actionKey) {
        this.actionKey = key;
        this.frameSeats([...sides]);
      }
      return;
    }
    if (this.actionKey) {
      this.actionKey = '';
      clearTimeout(this.restoreTimer);
      this.restoreTimer = window.setTimeout(() => {
        this.restoreTimer = 0;
        if (this.actionKey || !this.auto) return;
        if (this.manual) this.go(this.manualMode);
        else this.frameTurn();
      }, CameraDirector.RESULT_HOLD_MS);
      return;
    }
    if (this.restoreTimer || this.manual) return;

    // 3. otherwise: the player whose turn it is (your own turn shows the whole table)
    if (turnBegan || hadPrompt || this.lastKey === '') this.frameTurn();
  }

  /**
   * Seats involved in what's happening between players: an attack (attacker and everyone attacked) or
   * the next spell/ability on the stack that targets another player or their permanents.
   */
  private actionSeats(state: GameState): Set<number> {
    const out = new Set<number>();
    const attacks = state.combat ?? [];
    if (attacks.length && state.activePlayer != null) {
      out.add(state.activePlayer);
      for (const a of attacks) {
        const pid = a.defender?.player ?? (a.defender?.card != null ? state.cards[a.defender.card]?.controller : null);
        if (pid != null) out.add(pid);
      }
      return out;
    }
    for (const item of state.stack) {
      if (item.controller == null) continue;
      const seats = new Set<number>([item.controller]);
      for (const t of item.targets) {
        const pid = t?.player ?? (t?.card != null ? state.cards[t.card]?.controller : null);
        if (pid != null) seats.add(pid);
      }
      if (seats.size > 1) return seats;
    }
    return out;
  }

  /** The player picked a view. */
  choose(mode: ViewMode): void {
    if (!this.multiplayer) return;
    this.manual = true;
    this.manualMode = mode;
    // a view picked mid-action wins until the next action
    this.actionKey = '';
    clearTimeout(this.restoreTimer);
    this.restoreTimer = 0;
    this.go(mode);
  }

  /** Back to automatic framing right away. */
  setAuto(on: boolean): void {
    this.auto = on;
    try {
      localStorage.setItem(AUTO_KEY, on ? 'on' : 'off');
    } catch {
      /* not remembered */
    }
    if (on) {
      this.manual = false;
      this.promptKey = '';
      this.actionKey = '';
      this.frameTurn();
    }
    this.onChange?.();
  }

  focusPlayer(pid: number): void {
    this.choose({ kind: 'seats', players: [pid] });
  }

  showTable(): void {
    this.choose({ kind: 'table' });
  }

  isShowing(pid: number | 'table'): boolean {
    if (pid === 'table') return this.mode.kind === 'table';
    return this.mode.kind === 'seats' && this.mode.players.length === 1 && this.mode.players[0] === pid;
  }

  private frameTurn(): void {
    const pid = this.activePlayer;
    if (pid == null || pid === this.localId) this.go({ kind: 'table' });
    else this.go({ kind: 'seats', players: [pid] });
  }

  private frameSeats(players: number[]): void {
    if (players.length >= this.frames.length) this.go({ kind: 'table' });
    else this.go({ kind: 'seats', players });
  }

  /** Seats whose cards or player the current prompt lets you pick. */
  private seatsNeeded(state: GameState, sel: Selection, targetable: Set<number>): Set<number> {
    const out = new Set<number>();
    for (const id of sel.cards) {
      const c = state.cards[id];
      if (c?.zone === 'Battlefield' && c.controller != null) out.add(c.controller);
    }
    for (const t of sel.targets) if (t?.player != null) out.add(t.player);
    // includes every possible defender while you declare attackers
    for (const pid of targetable) out.add(pid);
    // choosing among your own permanents only (paying costs, blocking with nothing to block) doesn't move anything
    if (out.size === 1 && out.has(this.localId)) out.clear();
    if (out.size > 0 && state.activePlayer != null && state.combat?.length) out.add(state.activePlayer);
    return out;
  }

  private go(mode: ViewMode, duration = 0.95): void {
    const key = mode.kind === 'table' ? 'table' : [...mode.players].sort().join(',');
    const changed = key !== this.lastKey;
    this.mode = mode;
    this.lastKey = key;
    if (changed || duration === 0) this.stage.setView(this.viewFor(mode), duration);
    if (changed) this.onChange?.();
  }

  private viewFor(mode: ViewMode): CameraView {
    if (mode.kind === 'table' || mode.players.length === 0) {
      return this.fit(this.frames.flatMap((f) => f.corners), 0, 1.24, REGION_TABLE);
    }
    const frames = this.frames.filter((f) => mode.players.includes(f.playerId));
    if (frames.length === 0) return this.viewFor({ kind: 'table' });
    const pts = frames.flatMap((f) => f.corners);
    if (frames.length === 1) {
      // one seat, seen the way a duel shows it (an opponent's cards upright)
      const f = frames[0];
      if (f.local) {
        // your own side sits just above your hand, with some of the table in front of it
        const toCentre = f.center.clone().negate().setY(0).normalize();
        pts.push(f.center.clone().addScaledVector(toCentre, 14));
        return this.fit(pts, f.rotY, 1.2, REGION_LOCAL);
      }
      // an opponent's turn: close in on the cards on their battlefield, so they can be read
      this.framedCount = this.state?.players.find((p) => p.id === f.playerId)?.zones.Battlefield.length ?? -1;
      return this.fit(this.boardPoints(f), f.rotY, 1.2, REGION_SEATS);
    }
    // several seats: whichever direction frames them closest, preferring your own point of view
    const yaws = [0, this.meanAngle(frames.map((f) => f.rotY)), ...frames.map((f) => f.rotY)];
    let best: CameraView | null = null;
    let bestScore = Infinity;
    for (const yaw of new Set(yaws.map((y) => Math.round(y * 1000) / 1000))) {
      const v = this.fit(pts, yaw, 1.22, REGION_SEATS);
      const score = v.dist * (Math.abs(yaw) < 1e-3 ? 1 : 1.12);
      if (score < bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best!;
  }

  /**
   * The area to frame for one opponent's seat: where their battlefield cards come to rest (with a card's
   * margin round each), widened to at least ~60% of their mat so a near-empty board isn't framed huge.
   * Falls back to the seat's whole footprint when there's no state yet.
   */
  private boardPoints(f: SeatFrame): THREE.Vector3[] {
    const state = this.state;
    const player = state?.players.find((p) => p.id === f.playerId);
    if (!state || !player) return f.corners;
    const layout = computeLayout(state, this.localId, { hoveredHand: null, handOrder: [] });
    const pts: THREE.Vector3[] = [];
    for (const id of player.zones.Battlefield) {
      const at = layout.get(id);
      if (!at || at.space !== 'table') continue;
      const m = (CARD_H / 2) * at.scale + 0.4;
      for (const [dx, dz] of [[-m, -m], [m, -m], [m, m], [-m, m]]) pts.push(at.pos.clone().add(new THREE.Vector3(dx, 0, dz)));
    }
    // the seat's own left-right axis, from its footprint corners
    const axis = f.corners[1].clone().sub(f.corners[0]);
    const minHalf = axis.length() * 0.3;
    axis.normalize();
    const mid = pts.length ? pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length) : f.center.clone();
    pts.push(mid.clone().addScaledVector(axis, minHalf), mid.clone().addScaledVector(axis, -minHalf));
    return pts;
  }

  /** Circular mean; opposite seats (no sensible middle) look from your side. */
  private meanAngle(a: number[]): number {
    const x = a.reduce((s, v) => s + Math.cos(v), 0);
    const z = a.reduce((s, v) => s + Math.sin(v), 0);
    if (Math.hypot(x, z) < 1e-3 * a.length) return 0;
    return Math.atan2(z, x);
  }

  /**
   * The closest view from a given direction that fits the points into a screen region:
   * search the distance, then slide the target to centre them, and repeat.
   */
  private fit(points: THREE.Vector3[], yaw: number, pitch: number, region: typeof REGION_TABLE): CameraView {
    const center = points.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / points.length);
    const view: CameraView = { target: center.clone(), yaw, dist: 60, pitch };
    const rw = region.x1 - region.x0;
    const rh = region.y1 - region.y0;
    const rcx = (region.x0 + region.x1) / 2;
    const rcy = (region.y0 + region.y1) / 2;
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const bounds = (v: CameraView) => {
      const pr = this.stage.projectFrom(v, points);
      const xs = pr.map((p) => p.x);
      const ys = pr.map((p) => p.y);
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    };
    for (let iter = 0; iter < 5; iter++) {
      let lo = 12;
      let hi = 260;
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2;
        const b = bounds({ ...view, dist: mid });
        if (b.x1 - b.x0 <= rw && b.y1 - b.y0 <= rh) hi = mid;
        else lo = mid;
      }
      view.dist = hi;
      const b = bounds(view);
      const halfH = Math.tan(THREE.MathUtils.degToRad(this.stage.camera.fov / 2)) * view.dist;
      const dx = (b.x0 + b.x1) / 2 - rcx;
      const dy = (b.y0 + b.y1) / 2 - rcy;
      view.target.addScaledVector(right, dx * halfH * this.stage.camera.aspect);
      view.target.addScaledVector(forward, (dy * halfH) / Math.sin(pitch));
    }
    return view;
  }
}
