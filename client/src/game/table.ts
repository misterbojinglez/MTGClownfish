import * as THREE from 'three';
import gsap from 'gsap';
import type { CardState, GameEvent, GameState, Prompt, Ref, Selection, UpdateMsg, ZoneName } from '../protocol';
import { CARD_H, CARD_W, CardObject, type Highlight } from '../scene/cardMesh';
import { avatarAnchor, computeLayout, libraryAnchor, libraryHeight, nearestHandSlot, seatAt, seatFrames, seatRotation, seatsFor, tableMats, type Placement } from '../scene/layout';
import { Arrows, colorFor, floatText, Fx, type LinkMark } from '../scene/fx';
import { CommandAura } from '../scene/commandAura';
import { Magic } from '../scene/magic';
import { SPOT_POS, SPOT_SCALE, Spotlight } from '../scene/spotlight';
import { Collapse } from '../scene/collapse';
import { settings } from '../settings';
import { sfx } from '../audio';
import type { Stage } from '../scene/stage';
import { cardBackTexture } from '../scene/textures';

/**
 * Seconds for each zone transition, from Arena's SplineMovementData speeds (duration ≈ 1/speed),
 * see docs/arena-reference.md. Keys are "from>to".
 */
const MOVE_TIME: Record<string, number> = {
  'Hand>Stack': 0.5,
  'Stack>Battlefield': 0.57,
  'Hand>Battlefield': 0.33,
  'Library>Hand': 0.9,
  'Stack>Graveyard': 0.5,
  'Battlefield>Hand': 0.7,
  'Graveyard>Hand': 0.8,
  'Command>Stack': 0.5,
  'Stack>Command': 0.6,
  'Battlefield>Command': 0.6,
};
const DEFAULT_MOVE = 0.8;

/** Zones we draw; a card reported in one of these but not yet listed there is mid-move. */
const IN_TRANSIT_ZONES = new Set<string>(['Stack', 'Battlefield', 'Hand', 'Graveyard', 'Exile', 'Command']);

const EASE: Record<string, string> = {
  'Hand>Stack': 'power2.out',
  'Stack>Battlefield': 'back.out(1.15)',
  'Hand>Battlefield': 'power3.in',
  'Library>Hand': 'power2.inOut',
};

/** Arena tiers its combat lunge by power: weaker creatures strike fast, big ones wind up. */
function strikeTiming(power: number): { strike: number; ret: number } {
  if (power <= 1) return { strike: 1 / 3, ret: 1 / 1.5 };
  if (power <= 3) return { strike: 1 / 2.5, ret: 1 / 1.25 };
  if (power <= 7) return { strike: 1 / 2.0, ret: 1 / 0.6 / 2 };
  return { strike: 1 / 1.5, ret: 1 / 0.5 / 2 };
}

interface Snapshot {
  zone: ZoneName | null;
  world: THREE.Matrix4;
}

export class Table {
  readonly cards = new Map<number, CardObject>();
  state: GameState | null = null;
  prompt: Prompt = { message: '' };
  selection: Selection = { cards: [], min: 0, max: 0, targets: [], chosen: [], actionable: [] };
  localId = -1;
  hoveredHand: number | null = null;
  /** your commander in its slot by the hand, while hovered (it grows in place) */
  hoveredCommand: number | null = null;
  handOrder: number[] = [];
  /** >1 when the update queue is backed up and animations should hurry. */
  timeScale = 1;
  private hitStopToken = 0;
  /** life shown on a plate ahead of the engine: set when a blow lands, cleared once the engine's total moves */
  private lifeShown = new Map<number, { value: number; base: number; at: number }>();
  /** Set by the app: shows an opponent's spell and resolves when the player has seen it. */
  onOpponentCast: ((card: CardState, who: string) => Promise<void>) | null = null;
  /** Set by the app: a player took damage (their plate reacts). */
  onPlayerHit: ((pid: number, amount: number) => void) | null = null;

  private readonly fx: Fx;
  private readonly magic: Magic;
  private readonly spotlight: Spotlight;
  private readonly collapse: Collapse;
  /** players whose mats have collapsed (they lost): nothing of theirs is drawn on the table any more */
  private readonly sunk = new Set<number>();
  /** cards sinking (or sunk) into a collapsed mat, each resolving when it has gone */
  private readonly buried = new Map<number, Promise<void>>();
  /** collapses still playing (the game-over screen waits for them) */
  private readonly collapsing = new Set<Promise<void>>();
  private readonly arrows: Arrows;
  /** the arrow drawn while dragging an attacker or blocker toward its target */
  private readonly aimArrows: Arrows;
  /** the frame and rising aura around your commander in its slot by the hand */
  private readonly commandAura: CommandAura;
  private aimCard: number | null = null;
  /** your creatures picked with a selection box while declaring attackers or blockers, to be sent together */
  readonly group = new Set<number>();
  /** spells on the stack that have tucked away into the Stack panel (hidden until they leave the stack) */
  private readonly tucked = new Set<number>();
  /** commanders on the stack that have had their spotlight (one per cast) */
  private readonly spotlit = new Set<number>();
  private readonly libraries = new Map<number, THREE.Mesh>();
  private readonly flying = new Set<number>();
  /** cards in flight, resolving when each lands (effects on a card wait for it to arrive) */
  private readonly landings = new Map<number, Promise<void>>();
  private layout = new Map<number, Placement>();
  /** Invisible, unmoving click targets for hand cards at their resting slots. */
  private readonly handZones = new Map<number, THREE.Mesh>();
  private readonly zoneGeo = new THREE.PlaneGeometry(CARD_W, CARD_H);
  private readonly zoneMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });

  constructor(private readonly stage: Stage) {
    this.fx = new Fx(stage);
    this.spotlight = new Spotlight(stage);
    this.magic = new Magic(stage);
    this.collapse = new Collapse(stage, this.magic);
    this.arrows = new Arrows(stage);
    this.aimArrows = new Arrows(stage);
    this.commandAura = new CommandAura(stage);
    stage.onTick((dt) => {
      for (const c of this.cards.values()) c.tick(dt);
      this.followBadges();
      this.syncCommandAura();
    });
  }

  reset(): void {
    for (const t of this.topLeaving.values()) window.clearTimeout(t);
    this.topLeaving.clear();
    for (const c of this.cards.values()) c.dispose();
    this.cards.clear();
    this.tucked.clear();
    this.spotlit.clear();
    this.collapse.clear();
    this.commandAura.clear();
    this.sunk.clear();
    this.buried.clear();
    for (const m of this.libraries.values()) m.removeFromParent();
    this.libraries.clear();
    this.state = null;
    this.handOrder = [];
    this.arrowSpecs = [];
    this.arrows.set([]);
  }

  // ---- update pipeline ----------------------------------------------------------------------------

  async apply(msg: UpdateMsg): Promise<void> {
    const prev = this.state;
    const snapshots = new Map<number, Snapshot>();
    for (const [id, obj] of this.cards) {
      obj.root.updateWorldMatrix(true, false);
      snapshots.set(id, { zone: obj.state.zone, world: obj.root.matrixWorld.clone() });
    }

    // merge the card delta into our cache
    const cards: Record<string, CardState> = { ...(prev?.cards ?? {}) };
    for (const [id, c] of Object.entries(msg.state.cards)) cards[id] = c;
    if (prev) this.stateSounds(prev, msg.state.cards);
    const state: GameState = { ...msg.state, cards };
    this.state = state;
    for (const [pid, shown] of this.lifeShown) {
      const life = state.players.find((p) => p.id === pid)?.life;
      if (life !== shown.base) this.lifeShown.delete(pid);
    }
    // players about to take combat damage keep showing their old total until each blow visibly lands
    for (const e of msg.events) {
      const pid = e.event === 'PlayerDamaged' && e.combat ? (e.target as Ref)?.player : undefined;
      if (pid == null || this.lifeShown.has(pid)) continue;
      const before = prev?.players.find((p) => p.id === pid)?.life;
      const base = state.players.find((p) => p.id === pid)?.life;
      if (before != null && base != null) this.lifeShown.set(pid, { value: before, base, at: performance.now() });
    }
    this.prompt = msg.prompt;
    this.selection = msg.selection;

    // a player who has just lost: their mat collapses into magma (a scar already, if it happened before we joined)
    const losses: Promise<void>[] = [];
    for (const p of state.players) {
      if (!p.lost || this.sunk.has(p.id)) continue;
      this.sunk.add(p.id);
      if (prev) losses.push(this.playerLost(p.id, state));
      else this.lostMat(p.id, state, false);
    }

    const visibleIds = this.visibleCardIds(state);
    const fromLibrary = new Set<number>();
    for (const id of visibleIds) {
      const c = cards[id];
      if (!c) continue;
      let obj = this.cards.get(id);
      if (!obj) {
        obj = new CardObject(c);
        this.cards.set(id, obj);
        const top = c.zone === 'Library';
        if (this.spawn(obj, c, prev) && !top) fromLibrary.add(id);
        if (top && prev) void this.turnOver(obj, true);
      } else {
        const was = obj.state;
        obj.update(c);
        if (was.zone === 'Battlefield' && c.zone === 'Battlefield' && was.state !== c.state && was.name !== c.name) this.transform(obj);
      }
    }

    this.layout = computeLayout(state, this.localId, this.layoutOpts());
    this.updateLibraries(state);
    this.updateHandZones();

    const tasks: Promise<void>[] = [...losses];
    const deaths = new Set<number>();
    for (const e of msg.events) this.collectDeaths(e, snapshots, deaths);
    // with combat damage in this update, creatures die only after every blow has landed and been seen,
    // and a creature that trades still gets to make its strike
    const combatDamage = msg.events.some((e) => (e.event === 'PlayerDamaged' && e.combat) || e.event === 'CardDamaged');
    let releaseDeaths: () => void = () => {};
    const deathsGo = combatDamage ? new Promise<void>((r) => (releaseDeaths = r)) : Promise.resolve();

    for (const [id, obj] of this.cards) {
      if (!visibleIds.has(id)) {
        // A card between zones (cast but not yet on the stack, etc.) stays where it is until it lands;
        // only a card that really went to its library or out of the game leaves the table.
        const zone = cards[id]?.zone;
        // ...except tokens (copies of cards and spells count): they exist only on the battlefield and the stack,
        // so one listed in neither has ceased to exist and will never be listed again. Its last report can still
        // say Stack or Battlefield (a copied spell that resolved, a token that died and left the graveyard within
        // one update), so it can't wait to land.
        const tokenGone = !!cards[id]?.token;
        if (zone && IN_TRANSIT_ZONES.has(zone) && !tokenGone) continue;
        // The top of a library, no longer shown: the engine can take it out and put it straight back (a scry that
        // keeps it, a permission being worked out again), so it waits there a moment before turning face down.
        // A new top card showing replaces it at once.
        if (zone === 'Library' && obj.state.zone === 'Library') {
          const replaced = state.players.some((p) => p.id === obj.state.owner && p.zones.LibraryTop != null);
          if (replaced) this.dropTop(obj);
          else if (!this.topLeaving.has(id)) this.concealLater(obj);
          continue;
        }
        const snap = snapshots.get(id);
        tasks.push(tokenGone ? deathsGo.then(() => this.vanish(obj, prev, snap)) : this.vanish(obj, prev, snap));
        continue;
      }
      if (deaths.has(id)) {
        const snap = snapshots.get(id)!;
        tasks.push(deathsGo.then(() => this.dieThenPlace(obj, snap)));
        continue;
      }
      const target = this.layout.get(id);
      if (!target) continue;
      const before = snapshots.get(id);
      const zoneChanged = before && before.zone !== obj.state.zone;
      this.keepTop(obj);
      // the Stack panel shows what's on the stack: a spell flies toward it, then tucks away into it;
      // leaving the stack, it shows again on its way to wherever it goes
      if (obj.state.zone !== 'Stack' && this.tucked.delete(id)) {
        gsap.killTweensOf(obj.root.scale);
        obj.root.visible = true;
        obj.root.scale.setScalar(target.scale);
      }
      if (obj.state.zone !== 'Stack') this.spotlit.delete(id);
      if (this.spotlightFor(obj, state)) tasks.push(this.commanderCast(obj, zoneChanged ? before.zone : 'Stack', target));
      else if (zoneChanged && obj.state.zone === 'Stack') tasks.push(this.fly(obj, before.zone, obj.state.zone, target).then(() => this.tuckIntoStack(obj)));
      else if (zoneChanged) tasks.push(this.fly(obj, before.zone, obj.state.zone, target));
      else if (fromLibrary.has(id)) tasks.push(this.fly(obj, 'Library' as ZoneName, obj.state.zone, target));
      else if (!this.flying.has(id)) this.settle(obj, target, before ? 0.28 : 0);
    }

    tasks.push(this.playEvents(msg.events, snapshots).finally(releaseDeaths));
    if (prev) this.resolutions(prev, state, msg.events, snapshots);
    this.refreshHighlights();
    this.refreshArrows();
    this.refreshSpeedMarks(state);
    await Promise.all(tasks);
  }

  /**
   * Spells and abilities that left the stack: their colours fly from the source to each target (damage
   * has its own bolt), and an untargeted spell blooms over its caster's side of the table.
   */
  private resolutions(prev: GameState, state: GameState, events: GameEvent[], snaps: Map<number, Snapshot>): void {
    const still = new Set(state.stack.map((x) => x.id));
    const damaged = new Set<string>();
    for (const e of events) {
      if (e.event === 'CardDamaged') damaged.add(`c${(e.card as Ref)?.card}`);
      if (e.event === 'PlayerDamaged') damaged.add(`p${(e.target as Ref)?.player}`);
    }
    for (const item of prev.stack) {
      if (still.has(item.id) || item.source == null) continue;
      const colors = state.cards[item.source]?.colors ?? prev.cards[item.source]?.colors;
      const snap = snaps.get(item.source);
      const from = snap ? new THREE.Vector3().setFromMatrixPosition(snap.world) : this.cardWorld(item.source);
      let aimed = false;
      for (const t of item.targets) {
        if (t?.card != null && !damaged.has(`c${t.card}`)) {
          const to = this.layoutWorld(t.card);
          if (from && to) void this.magic.bolt(from, to, colors, 0.45 / this.timeScale, item.ability ? 0.6 : 1);
          aimed = true;
        } else if (t?.player != null && !damaged.has(`p${t.player}`)) {
          const to = this.playerArrowEnd(t.player);
          if (from && to) void this.magic.bolt(from, to, colors, 0.45 / this.timeScale, item.ability ? 0.6 : 1);
          aimed = true;
        } else if (t) {
          aimed = true;
        }
      }
      if (!aimed && !item.ability && item.controller != null) {
        const card = state.cards[item.source];
        // permanents get their entrance on landing; this is for instants and sorceries
        if (card && card.zone !== 'Battlefield' && card.zone !== 'Stack') {
          const seat = seatFrames(state, this.localId).find((f) => f.playerId === item.controller);
          if (seat) this.magic.burst(seat.center.clone().setY(0.2), colors, 1.1);
        }
      }
    }
  }

  /** Re-place everything without animation pacing (hover, selection changes). */
  relayout(duration = 0.18): void {
    if (!this.state) return;
    this.updateHandZones();
    this.layout = computeLayout(this.state, this.localId, this.layoutOpts());
    for (const [id, obj] of this.cards) {
      const t = this.layout.get(id);
      if (t && !this.flying.has(id)) this.settle(obj, t, duration);
    }
  }

  /**
   * Hand hit zones cover exactly where each card rests (as if nothing were hovered), so hovering never
   * reshuffles which card is under the pointer, and the table just above the hand stays clickable.
   * The popped-up card itself is hit-tested separately while it's hovered.
   */
  private updateHandZones(): void {
    const me = this.state?.players.find((p) => p.id === this.localId);
    const hand = new Set(me?.zones.Hand ?? []);
    for (const [id, zone] of this.handZones) {
      if (!hand.has(id)) {
        zone.removeFromParent();
        this.handZones.delete(id);
      }
    }
    if (!this.state || hand.size === 0) return;
    const rest = computeLayout(this.state, this.localId, { ...this.layoutOpts(), hoveredHand: null });
    for (const id of hand) {
      const p = rest.get(id);
      if (!p) continue;
      let zone = this.handZones.get(id);
      if (!zone) {
        zone = new THREE.Mesh(this.zoneGeo, this.zoneMat);
        zone.userData.cardId = id;
        this.stage.cameraRig.add(zone);
        this.handZones.set(id, zone);
      }
      zone.position.copy(p.pos);
      zone.rotation.copy(p.rot);
      zone.scale.setScalar(p.scale);
      zone.position.z += 0.001 * p.order;
    }
  }

  /**
   * A hand card dragged sideways takes the fan slot nearest it (rig-space x) and the rest slide over to
   * make room. The order sticks for the rest of the game; new cards join at the right.
   */
  moveHandCard(id: number, x: number): void {
    const me = this.state?.players.find((p) => p.id === this.localId);
    if (!me) return;
    const order = this.handOrder.filter((h) => me.zones.Hand.includes(h));
    for (const h of me.zones.Hand) if (!order.includes(h)) order.push(h);
    const from = order.indexOf(id);
    if (from < 0) return;
    const to = nearestHandSlot(order.length, x);
    if (to === from) return;
    order.splice(from, 1);
    order.splice(to, 0, id);
    this.handOrder = order;
    this.relayout(0.16);
  }

  /** The player picked up a hand card: stop layout from moving it and stand it upright. */
  beginDrag(id: number): void {
    const obj = this.cards.get(id);
    if (!obj) return;
    this.flying.add(id);
    gsap.killTweensOf(obj.root.position);
    gsap.killTweensOf(obj.root.scale);
    gsap.killTweensOf(obj.root.quaternion);
    const q0 = obj.root.quaternion.clone();
    const st = { t: 0 };
    gsap.to(st, { t: 1, duration: 0.12, onUpdate: () => { obj.root.quaternion.slerpQuaternions(q0, new THREE.Quaternion(), st.t); } });
  }

  /** Dropped: a played card waits for the engine to move it; otherwise it slides back into the fan. */
  endDrag(id: number, played: boolean): void {
    this.flying.delete(id);
    const obj = this.cards.get(id);
    const p = this.layout.get(id);
    if (!obj || !p) return;
    if (!played) this.settle(obj, p, 0.22);
    // if the engine refuses the play, the next update (or this fallback) returns the card
    else setTimeout(() => { if (this.isLocalHand(id) && !this.flying.has(id)) this.settle(obj, this.layout.get(id) ?? p, 0.25); }, 600);
  }

  handZoneMeshes(): THREE.Object3D[] {
    return [...this.handZones.values()];
  }

  private visibleCardIds(state: GameState): Set<number> {
    const ids = new Set<number>();
    for (const p of state.players) {
      for (const z of ['Battlefield', 'Graveyard', 'Exile', 'Command', 'Hand'] as const) p.zones[z].forEach((id) => ids.add(id));
      if (p.zones.LibraryTop != null) ids.add(p.zones.LibraryTop);
    }
    for (const s of state.stack) if (s.source != null && !s.ability) ids.add(s.source);
    return ids;
  }

  // ---- placement helpers --------------------------------------------------------------------------

  private parentFor(space: Placement['space']): THREE.Object3D {
    return space === 'rig' ? this.stage.cameraRig : this.stage.scene;
  }

  private targetWorld(p: Placement): THREE.Matrix4 {
    const m = new THREE.Matrix4().compose(p.pos, new THREE.Quaternion().setFromEuler(p.rot), new THREE.Vector3(p.scale, p.scale, p.scale));
    if (p.space === 'rig') {
      this.stage.cameraRig.updateWorldMatrix(true, false);
      m.premultiply(this.stage.cameraRig.matrixWorld);
    }
    return m;
  }

  /** A spell that reached the stack shrinks away into the Stack panel (which shows it from then on). */
  private tuckIntoStack(obj: CardObject): void {
    if (obj.state.zone !== 'Stack') return;
    // from here on, reflows leave it alone (see settle) until it leaves the stack
    this.tucked.add(obj.id);
    gsap.killTweensOf(obj.root.scale);
    gsap.to(obj.root.scale, {
      x: 0.01, y: 0.01, z: 0.01, duration: 0.35 / this.timeScale, delay: 0.25 / this.timeScale, ease: 'power2.in',
      onComplete: () => {
        if (obj.state.zone === 'Stack') obj.root.visible = false;
      },
    });
  }

  /** Tween a card to its placement within its current space (reflow, tap, hover). */
  private settle(obj: CardObject, p: Placement, duration: number): void {
    if (this.tucked.has(obj.id) && obj.state.zone === 'Stack') return;
    if (this.buried.has(obj.id)) return;
    obj.setSpace(p.space === 'table');
    const parent = this.parentFor(p.space);
    if (obj.root.parent !== parent) parent.attach(obj.root);
    const root = obj.root;
    gsap.killTweensOf(root.position);
    gsap.killTweensOf(root.scale);
    if (duration <= 0) {
      root.position.copy(p.pos);
      root.quaternion.setFromEuler(p.rot);
      root.scale.setScalar(p.scale);
      return;
    }
    const d = duration / this.timeScale;
    gsap.to(root.position, { x: p.pos.x, y: p.pos.y, z: p.pos.z, duration: d, ease: 'power2.out' });
    gsap.to(root.scale, { x: p.scale, y: p.scale, z: p.scale, duration: d, ease: 'power2.out' });
    const q0 = root.quaternion.clone();
    const q1 = new THREE.Quaternion().setFromEuler(p.rot);
    if (q0.angleTo(q1) > 0.001) {
      const st = { t: 0 };
      gsap.killTweensOf(root.quaternion);
      gsap.to(st, { t: 1, duration: d, ease: 'power2.out', onUpdate: () => { root.quaternion.slerpQuaternions(q0, q1, st.t); } });
    }
  }

  /** Arc a card from where it is (in world space) to its new zone. */
  private fly(obj: CardObject, from: ZoneName | null, to: ZoneName | null, p: Placement, override?: number): Promise<void> {
    const key = `${from}>${to}`;
    const duration = (override ?? MOVE_TIME[key] ?? DEFAULT_MOVE) / this.timeScale;
    const root = obj.root;
    this.flying.add(obj.id);
    this.stage.scene.attach(root);
    gsap.killTweensOf(root.position);
    gsap.killTweensOf(root.scale);

    const startPos = root.position.clone();
    const startQuat = root.quaternion.clone();
    const startScale = root.scale.x;
    const end = new THREE.Vector3();
    const endQuat = new THREE.Quaternion();
    const endScaleV = new THREE.Vector3();
    this.targetWorld(p).decompose(end, endQuat, endScaleV);

    const lift = key === 'Hand>Battlefield' ? 3 : 2.5 + startPos.distanceTo(end) * 0.12;
    const mid = startPos.clone().lerp(end, 0.5);
    mid.y = Math.max(startPos.y, end.y) + lift;
    const curve = new THREE.QuadraticBezierCurve3(startPos, mid, end);
    const trailColor = colorFor(obj.state.colors);
    const st = { t: 0 };
    const reveal = key === 'Library>Hand' && p.space === 'rig';
    const pan = this.panOf(startPos);
    if (to === 'Stack' && from !== 'Stack') sfx.cast(obj.state.colors, pan);
    else if (to === 'Hand') sfx.draw(pan, p.space !== 'rig');

    const landed = new Promise<void>((resolve) => {
      gsap.to(st, {
        t: 1,
        duration,
        // a commander arriving from the stack drops onto the table instead of settling (see the thunk below)
        ease: key === 'Stack>Battlefield' && obj.state.commander ? 'power3.in' : EASE[key] ?? 'power2.inOut',
        onUpdate: () => {
          // a card headed for the screen (hand, stack) chases its slot if the camera is moving
          if (p.space === 'rig') {
            this.targetWorld(p).decompose(end, endQuat, endScaleV);
            curve.v2.copy(end);
            curve.v1.copy(startPos).lerp(end, 0.5).setY(Math.max(startPos.y, end.y) + lift);
          }
          root.position.copy(curve.getPoint(Math.min(1, st.t)));
          root.quaternion.slerpQuaternions(startQuat, endQuat, Math.min(1, st.t));
          root.scale.setScalar(startScale + (endScaleV.x - startScale) * st.t);
          if (to === 'Stack' || from === 'Stack') {
            this.fx.trail(root.position, trailColor, 0.22);
            this.magic.trail(root.position, obj.state.colors, 0.8);
          }
        },
        onComplete: () => {
          this.flying.delete(obj.id);
          obj.setSpace(p.space === 'table');
          this.parentFor(p.space).attach(root);
          root.position.copy(p.pos);
          root.quaternion.setFromEuler(p.rot);
          root.scale.setScalar(p.scale);
          if (to === 'Battlefield') {
            const s = obj.state;
            if (s.land) sfx.land(this.panOf(end));
            else sfx.etb(s.colors, s.power ?? 0, this.panOf(end));
            this.fx.etb(end, colorFor(s.colors), p.scale * (s.creature ? 1 : 0.7));
            // anything cast arrives in its colours; bigger creatures make a bigger entrance
            if (!s.land && from === 'Stack') this.magic.burst(end, s.colors, s.creature ? 0.8 + Math.min(0.8, (s.power ?? 0) / 6) : 0.65);
            if (s.commander && from === 'Stack') this.commanderLands(end, s.colors, p.scale);
            else if (s.creature && (s.power ?? 0) >= 5) this.stage.addShake(0.35);
          }
          else if (to === 'Graveyard' || to === 'Exile' || to === 'Command') sfx.place(this.panOf(end));
          if (reveal) obj.body.position.set(0, 0, 0);
          if (this.landings.get(obj.id) === landed) this.landings.delete(obj.id);
          resolve();
        },
      });
      if (reveal) {
        // a drawn card lifts toward the player, pauses, then drops into the fan
        gsap.fromTo(obj.body.position, { z: 0 }, { z: 2.2, duration: duration * 0.5, yoyo: true, repeat: 1, ease: 'sine.inOut' });
      }
    });
    this.landings.set(obj.id, landed);
    return landed;
  }

  /**
   * Whether a card gets the commander spotlight now: a commander whose cast just completed (it's on the stack
   * as a spell, so paid for: Forge moves a card to the stack before its costs are paid, and the player may
   * still cancel), once per cast, with effects on.
   */
  private spotlightFor(obj: CardObject, state: GameState): boolean {
    const s = obj.state;
    if (!s.commander || !s.visible || s.zone !== 'Stack' || this.spotlit.has(obj.id) || settings.particles === 'off') return false;
    if (!state.stack.some((x) => x.source === obj.id && !x.ability)) return false;
    this.spotlit.add(obj.id);
    return true;
  }

  /**
   * A commander is cast: it rises to the middle of the screen and holds there for a moment while a waterfall
   * of light pours down behind it and the screen's fringes darken (Spotlight), then goes on to the stack.
   */
  private async commanderCast(obj: CardObject, from: ZoneName | null, target: Placement): Promise<void> {
    const hold: Placement = { space: 'rig', pos: SPOT_POS.clone(), rot: new THREE.Euler(0, 0, 0, 'YXZ'), scale: SPOT_SCALE, faceUp: true, order: 2000 };
    // paid for after it reached the stack: it rises back out of the Stack panel
    if (this.tucked.delete(obj.id)) {
      gsap.killTweensOf(obj.root.scale);
      obj.root.visible = true;
    }
    sfx.commander(obj.state.colors);
    await this.fly(obj, from, 'Stack', hold, 0.6);
    // held: reflows leave it be until it moves on
    this.flying.add(obj.id);
    const colors = obj.state.colors;
    const glint = new THREE.Vector3();
    let acc = 0;
    const stopGlints = this.stage.onTick((dt) => {
      // glints drift down the light, a few a frame
      acc += dt * 26;
      for (; acc >= 1; acc--) this.magic.trail(this.spotlight.randomPointInLight(glint), colors, 0.5);
    });
    // it breathes a little while it's held
    const breathe = gsap.to(obj.body.position, { z: 0.35, duration: 0.75, yoyo: true, repeat: 1, ease: 'sine.inOut' });
    await this.spotlight.play(colors, 1.5 / this.timeScale);
    stopGlints();
    breathe.kill();
    obj.body.position.set(0, 0, 0);
    this.flying.delete(obj.id);
    if (obj.state.zone !== 'Stack') return;
    await this.fly(obj, 'Stack', 'Stack', this.layout.get(obj.id) ?? target, 0.45);
    this.tuckIntoStack(obj);
  }

  /** A commander lands on the battlefield: a heavy thunk, a beat of slow motion, a small shake and a burst. */
  private commanderLands(at: THREE.Vector3, colors: string | undefined, scale: number): void {
    sfx.thunk(this.panOf(at));
    this.hitStop(0.12);
    this.stage.addShake(0.42);
    this.fx.etb(at, colorFor(colors), scale * 1.5);
  }

  /**
   * A player lost: their mat collapses into magma and cools to a scar (Collapse, about four seconds), and
   * everything of theirs on the table sinks and burns away into it.
   */
  private playerLost(pid: number, state: GameState): Promise<void> {
    const done = this.lostMat(pid, state, true);
    for (const obj of this.cards.values()) {
      const s = obj.state;
      // their cards on the table (not anyone's hand, which lives in screen space)
      if ((s.owner !== pid && s.controller !== pid) || obj.root.parent !== this.stage.scene || this.buried.has(obj.id)) continue;
      this.buried.set(obj.id, this.sink(obj, 0.55 + Math.random() * 0.5));
    }
    const lib = this.libraries.get(pid);
    if (lib) {
      gsap.to(lib.position, {
        y: lib.position.y - 3, duration: 1.3, delay: 0.6, ease: 'power2.in',
        onComplete: () => void (lib.visible = false),
      });
    }
    this.collapsing.add(done);
    void done.finally(() => this.collapsing.delete(done));
    return done;
  }

  /** The collapse (or, with animate false, its scar) on a player's mat. */
  private lostMat(pid: number, state: GameState, animate: boolean): Promise<void> {
    const i = seatsFor(state, this.localId).findIndex((s) => s.player.id === pid);
    const mat = tableMats(state, this.localId)[i];
    if (!mat) return Promise.resolve();
    if (!animate) {
      this.collapse.scar(mat);
      return Promise.resolve();
    }
    return this.collapse.play(mat);
  }

  /** A card on a collapsing mat drops with the ground, burning away as it goes. */
  private sink(obj: CardObject, delay: number): Promise<void> {
    gsap.killTweensOf(obj.root.position);
    const st = { v: 0 };
    return new Promise((resolve) => {
      gsap.to(obj.root.position, { y: obj.root.position.y - 2.6, duration: 1.4, delay, ease: 'power2.in' });
      gsap.to(st, {
        v: 1, duration: 1.3, delay: delay + 0.25, ease: 'power1.in',
        onUpdate: () => obj.setDissolve(st.v, '#ff7a2a'),
        onComplete: () => {
          obj.root.visible = false;
          resolve();
        },
      });
    });
  }

  /** Resolves when every collapse under way has finished (the game-over screen waits for them). */
  settled(): Promise<void> {
    return Promise.all([...this.collapsing]).then(() => undefined);
  }

  /** A new card appears: drawn from its library, created as a token, or revealed from hiding. True if it starts on the library. */
  private spawn(obj: CardObject, c: CardState, prev: GameState | null): boolean {
    const p = computeLayout(this.state!, this.localId, this.layoutOpts()).get(c.id);
    const lib = c.owner != null && prev && c.zone !== 'Library' ? this.libraryTop(c.owner) : null;
    if (p && lib && (c.zone === 'Hand' || (!c.token && c.zone !== 'Command'))) {
      // start on top of the library, then fly (the revealed top card itself just turns over where it lies)
      this.stage.scene.add(obj.root);
      obj.root.position.copy(lib);
      obj.root.rotation.set(-Math.PI / 2, 0, 0, 'YXZ');
      obj.root.scale.setScalar(0.7);
      obj.update(c);
      return true;
    }
    if (p) {
      this.parentFor(p.space).add(obj.root);
      obj.root.position.copy(p.pos);
      obj.root.quaternion.setFromEuler(p.rot);
      obj.root.scale.setScalar(c.token ? 0.01 : p.scale);
      if (c.token && prev) sfx.token(this.panOf(obj.root.getWorldPosition(new THREE.Vector3())));
      if (c.token) gsap.to(obj.root.scale, { x: p.scale, y: p.scale, z: p.scale, duration: 0.35 / this.timeScale, ease: 'back.out(2)' });
    } else {
      this.stage.scene.add(obj.root);
    }
    return false;
  }

  /** A card left every zone we draw (library, or out of the game): send it home and drop it. */
  private async vanish(obj: CardObject, prev: GameState | null, snap?: Snapshot): Promise<void> {
    this.cards.delete(obj.id);
    this.tucked.delete(obj.id);
    // a lost player's cards leave the game into their collapsing mat, not back to their library
    const buried = this.buried.get(obj.id);
    if (buried) {
      await buried;
      obj.dispose();
      return;
    }
    const owner = obj.state.owner;
    const lib = owner != null ? this.libraryTop(owner) : null;
    const wasOnField = snap?.zone === 'Battlefield';
    if (obj.state.token) {
      // tokens never go home: burn away on the battlefield, or just fade from wherever they ended up
      if (wasOnField) {
        const pos = new THREE.Vector3().setFromMatrixPosition(snap!.world);
        this.fx.death(pos, obj.root.scale.x);
        sfx.death(this.panOf(pos));
      }
      await this.dissolve(obj, wasOnField ? 0.55 : 0.3, '#ff8a3a');
      obj.dispose();
      return;
    }
    if (lib && prev) {
      const p: Placement = { space: 'table', pos: lib, rot: new THREE.Euler(-Math.PI / 2, 0, 0, 'YXZ'), scale: 0.6, faceUp: false, order: 0 };
      await this.fly(obj, snap?.zone ?? null, 'Library' as ZoneName, p, 0.6);
    }
    obj.dispose();
  }

  private dissolve(obj: CardObject, duration: number, edge: string): Promise<void> {
    const st = { v: 0 };
    return new Promise((resolve) =>
      gsap.to(st, { v: 1, duration: duration / this.timeScale, ease: 'power1.in', onUpdate: () => obj.setDissolve(st.v, edge), onComplete: resolve }),
    );
  }

  /** Battlefield → graveyard: burn away where it stood, then fade in on the graveyard pile. */
  private async dieThenPlace(obj: CardObject, snap: Snapshot): Promise<void> {
    const pos = new THREE.Vector3().setFromMatrixPosition(snap.world);
    this.flying.add(obj.id);
    this.fx.death(pos, obj.root.scale.x);
    sfx.death(this.panOf(pos));
    await this.dissolve(obj, 0.65, '#ff7a2a');
    const p = this.layout.get(obj.id);
    this.flying.delete(obj.id);
    if (!p) {
      // nowhere to go (a token that ceased to exist): it's gone
      this.cards.delete(obj.id);
      obj.dispose();
      return;
    }
    this.settle(obj, p, 0);
    obj.setDissolve(0);
    gsap.fromTo(obj.root.scale, { x: 0.01, y: 0.01, z: 0.01 }, { x: p.scale, y: p.scale, z: p.scale, duration: 0.25, ease: 'back.out(2)' });
  }

  private collectDeaths(e: GameEvent, snaps: Map<number, Snapshot>, deaths: Set<number>): void {
    if (e.event !== 'CardChangeZone') return;
    const card = (e.card as Ref)?.card;
    const from = (e.from as { zone?: string } | null)?.zone;
    const to = (e.to as { zone?: string } | null)?.zone;
    if (card != null && from === 'Battlefield' && to === 'Graveyard' && snaps.get(card)?.zone === 'Battlefield') deaths.add(card);
  }

  // ---- events → effects ---------------------------------------------------------------------------

  private async playEvents(events: GameEvent[], snaps: Map<number, Snapshot>): Promise<void> {
    const s = this.state!;
    const jobs: Promise<void>[] = [];
    const combatHits: GameEvent[] = [];
    const spellHits: GameEvent[] = [];
    for (const e of events) {
      switch (e.event) {
        case 'PlayerDamaged':
        case 'CardDamaged':
          if (this.isCombatDamage(e)) combatHits.push(e);
          else spellHits.push(e);
          break;
        case 'PlayerLivesChanged': {
          const pid = (e.player as Ref)?.player;
          const diff = (e.newLives as number) - (e.oldLives as number);
          if (pid != null && diff > 0) {
            this.floatAtPlayer(pid, `+${diff}`, 'heal');
            const at = this.playerArrowEnd(pid);
            sfx.lifeGain(at ? this.panOf(at) : 0);
          }
          // life lost without damage (drain, paying life): damage shows its own number
          const damaged = events.some((d) => d.event === 'PlayerDamaged' && (d.target as Ref)?.player === pid);
          if (pid != null && diff < 0 && !damaged) {
            this.floatAtPlayer(pid, `−${-diff}`, 'damage');
            this.onPlayerHit?.(pid, -diff);
            const at = this.playerArrowEnd(pid);
            if (at) {
              this.magic.burst(at, 'B', 0.3);
              sfx.lifeLoss(-diff, this.panOf(at));
            }
          }
          break;
        }
        case 'CardChangeZone': {
          const card = (e.card as Ref)?.card;
          const from = (e.from as { zone?: string } | null)?.zone;
          const to = (e.to as { zone?: string } | null)?.zone;
          const snap = card != null ? snaps.get(card) : undefined;
          if (snap && from === 'Battlefield' && to === 'Exile') {
            const at = new THREE.Vector3().setFromMatrixPosition(snap.world);
            this.fx.exile(at);
            sfx.exile(this.panOf(at));
          }
          break;
        }
        // a spell countered (the bridge spots it: see Counters.java): the phantasmal palm, wherever the camera is
        case 'SpellCountered': {
          sfx.counterspell();
          if (settings.particles !== 'off') jobs.push(this.stage.counterPalm(settings.floorDetail === 'low'));
          break;
        }
        case 'TurnBegan': {
          const pid = (e.turnOwner as Ref)?.player;
          const name = s.players.find((p) => p.id === pid)?.name;
          if (name) this.banner(pid === this.localId ? 'Your turn' : `${name}'s turn`);
          if (name) (pid === this.localId ? sfx.yourTurn() : sfx.opponentTurn());
          break;
        }
        case 'SpellAbilityCast': {
          const si = e.si as Ref;
          const item = s.stack.find((x) => x.id === si?.stack);
          if (item?.source != null && item.ability) {
            const src = this.cards.get(item.source);
            if (src) jobs.push(this.pulse(src));
          }
          // an opponent's spell holds the table so the player can read it
          if (item?.source != null && !item.ability && item.controller !== this.localId && this.onOpponentCast) {
            const card = s.cards[item.source];
            const who = s.players.find((p) => p.id === item.controller)?.name ?? 'Opponent';
            // a commander gets the spotlight instead (commanderCast)
            if (card?.visible && !(card.commander && settings.particles !== 'off')) jobs.push(this.onOpponentCast(card, who));
          }
          break;
        }
      }
    }
    if (combatHits.length) jobs.push(this.combat(combatHits));
    // one source hitting many things at once (Blasphemous Act, Earthquake) lands everywhere together;
    // a burn spell or two still flies its bolt to each target
    const bySource = new Map<string, GameEvent[]>();
    for (const e of spellHits) {
      const key = String((e.source as Ref)?.card ?? 'none');
      bySource.set(key, [...(bySource.get(key) ?? []), e]);
    }
    for (const group of bySource.values()) {
      if (group.length >= 3) jobs.push(this.sweep(group));
      else for (const e of group) jobs.push(this.spellDamage(e));
    }
    await Promise.all(jobs);
  }

  /**
   * Combat damage comes from an attacking or blocking creature. Forge flags it on player damage but not on
   * creature damage, so that's read from the source; anything else (a sweeper, a burn spell) is spell damage.
   */
  isCombatDamage(e: GameEvent): boolean {
    if (e.event === 'PlayerDamaged') return !!e.combat;
    if (e.event !== 'CardDamaged') return false;
    const src = (e.source as Ref)?.card;
    const c = src != null ? this.state?.cards[src] : undefined;
    return !!c && c.zone === 'Battlefield' && (!!c.attacking || !!c.blocking);
  }

  /** Damage from one source to many targets at once: every target is struck together, one sound, one punch. */
  private async sweep(hits: GameEvent[]): Promise<void> {
    const srcId = (hits[0].source as Ref)?.card;
    const colors = srcId != null ? (this.cards.get(srcId)?.state.colors ?? this.state?.cards[srcId]?.colors) : undefined;
    let biggest = 0;
    const centre = new THREE.Vector3();
    let n = 0;
    for (const e of hits) {
      const amount = e.amount as number;
      const targetPlayer = (e.target as Ref)?.player;
      const targetCard = (e.card as Ref)?.card;
      const at = targetPlayer != null ? this.playerArrowEnd(targetPlayer) : targetCard != null ? this.cardWorld(targetCard) : null;
      if (!at) continue;
      biggest = Math.max(biggest, amount);
      centre.add(at);
      n++;
      this.magic.burst(at, colors, 0.7);
      this.magic.wound(at, amount, null, targetPlayer != null);
      if (targetPlayer != null) {
        this.floatAtPlayer(targetPlayer, `−${amount}`, 'damage', amount >= 4);
        this.playerHit(targetPlayer, amount, at);
      } else if (targetCard != null) {
        this.floatAtCard(targetCard, `−${amount}`);
        this.cards.get(targetCard)?.hurt();
      }
    }
    if (n === 0) return;
    centre.multiplyScalar(1 / n);
    sfx.hit(biggest, false, this.panOf(centre));
    this.stage.punch(Math.min(1, biggest / 6));
    this.stage.addShake(Math.min(1, 0.3 + n * 0.04));
    await new Promise((r) => setTimeout(r, 650 / this.timeScale));
  }

  /**
   * Combat damage, staged so each blow registers: attackers wind up, then strike one engagement at a
   * time (an attacker and its blocker clash together), with a hit-stop and shockwave on every contact.
   * Combat is never rushed to clear the animation backlog.
   */
  private async combat(hits: GameEvent[]): Promise<void> {
    const ts = Math.min(this.timeScale, 1.15);
    const slots = new Map<string, number>();
    const strikes: Promise<void>[] = [];
    const struck = new Set<number>();
    const lunging: CardObject[] = [];
    for (const e of hits) {
      const srcId = (e.source as Ref)?.card;
      const src = srcId != null ? this.cards.get(srcId) : undefined;
      if (src && srcId != null && !struck.has(srcId) && !this.flying.has(srcId)) lunging.push(src);
    }
    // wind-up: everyone about to strike rears back together
    await Promise.all(lunging.map((o) => this.windUp(o, ts)));

    for (const e of hits) {
      const srcId = (e.source as Ref)?.card;
      const amount = e.amount as number;
      const targetCard = (e.card as Ref)?.card;
      const targetPlayer = (e.target as Ref)?.player;
      const src = srcId != null ? this.cards.get(srcId) : undefined;
      const targetPos = targetCard != null ? this.cardWorld(targetCard) : targetPlayer != null ? this.playerArrowEnd(targetPlayer) : null;
      if (!targetPos) continue;
      // one slot per engagement: attacker↔blocker pairs share a slot, each unblocked attacker gets its own
      const key = targetCard != null && srcId != null ? [srcId, targetCard].sort().join('-') : `p${srcId}`;
      if (!slots.has(key)) slots.set(key, slots.size);
      const delay = (slots.get(key)! * 0.42) / ts;
      const srcPos = src ? src.root.getWorldPosition(new THREE.Vector3()) : null;
      const onHit = () => {
        const heavy = Math.min(1, amount / 6);
        this.fx.impact(targetPos, targetPlayer != null ? '#ff5a3a' : '#ffb35a', Math.min(10, amount * 1.3));
        this.fx.shockwave(targetPos, targetPlayer != null ? '#ff6a3a' : '#ffc36a', heavy);
        // the striker's colours burst on contact, and the blow draws blood
        if (src) this.magic.burst(targetPos, src.state.colors, 0.6 + heavy * 0.5);
        this.magic.wound(targetPos, amount, srcPos, targetPlayer != null);
        sfx.hit(amount, targetPlayer != null, this.panOf(targetPos));
        this.hitStop(0.1 + heavy * 0.12);
        if (amount >= 4) this.stage.punch(heavy);
        if (targetPlayer != null) {
          this.showLifeLoss(targetPlayer, amount);
          this.floatAtPlayer(targetPlayer, `−${amount}`, 'damage', true);
          this.stage.addShake(Math.min(1.1, 0.25 + amount * 0.08));
          this.playerHit(targetPlayer, amount, targetPos);
        } else if (targetCard != null) {
          this.floatAtCard(targetCard, `−${amount}`, true);
          const t = this.cards.get(targetCard);
          if (t) {
            t.hurt();
            this.wobble(t);
            if (srcPos) this.knock(t, srcPos, amount);
            const ang = srcPos ? Math.atan2(targetPos.x - srcPos.x, targetPos.z - srcPos.z) + 0.6 : Math.random() * 6;
            this.magic.slash(targetPos, 2.2 + Math.min(1.5, amount * 0.2), ang);
          }
          this.stage.addShake(Math.min(0.6, 0.1 + amount * 0.05));
        }
      };
      if (src && srcId != null && !struck.has(srcId) && !this.flying.has(srcId)) {
        struck.add(srcId);
        strikes.push(this.wait(delay).then(() => this.lunge(src, targetPos, src.state.power ?? amount, onHit, ts)));
      } else {
        strikes.push(this.wait(delay + 0.3 / ts).then(onHit));
      }
    }
    await Promise.all(strikes);
    // let the damage sink in before anything dies
    await this.wait(0.55 / ts);
  }

  private showLifeLoss(pid: number, amount: number): void {
    const shown = this.lifeShown.get(pid);
    if (shown) {
      shown.value -= amount;
      shown.at = performance.now();
    }
  }

  /** The state as the plates should show it: life totals already reflect blows that have visibly landed. */
  shownState(): GameState | null {
    const s = this.state;
    if (!s || this.lifeShown.size === 0) return s;
    const now = performance.now();
    return {
      ...s,
      players: s.players.map((p) => {
        const shown = this.lifeShown.get(p.id);
        // safety: never hold a guess for long if the engine's total somehow doesn't move
        if (!shown || now - shown.at > 6000) return p;
        return { ...p, life: shown.value };
      }),
    };
  }

  private wait(seconds: number): Promise<void> {
    return new Promise((r) => (seconds > 0 ? gsap.delayedCall(seconds, r) : r()));
  }

  /**
   * A moment of slow motion on contact: everything animated drops to a crawl and eases back.
   * Runs on wall-clock time; a tween would itself be slowed by the time scale it is restoring.
   */
  private hitStop(seconds: number): void {
    const tl = gsap.globalTimeline;
    const t0 = performance.now();
    this.hitStopToken = t0;
    const tick = () => {
      if (this.hitStopToken !== t0) return void gsap.ticker.remove(tick);
      const k = Math.min(1, (performance.now() - t0) / (seconds * 1000));
      tl.timeScale(0.12 + 0.88 * k * k);
      if (k >= 1) gsap.ticker.remove(tick);
    };
    gsap.ticker.add(tick);
  }

  private hurtFlash(strength: number): void {
    const el = document.createElement('div');
    el.className = 'hurt-vignette';
    document.getElementById('hud')!.appendChild(el);
    gsap.timeline({ onComplete: () => el.remove() }).to(el, { opacity: 0.6 + strength * 0.4, duration: 0.08 }).to(el, { opacity: 0, duration: 0.7, ease: 'power1.in' });
  }

  private windUp(obj: CardObject, ts: number): Promise<void> {
    return new Promise((resolve) => {
      gsap.to(obj.body.position, { z: 1.1, duration: 0.32 / ts, ease: 'power2.out', onComplete: resolve });
    });
  }

  private lunge(obj: CardObject, target: THREE.Vector3, power: number, onHit: () => void, ts = this.timeScale): Promise<void> {
    const { strike, ret } = strikeTiming(power);
    const body = obj.body;
    const origin = obj.root.getWorldPosition(new THREE.Vector3());
    // the body layer moves in the card's local frame; aim it by converting the world offset
    const worldTarget = origin.clone().lerp(target, 0.78);
    sfx.whoosh(this.panOf(origin));
    const local = obj.root.worldToLocal(worldTarget.clone());
    local.z = 0;
    return new Promise((resolve) => {
      gsap
        .timeline({ onComplete: resolve })
        .to(body.position, { x: -local.x * 0.1, y: -local.y * 0.1, z: 1.4, duration: 0.16 / ts, ease: 'power2.out' })
        .to(body.position, { x: local.x, y: local.y, z: 1.2, duration: (strike * 1.15) / ts, ease: 'power3.in', onComplete: onHit })
        // hold at contact, then drift back
        .to(body.position, { x: local.x * 0.92, y: local.y * 0.92, duration: 0.14 / ts, ease: 'power1.out' })
        .to(body.position, { x: 0, y: 0, z: 0, duration: (ret * 1.2) / ts, ease: 'power2.inOut' });
    });
  }

  /** A player takes damage: their plate recoils; for you, the whole picture lurches and reddens. */
  private playerHit(pid: number, amount: number, at: THREE.Vector3): void {
    const heavy = Math.min(1, amount / 6);
    this.onPlayerHit?.(pid, amount);
    const v = at.clone().project(this.stage.camera);
    const screen = { x: v.x * 0.5 + 0.5, y: v.y * 0.5 + 0.5 };
    if (pid === this.localId) {
      this.hurtFlash(heavy);
      this.stage.hitPulse(0.45 + heavy * 0.75, screen);
      this.stage.punch(0.4 + heavy * 0.6);
    } else {
      this.stage.hitPulse(0.15 + heavy * 0.35, screen);
    }
  }

  /** A card transforms (or flips): it turns edge-on, shows its other face, and flares in its colours. */
  private transform(obj: CardObject): void {
    const at = obj.root.getWorldPosition(new THREE.Vector3());
    const d = 0.22 / this.timeScale;
    gsap.timeline()
      .to(obj.body.scale, { x: 0.02, duration: d, ease: 'power2.in' })
      .to(obj.body.position, { z: 1.6, duration: d, ease: 'power2.out' }, 0)
      .to(obj.body.scale, { x: 1, duration: d * 1.4, ease: 'back.out(2)' })
      .to(obj.body.position, { z: 0, duration: d * 1.6, ease: 'power2.inOut' }, '<');
    gsap.delayedCall(d, () => {
      this.magic.burst(at, obj.state.colors, 1.3);
      this.fx.shockwave(at, colorFor(obj.state.colors), 1);
      sfx.etb(obj.state.colors, obj.state.power ?? 3, this.panOf(at));
      this.stage.addShake(0.3);
    });
  }

  /** A struck card rocks back, away from the blow, and springs upright. */
  private knock(obj: CardObject, from: THREE.Vector3, amount: number): void {
    const at = obj.root.getWorldPosition(new THREE.Vector3());
    const away = at.clone().sub(from).setY(0).normalize().multiplyScalar(2).add(at);
    const local = obj.root.worldToLocal(away);
    const len = Math.hypot(local.x, local.y) || 1;
    const k = Math.min(0.75, 0.25 + amount * 0.06);
    gsap.killTweensOf(obj.body.rotation, 'x,y');
    gsap.fromTo(obj.body.rotation, { x: (-local.y / len) * k, y: (local.x / len) * k }, { x: 0, y: 0, duration: 0.7 / this.timeScale, ease: 'elastic.out(1.1, 0.3)' });
  }

  private wobble(obj: CardObject): void {
    gsap.fromTo(obj.body.rotation, { z: 0.12 }, { z: 0, duration: 0.5 / this.timeScale, ease: 'elastic.out(1.2, 0.35)' });
  }

  private async pulse(obj: CardObject): Promise<void> {
    // a trigger from a card still on its way (an enters-the-battlefield ability) fires where it lands,
    // not mid-air or back at the stack
    const landing = this.landings.get(obj.id);
    if (landing) await landing;
    if (this.cards.get(obj.id) !== obj) return;
    return new Promise((resolve) => {
      gsap.fromTo(obj.body.position, { z: 0 }, { z: 0.9, duration: 0.18 / this.timeScale, yoyo: true, repeat: 1, ease: 'sine.out', onComplete: resolve });
      const at = obj.root.getWorldPosition(new THREE.Vector3());
      this.fx.flash(at, colorFor(obj.state.colors), 2, 0.4);
      this.magic.burst(at, obj.state.colors, 0.4);
      sfx.ability(obj.state.colors, this.panOf(at));
    });
  }

  private async spellDamage(e: GameEvent): Promise<void> {
    const srcId = (e.source as Ref)?.card;
    const targetPlayer = (e.target as Ref)?.player;
    const targetCard = (e.card as Ref)?.card;
    const from = srcId != null ? this.cardWorld(srcId) : null;
    const to = targetPlayer != null ? this.playerArrowEnd(targetPlayer) : targetCard != null ? this.cardWorld(targetCard) : null;
    const amount = e.amount as number;
    if (from && to) sfx.zap(this.cards.get(srcId!)?.state.colors, this.panOf(from));
    const colors = srcId != null ? (this.cards.get(srcId)?.state.colors ?? this.state?.cards[srcId]?.colors) : undefined;
    if (from && to) await this.magic.bolt(from, to, colors, 0.5 / this.timeScale, 0.8 + Math.min(0.8, amount / 6));
    if (to) sfx.hit(amount, targetPlayer != null, this.panOf(to));
    if (to) this.magic.wound(to, amount, from, targetPlayer != null);
    if (targetPlayer != null) {
      this.floatAtPlayer(targetPlayer, `−${amount}`, 'damage', amount >= 4);
      this.stage.addShake(Math.min(0.8, 0.1 + amount * 0.05));
      this.playerHit(targetPlayer, amount, to!);
    } else if (targetCard != null) {
      this.floatAtCard(targetCard, `−${amount}`);
      const t = this.cards.get(targetCard);
      if (t && from) {
        t.hurt();
        this.knock(t, from, amount);
      }
    }
  }

  /** Combat declarations and taps show up as card flags flipping; one sound per kind per update. */
  private stateSounds(prev: GameState, delta: Record<string, CardState>): void {
    let attack = false;
    let block: number | null = null;
    let tap: number | null = null;
    for (const [id, c] of Object.entries(delta)) {
      const was = prev.cards[id];
      if (!was || c.zone !== 'Battlefield' || was.zone !== 'Battlefield') continue;
      if (c.attacking && !was.attacking) attack = true;
      else if (c.blocking && !was.blocking) block = Number(id);
      else if (c.tapped && !was.tapped) tap = Number(id);
    }
    const panAt = (id: number) => {
      const w = this.cardWorld(id);
      return w ? this.panOf(w) : 0;
    };
    if (attack) sfx.attack();
    if (block != null) sfx.block(panAt(block));
    if (tap != null && !attack) sfx.tap(panAt(tap));
  }

  /** Stereo position for a world point: where it sits across the screen. */
  private panOf(world: THREE.Vector3): number {
    const v = world.clone().project(this.stage.camera);
    return Math.max(-1, Math.min(1, v.x)) * 0.6;
  }

  // ---- positions ----------------------------------------------------------------------------------

  cardWorld(id: number): THREE.Vector3 | null {
    const obj = this.cards.get(id);
    return obj ? obj.root.getWorldPosition(new THREE.Vector3()) : null;
  }

  playerWorld(id: number): THREE.Vector3 | null {
    if (!this.state) return null;
    return avatarAnchor(this.state, this.localId, id);
  }

  /** Where a player's badge is on screen (set by the HUD's owner); arrows at a player end there. */
  badgeAt: ((id: number) => { x: number; y: number } | null) | null = null;

  /**
   * Where an arrow aimed at a player ends: on the table under their badge, which the HUD may have slid
   * away from their seat's anchor (pinned to a screen edge, nudged clear of another badge or the prompt).
   * Arrows lift their ends 0.3 above the point given, so the point is taken where the badge's ray meets
   * the plane 0.3 above the anchor and lowered by that, putting the tip exactly on the badge.
   */
  playerArrowEnd(id: number): THREE.Vector3 | null {
    const anchor = this.playerWorld(id);
    const at = this.badgeAt?.(id);
    if (!anchor || !at) return anchor;
    return this.screenToTable(at, anchor);
  }

  /** Where a Stack item is on screen (set by the HUD's owner): its card in the Stack panel, or the panel's tab. */
  stackAt: ((itemId: number) => { x: number; y: number } | null) | null = null;

  /** Where a tether from (or to) a Stack item starts: on the table under its card in the panel. */
  private stackArrowEnd(itemId: number): THREE.Vector3 | null {
    const at = this.stackAt?.(itemId);
    return at ? this.screenToTable(at, new THREE.Vector3(0, 0, 0)) : null;
  }

  /**
   * The point on the table (at the reference point's height) under a point on screen, raised arrows-wise:
   * arrows lift their ends 0.3, so the point is where the ray meets the plane 0.3 up, lowered by that,
   * putting the drawn end exactly under the screen point.
   */
  private screenToTable(at: { x: number; y: number }, anchor: THREE.Vector3): THREE.Vector3 {
    const cam = this.stage.camera;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((at.x / window.innerWidth) * 2 - 1, -(at.y / window.innerHeight) * 2 + 1), cam);
    const lift = 0.3;
    const hit = new THREE.Vector3();
    const camPos = cam.getWorldPosition(new THREE.Vector3());
    const reach = camPos.distanceTo(anchor);
    // a badge near the horizon would meet the table far off (or never): stop at the anchor's distance instead
    if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(anchor.y + lift)), hit) && camPos.distanceTo(hit) < reach * 1.6) {
      return hit.setY(hit.y - lift);
    }
    return ray.ray.at(reach, hit).setY(hit.y - lift);
  }

  toScreen(world: THREE.Vector3): { x: number; y: number } {
    const v = world.clone().project(this.stage.camera);
    return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
  }

  private floatAtPlayer(pid: number, text: string, kind: 'damage' | 'heal', big = false): void {
    // from the badge, wherever the HUD has put it (else from the seat)
    const w = this.playerWorld(pid);
    const s = this.badgeAt?.(pid) ?? (w ? this.toScreen(w) : null);
    if (!s) return;
    floatText(s.x, s.y - 40, text, kind, big);
  }

  private floatAtCard(id: number, text: string, big = false): void {
    const w = this.cardWorld(id);
    if (!w) return;
    const s = this.toScreen(w);
    floatText(s.x, s.y, text, 'damage', big);
  }

  private banner(text: string): void {
    const el = document.createElement('div');
    el.className = 'turn-banner';
    el.textContent = text;
    document.getElementById('hud')!.appendChild(el);
    gsap.fromTo(el, { opacity: 0, scale: 0.85 }, { opacity: 1, scale: 1, duration: 0.25, ease: 'back.out(2)' });
    gsap.to(el, { opacity: 0, duration: 0.4, delay: 0.9 / this.timeScale, onComplete: () => el.remove() });
  }

  // ---- libraries ----------------------------------------------------------------------------------

  /** Just above the top card of a player's library pile. */
  private libraryTop(pid: number): THREE.Vector3 | null {
    const s = this.state!;
    const count = s.players.find((p) => p.id === pid)?.zones.LibraryCount ?? 0;
    return libraryAnchor(s, this.localId, pid)?.setY(libraryHeight(count) + 0.03) ?? null;
  }

  /** top-of-library cards no longer shown, waiting to turn face down unless they're shown again first */
  private readonly topLeaving = new Map<number, number>();

  private concealLater(obj: CardObject): void {
    const wait = (): void => {
      const t = window.setTimeout(() => {
        if (this.flying.size > 0) return wait(); // updates wait for what's moving; so does this
        void this.turnOver(obj, false).then((done) => {
          if (done && this.topLeaving.get(obj.id) === t) this.dropTop(obj);
        });
      }, 600);
      this.topLeaving.set(obj.id, t);
    };
    wait();
  }

  /** A card that was about to be concealed is shown again (or has moved on): it stays. */
  private keepTop(obj: CardObject): void {
    const t = this.topLeaving.get(obj.id);
    if (t === undefined) return;
    window.clearTimeout(t);
    this.topLeaving.delete(obj.id);
    gsap.killTweensOf(obj.body.scale);
    obj.body.scale.x = 1;
    obj.update(obj.state);
  }

  private dropTop(obj: CardObject): void {
    window.clearTimeout(this.topLeaving.get(obj.id));
    this.topLeaving.delete(obj.id);
    gsap.killTweensOf(obj.body.scale);
    if (this.cards.get(obj.id) === obj) this.cards.delete(obj.id);
    obj.dispose();
  }

  /** Turn a card over where it lies, face up or face down. Resolves false when it was cut short. */
  private turnOver(obj: CardObject, up: boolean): Promise<boolean> {
    const s = obj.body.scale;
    const face = obj.state;
    const half = 0.14 / this.timeScale;
    const show = (faceUp: boolean): void => {
      // only the picture: the card's own state stays what the engine last said
      obj.update({ ...obj.state, visible: faceUp && face.visible });
      obj.state = face;
    };
    gsap.killTweensOf(s);
    show(!up);
    return new Promise((resolve) => {
      gsap.to(s, {
        x: 0.02, duration: half, ease: 'sine.in', onInterrupt: () => resolve(false),
        onComplete: () => {
          if (this.cards.get(obj.id) !== obj) return resolve(false);
          if (obj.state === face) show(up);
          gsap.to(s, { x: 1, duration: half, ease: 'sine.out', onInterrupt: () => resolve(false), onComplete: () => resolve(true) });
        },
      });
    });
  }

  private updateLibraries(state: GameState): void {
    for (const p of state.players) {
      let mesh = this.libraries.get(p.id);
      const anchor = libraryAnchor(state, this.localId, p.id);
      if (!anchor) continue;
      if (!mesh) {
        const side = new THREE.MeshStandardMaterial({ color: '#d9d2c0', roughness: 0.9 });
        const top = new THREE.MeshStandardMaterial({ map: cardBackTexture(), roughness: 0.55 });
        mesh = new THREE.Mesh(new THREE.BoxGeometry(CARD_W, 1, CARD_H), [side, side, top, side, side, side]);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.stage.scene.add(mesh);
        this.libraries.set(p.id, mesh);
      }
      const local = p.id === this.localId;
      const scale = local ? 0.7 : 0.55;
      const height = libraryHeight(p.zones.LibraryCount);
      mesh.visible = p.zones.LibraryCount > 0 && !this.sunk.has(p.id);
      mesh.scale.set(scale, height, scale);
      mesh.position.set(anchor.x, height / 2, anchor.z);
      mesh.rotation.y = seatRotation(state, this.localId, p.id)?.rotY ?? 0;
    }
  }

  // ---- highlights & arrows ------------------------------------------------------------------------

  private layoutOpts(): { hoveredHand: number | null; handOrder: number[]; liftedHand: Set<number>; hoveredCommand: number | null } {
    const picked = new Set(this.selection.chosen.map((r) => r?.card).filter((x): x is number => x != null));
    return { hoveredHand: this.hoveredHand, handOrder: this.handOrder, liftedHand: picked, hoveredCommand: this.hoveredCommand };
  }

  refreshHighlights(): void {
    const s = this.state;
    if (!s) return;
    const sel = this.selection;
    const chosen = new Set(sel.chosen.map((r) => r?.card).filter((x): x is number => x != null));
    const selectable = new Set(sel.cards);
    // Forge's London mulligan doesn't list its choices: every card in hand may go to the bottom
    if (this.prompt.input === 'InputLondonMulligan') {
      s.players.find((p) => p.id === this.localId)?.zones.Hand.forEach((id) => selectable.add(id));
    }
    const autoPay = new Set(sel.actionable.filter((id, i) => sel.actionable.indexOf(id) !== i));
    const actionable = new Set(sel.actionable);
    // a playable top of library (Forge's own scan doesn't look there)
    for (const p of s.players) if (p.zones.LibraryTopPlayable && p.zones.LibraryTop != null) actionable.add(p.zones.LibraryTop);
    const top = s.stack[0];
    const targeted = new Set((top?.targets ?? []).map((r) => r?.card).filter((x): x is number => x != null));
    // your band of cards playable from exile: the ones you can't use right now are greyed out
    const band = new Set((s.players.find((p) => p.id === this.localId)?.exilePlayable ?? []).filter((id) => s.cards[id]?.zone === 'Exile'));
    for (const [id, obj] of this.cards) {
      const c = obj.state;
      obj.setDim(band.has(id) && !actionable.has(id) && !selectable.has(id) && !chosen.has(id));
      let h: Highlight = 'none';
      // what a card is doing in combat outranks "you could click this"
      if (chosen.has(id) || this.group.has(id)) h = 'chosen';
      else if (selectable.has(id)) h = 'selectable';
      else if (c.attacking) h = 'attacking';
      else if (c.blocking) h = 'blocking';
      else if (targeted.has(id)) h = 'target';
      else if (autoPay.has(id)) h = 'autoPay';
      else if (actionable.has(id)) h = 'playable';
      obj.setHighlight(h);
    }
  }

  /** Each player's Speed card rings their current speed on its printed track. */
  private refreshSpeedMarks(state: GameState): void {
    for (const p of state.players) {
      for (const id of p.zones.Command) {
        const c = state.cards[id];
        // Forge's speed effect: its image key names the speed card ("t:speed|DFT|14", "t:max_speed|…")
        if (c?.effect && /^t:(max_)?speed\|/.test(c.imageKey ?? '')) this.cards.get(id)?.setSpeedMark(p.speed ?? null);
      }
    }
  }

  /**
   * Your commanders sitting in their slot (not flying to or from it) wear the aura; any others lose it. Only
   * commanders: other things in your command zone (speed's "Start Your Engines!", emblems) sit beside them plain.
   */
  private syncCommandAura(): void {
    const me = this.state?.players.find((p) => p.id === this.localId);
    const out: { id: number; root: THREE.Object3D; colors: string }[] = [];
    for (const id of me?.zones.Command ?? []) {
      const obj = this.cards.get(id);
      if (obj && obj.state.commander && !this.flying.has(id) && obj.state.zone === 'Command') out.push({ id, root: obj.root, colors: obj.state.colors ?? '' });
    }
    this.commandAura.sync(out);
  }

  /** The arrows on the table; one aimed at a player names them, so its end can follow their badge. */
  private arrowSpecs: { from: THREE.Vector3; to: THREE.Vector3; color: string; mark?: LinkMark; player?: number; fromItem?: number; toItem?: number }[] = [];
  /** the Stack item whose targets are shown: the one hovered in the panel, else the next to resolve */
  private stackFocus: number | null = null;

  /** Show the targets of this Stack item (hovered in the panel), or of the next to resolve again (null). */
  focusStack(itemId: number | null): void {
    if (this.stackFocus === itemId) return;
    this.stackFocus = itemId;
    this.refreshArrows();
  }

  /**
   * Badges are fixed on screen while the arrows live on the table, so when the camera moves (the Auto view
   * framing combat) or a badge slides, an arrow's end would drift off it onto the board until the next
   * update. Re-aim those ends every frame, rebuilding only when one has actually moved.
   */
  private followBadges(): void {
    let moved = false;
    for (const a of this.arrowSpecs) {
      // ends pinned to the screen: a player's badge, a Stack item's card in the panel
      const to = a.player != null ? this.playerArrowEnd(a.player) : a.toItem != null ? this.stackArrowEnd(a.toItem) : null;
      if (to && to.distanceToSquared(a.to) > 0.0025) {
        a.to = to;
        moved = true;
      }
      const from = a.fromItem != null ? this.stackArrowEnd(a.fromItem) : null;
      if (from && from.distanceToSquared(a.from) > 0.0025) {
        a.from = from;
        moved = true;
      }
    }
    if (moved) this.arrows.set(this.arrowSpecs);
  }

  private refreshArrows(): void {
    const s = this.state;
    if (!s) return;
    const arrows: typeof this.arrowSpecs = [];
    for (const a of s.combat ?? []) {
      const from = this.layoutWorld(a.attacker);
      if (!from) continue;
      const pid = a.defender?.player;
      const to = pid != null ? this.playerArrowEnd(pid) : a.defender?.card != null ? this.layoutWorld(a.defender.card) : null;
      if (to && a.blockers.length === 0) arrows.push({ from, to, color: '#ff5a2a', mark: 'fire', player: pid ?? undefined });
      for (const b of a.blockers) {
        const bw = this.layoutWorld(b);
        if (bw) arrows.push({ from: bw, to: from, color: '#7fc4ff' });
      }
    }
    // what a spell or ability on the Stack targets: the one hovered in the panel, else the next to resolve.
    // The tether starts at its card in the Stack panel (what you're looking at; a spell's own card has
    // tucked away into it), or at its source when the panel isn't showing
    const item = s.stack.find((x) => x.id === this.stackFocus) ?? s.stack[0];
    if (item) {
      const fromPanel = this.stackArrowEnd(item.id);
      const from = fromPanel ?? (item.source != null ? this.layoutWorld(item.source) : null);
      // the design's target links: blue for a spell, violet for an ability or trigger
      const ability = !!item.ability || !!item.trigger;
      for (const t of item.targets) {
        // a spell on the Stack (a counterspell's target) is pointed at in the panel
        const onStack = t?.card != null ? s.stack.find((x) => x.source === t.card && x.id !== item.id && !x.ability && !x.trigger) : undefined;
        const toItem = onStack ? onStack.id : undefined;
        const to = toItem != null ? this.stackArrowEnd(toItem) : t?.card != null ? this.layoutWorld(t.card) : t?.player != null ? this.playerArrowEnd(t.player) : null;
        if (from && to) {
          arrows.push({
            from, to,
            color: ability ? '#b07aff' : '#4ea8ff',
            mark: ability ? 'sigil-violet' : 'sigil-blue',
            player: t?.card == null ? t?.player ?? undefined : undefined,
            // pinned to the item even before the panel shows it: the tether moves onto its card once it does
            fromItem: item.id,
            toItem,
          });
        }
      }
    }
    this.arrowSpecs = arrows;
    this.arrows.set(arrows);
  }

  private layoutWorld(id: number): THREE.Vector3 | null {
    const p = this.layout.get(id);
    if (!p) return this.cardWorld(id);
    return new THREE.Vector3().setFromMatrixPosition(this.targetWorld(p));
  }

  /** Hit-test helpers for input. */
  /** Everything clickable except local hand cards, which are hit through their zones. */
  pickables(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const c of this.cards.values()) if (!this.handZones.has(c.id)) out.push(...c.meshes);
    return out;
  }

  /** Whether a card is your commander in its command-zone slot by the hand. */
  isLocalCommand(id: number): boolean {
    return !!this.state?.players.find((p) => p.id === this.localId)?.zones.Command.includes(id);
  }

  isLocalHand(id: number): boolean {
    const me = this.state?.players.find((p) => p.id === this.localId);
    return !!me?.zones.Hand.includes(id);
  }

  stackItemFor(cardId: number): number | null {
    const item = this.state?.stack.find((s) => s.source === cardId);
    return item ? item.id : null;
  }

  /** Whose side of the table a point on it belongs to. */
  playerAt(point: THREE.Vector3): number | null {
    return this.state ? seatAt(this.state, this.localId, point) : null;
  }

  targetablePlayers(): Set<number> {
    const out = new Set(this.selection.targets.map((t) => t?.player).filter((x): x is number => x != null));
    // declaring attackers: Forge attacks one defender at a time, and clicking a player switches to them
    if (this.isDeclaringAttack()) for (const p of this.state?.players ?? []) if (p.id !== this.localId && !p.lost) out.add(p.id);
    return out;
  }

  isDeclaringAttack(): boolean {
    return this.prompt.input === 'InputAttack';
  }

  isDeclaringBlock(): boolean {
    return this.prompt.input === 'InputBlock';
  }

  /** Replace (or with additive, extend) the box-selected group and show it. */
  setGroup(ids: number[], additive = false): void {
    if (!additive) this.group.clear();
    for (const id of ids) this.group.add(id);
    this.refreshHighlights();
  }

  clearGroup(): void {
    if (!this.group.size) return;
    this.group.clear();
    this.refreshHighlights();
  }

  /** Draw the drag arrows from a creature (or a selected group) to a point (snapped to the target when there is one), or clear them. */
  showAim(from: number | number[] | null, to: THREE.Vector3 | null, kind: 'attack' | 'block', targetCard: number | null): void {
    const ids = from == null ? [] : Array.isArray(from) ? from : [from];
    const color = kind === 'attack' ? '#ff5a2a' : '#7fc4ff';
    const starts = ids.map((id) => this.cardWorld(id)).filter((p): p is THREE.Vector3 => p != null);
    this.aimArrows.set(to ? starts.map((start) => ({ from: start, to, color })) : []);
    if (targetCard !== this.aimCard) {
      const was = this.aimCard;
      this.aimCard = targetCard;
      if (was != null) this.refreshHighlights();
      if (targetCard != null) this.cards.get(targetCard)?.setHighlight('target');
    }
  }

  /** Your creatures on the battlefield whose centres lie inside a screen rectangle (for a selection box). */
  creaturesInRect(rect: { left: number; top: number; right: number; bottom: number }): number[] {
    const me = this.state?.players.find((p) => p.id === this.localId);
    if (!me) return [];
    const out: number[] = [];
    for (const id of me.zones.Battlefield) {
      if (!this.state!.cards[id]?.creature) continue;
      const w = this.cardWorld(id);
      if (!w) continue;
      const p = this.toScreen(w);
      if (p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom) out.push(id);
    }
    return out;
  }

  /** The player your attackers are currently aimed at (Forge's current defender), while declaring. */
  currentDefender(): number | null {
    if (!this.isDeclaringAttack()) return null;
    return this.selection.chosen.find((r) => r?.player != null)?.player ?? null;
  }
}
