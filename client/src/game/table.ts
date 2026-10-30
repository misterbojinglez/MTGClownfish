import * as THREE from 'three';
import gsap from 'gsap';
import type { CardState, GameEvent, GameState, Prompt, Ref, Selection, UpdateMsg, ZoneName } from '../protocol';
import { CARD_H, CARD_W, CardObject, type Highlight } from '../scene/cardMesh';
import { avatarAnchor, computeLayout, libraryAnchor, type Placement } from '../scene/layout';
import { Arrows, colorFor, floatText, Fx } from '../scene/fx';
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
  handOrder: number[] = [];
  /** >1 when the update queue is backed up and animations should hurry. */
  timeScale = 1;

  private readonly fx: Fx;
  private readonly arrows: Arrows;
  private readonly libraries = new Map<number, THREE.Mesh>();
  private readonly flying = new Set<number>();
  private layout = new Map<number, Placement>();
  /** Invisible, unmoving click targets for hand cards at their resting slots. */
  private readonly handZones = new Map<number, THREE.Mesh>();
  private readonly zoneGeo = new THREE.PlaneGeometry(CARD_W, CARD_H);
  private readonly zoneMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });

  constructor(private readonly stage: Stage) {
    this.fx = new Fx(stage);
    this.arrows = new Arrows(stage);
    stage.onTick((dt) => {
      for (const c of this.cards.values()) c.tick(dt);
    });
  }

  reset(): void {
    for (const c of this.cards.values()) c.dispose();
    this.cards.clear();
    for (const m of this.libraries.values()) m.removeFromParent();
    this.libraries.clear();
    this.state = null;
    this.handOrder = [];
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
    const state: GameState = { ...msg.state, cards };
    this.state = state;
    this.prompt = msg.prompt;
    this.selection = msg.selection;

    const visibleIds = this.visibleCardIds(state);
    for (const id of visibleIds) {
      const c = cards[id];
      if (!c) continue;
      let obj = this.cards.get(id);
      if (!obj) {
        obj = new CardObject(c);
        this.cards.set(id, obj);
        this.spawn(obj, c, prev);
      } else {
        obj.update(c);
      }
    }

    this.layout = computeLayout(state, this.localId, { hoveredHand: this.hoveredHand, handOrder: this.handOrder });
    this.updateLibraries(state);
    this.updateHandZones();

    const tasks: Promise<void>[] = [];
    const deaths = new Set<number>();
    for (const e of msg.events) this.collectDeaths(e, snapshots, deaths);

    for (const [id, obj] of this.cards) {
      if (!visibleIds.has(id)) {
        // A card between zones (cast but not yet on the stack, etc.) stays where it is until it lands;
        // only a card that really went to its library or out of the game leaves the table.
        const zone = cards[id]?.zone;
        if (zone && IN_TRANSIT_ZONES.has(zone)) continue;
        tasks.push(this.vanish(obj, prev, snapshots.get(id)));
        continue;
      }
      if (deaths.has(id)) {
        tasks.push(this.dieThenPlace(obj, snapshots.get(id)!));
        continue;
      }
      const target = this.layout.get(id);
      if (!target) continue;
      const before = snapshots.get(id);
      const zoneChanged = before && before.zone !== obj.state.zone;
      if (zoneChanged) tasks.push(this.fly(obj, before.zone, obj.state.zone, target));
      else if (!this.flying.has(id)) this.settle(obj, target, before ? 0.28 : 0);
    }

    tasks.push(this.playEvents(msg.events, snapshots));
    this.refreshHighlights();
    this.refreshArrows();
    await Promise.all(tasks);
  }

  /** Re-place everything without animation pacing (hover, selection changes). */
  relayout(duration = 0.18): void {
    if (!this.state) return;
    this.updateHandZones();
    this.layout = computeLayout(this.state, this.localId, { hoveredHand: this.hoveredHand, handOrder: this.handOrder });
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
    const rest = computeLayout(this.state, this.localId, { hoveredHand: null, handOrder: this.handOrder });
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

  /** Tween a card to its placement within its current space (reflow, tap, hover). */
  private settle(obj: CardObject, p: Placement, duration: number): void {
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

    return new Promise((resolve) => {
      gsap.to(st, {
        t: 1,
        duration,
        ease: EASE[key] ?? 'power2.inOut',
        onUpdate: () => {
          root.position.copy(curve.getPoint(Math.min(1, st.t)));
          root.quaternion.slerpQuaternions(startQuat, endQuat, Math.min(1, st.t));
          root.scale.setScalar(startScale + (endScaleV.x - startScale) * st.t);
          if (to === 'Stack' || from === 'Stack') this.fx.trail(root.position, trailColor, 0.3);
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
            this.fx.etb(end, colorFor(s.colors), p.scale * (s.creature ? 1 : 0.7));
            if (s.creature && (s.power ?? 0) >= 5) this.stage.addShake(0.35);
          }
          if (reveal) obj.body.position.set(0, 0, 0);
          resolve();
        },
      });
      if (reveal) {
        // a drawn card lifts toward the player, pauses, then drops into the fan
        gsap.fromTo(obj.body.position, { z: 0 }, { z: 2.2, duration: duration * 0.5, yoyo: true, repeat: 1, ease: 'sine.inOut' });
      }
    });
  }

  /** A new card appears: drawn from its library, created as a token, or revealed from hiding. */
  private spawn(obj: CardObject, c: CardState, prev: GameState | null): void {
    const p = computeLayout(this.state!, this.localId, { hoveredHand: this.hoveredHand, handOrder: this.handOrder }).get(c.id);
    const lib = c.owner != null && prev ? libraryAnchor(this.state!, this.localId, c.owner) : null;
    if (p && lib && (c.zone === 'Hand' || (!c.token && c.zone !== 'Command'))) {
      // start face-down on top of the library, then fly
      this.stage.scene.add(obj.root);
      obj.root.position.copy(lib).add(new THREE.Vector3(0, 0.6, 0));
      obj.root.rotation.set(-Math.PI / 2, 0, 0, 'YXZ');
      obj.root.scale.setScalar(0.7);
      obj.state = { ...c, zone: 'Library' as ZoneName };
      obj.update(c);
      return;
    }
    if (p) {
      this.parentFor(p.space).add(obj.root);
      obj.root.position.copy(p.pos);
      obj.root.quaternion.setFromEuler(p.rot);
      obj.root.scale.setScalar(c.token ? 0.01 : p.scale);
      if (c.token) gsap.to(obj.root.scale, { x: p.scale, y: p.scale, z: p.scale, duration: 0.35 / this.timeScale, ease: 'back.out(2)' });
    } else {
      this.stage.scene.add(obj.root);
    }
  }

  /** A card left every zone we draw (library, or out of the game): send it home and drop it. */
  private async vanish(obj: CardObject, prev: GameState | null, snap?: Snapshot): Promise<void> {
    this.cards.delete(obj.id);
    const s = this.state!;
    const owner = obj.state.owner;
    const lib = owner != null ? libraryAnchor(s, this.localId, owner) : null;
    const wasOnField = snap?.zone === 'Battlefield';
    if (wasOnField && obj.state.token) {
      const pos = new THREE.Vector3().setFromMatrixPosition(snap!.world);
      this.fx.death(pos, obj.root.scale.x);
      await this.dissolve(obj, 0.55, '#ff8a3a');
      obj.dispose();
      return;
    }
    if (lib && prev) {
      const p: Placement = { space: 'table', pos: lib.clone().add(new THREE.Vector3(0, 0.4, 0)), rot: new THREE.Euler(-Math.PI / 2, 0, 0, 'YXZ'), scale: 0.6, faceUp: false, order: 0 };
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
    await this.dissolve(obj, 0.65, '#ff7a2a');
    const p = this.layout.get(obj.id);
    this.flying.delete(obj.id);
    if (!p) return;
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
    for (const e of events) {
      switch (e.event) {
        case 'PlayerDamaged':
        case 'CardDamaged':
          if (e.combat || e.event === 'CardDamaged') combatHits.push(e);
          else jobs.push(this.spellDamage(e));
          break;
        case 'PlayerLivesChanged': {
          const pid = (e.player as Ref)?.player;
          const diff = (e.newLives as number) - (e.oldLives as number);
          if (pid != null && diff > 0) this.floatAtPlayer(pid, `+${diff}`, 'heal');
          break;
        }
        case 'CardChangeZone': {
          const card = (e.card as Ref)?.card;
          const from = (e.from as { zone?: string } | null)?.zone;
          const to = (e.to as { zone?: string } | null)?.zone;
          const snap = card != null ? snaps.get(card) : undefined;
          if (snap && from === 'Battlefield' && to === 'Exile') this.fx.exile(new THREE.Vector3().setFromMatrixPosition(snap.world));
          break;
        }
        case 'TurnBegan': {
          const pid = (e.turnOwner as Ref)?.player;
          const name = s.players.find((p) => p.id === pid)?.name;
          if (name) this.banner(pid === this.localId ? 'Your turn' : `${name}'s turn`);
          break;
        }
        case 'SpellAbilityCast': {
          const si = e.si as Ref;
          const item = s.stack.find((x) => x.id === si?.stack);
          if (item?.source != null && item.ability) {
            const src = this.cards.get(item.source);
            if (src) jobs.push(this.pulse(src));
          }
          break;
        }
      }
    }
    if (combatHits.length) jobs.push(this.combat(combatHits));
    await Promise.all(jobs);
  }

  /** Attackers lunge at what they hit, all at once, then recoil. */
  private async combat(hits: GameEvent[]): Promise<void> {
    const strikes: Promise<void>[] = [];
    const struck = new Set<number>();
    for (const e of hits) {
      const srcId = (e.source as Ref)?.card;
      const amount = e.amount as number;
      const targetCard = (e.card as Ref)?.card;
      const targetPlayer = (e.target as Ref)?.player;
      const src = srcId != null ? this.cards.get(srcId) : undefined;
      const targetPos = targetCard != null ? this.cardWorld(targetCard) : targetPlayer != null ? this.playerWorld(targetPlayer) : null;
      if (!targetPos) continue;
      const onHit = () => {
        this.fx.impact(targetPos, targetPlayer != null ? '#ff5a3a' : '#ffb35a', Math.min(8, amount));
        if (targetPlayer != null) {
          this.floatAtPlayer(targetPlayer, `−${amount}`, 'damage');
          this.stage.addShake(Math.min(1, 0.15 + amount * 0.06));
        } else if (targetCard != null) {
          this.floatAtCard(targetCard, `−${amount}`);
          const t = this.cards.get(targetCard);
          if (t) this.wobble(t);
        }
      };
      if (src && srcId != null && !struck.has(srcId) && !this.flying.has(srcId)) {
        struck.add(srcId);
        strikes.push(this.lunge(src, targetPos, src.state.power ?? amount, onHit));
      } else {
        onHit();
      }
    }
    await Promise.all(strikes);
  }

  private lunge(obj: CardObject, target: THREE.Vector3, power: number, onHit: () => void): Promise<void> {
    const { strike, ret } = strikeTiming(power);
    const body = obj.body;
    const origin = obj.root.getWorldPosition(new THREE.Vector3());
    // the body layer moves in the card's local frame; aim it by converting the world offset
    const worldTarget = origin.clone().lerp(target, 0.78);
    const local = obj.root.worldToLocal(worldTarget.clone());
    local.z = 0;
    return new Promise((resolve) => {
      gsap
        .timeline({ onComplete: resolve })
        .to(body.position, { x: -local.x * 0.08, y: -local.y * 0.08, z: 0.8, duration: 0.12 / this.timeScale, ease: 'power2.out' })
        .to(body.position, { x: local.x, y: local.y, z: 1.2, duration: strike / this.timeScale, ease: 'power3.in', onComplete: onHit })
        .to(body.position, { x: 0, y: 0, z: 0, duration: ret / this.timeScale, ease: 'power2.out' });
    });
  }

  private wobble(obj: CardObject): void {
    gsap.fromTo(obj.body.rotation, { z: 0.12 }, { z: 0, duration: 0.5 / this.timeScale, ease: 'elastic.out(1.2, 0.35)' });
  }

  private pulse(obj: CardObject): Promise<void> {
    return new Promise((resolve) => {
      gsap.fromTo(obj.body.position, { z: 0 }, { z: 0.9, duration: 0.18 / this.timeScale, yoyo: true, repeat: 1, ease: 'sine.out', onComplete: resolve });
      this.fx.flash(obj.root.getWorldPosition(new THREE.Vector3()), colorFor(obj.state.colors), 2, 0.4);
    });
  }

  private async spellDamage(e: GameEvent): Promise<void> {
    const srcId = (e.source as Ref)?.card;
    const targetPlayer = (e.target as Ref)?.player;
    const targetCard = (e.card as Ref)?.card;
    const from = srcId != null ? this.cardWorld(srcId) : null;
    const to = targetPlayer != null ? this.playerWorld(targetPlayer) : targetCard != null ? this.cardWorld(targetCard) : null;
    const amount = e.amount as number;
    if (from && to) await this.fx.bolt(from, to, colorFor(this.cards.get(srcId!)?.state.colors), 0.45 / this.timeScale);
    if (targetPlayer != null) {
      this.floatAtPlayer(targetPlayer, `−${amount}`, 'damage');
      this.stage.addShake(Math.min(0.8, 0.1 + amount * 0.05));
    } else if (targetCard != null) this.floatAtCard(targetCard, `−${amount}`);
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

  toScreen(world: THREE.Vector3): { x: number; y: number } {
    const v = world.clone().project(this.stage.camera);
    return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
  }

  private floatAtPlayer(pid: number, text: string, kind: 'damage' | 'heal'): void {
    const w = this.playerWorld(pid);
    if (!w) return;
    const s = this.toScreen(w);
    floatText(s.x, s.y - 40, text, kind);
  }

  private floatAtCard(id: number, text: string): void {
    const w = this.cardWorld(id);
    if (!w) return;
    const s = this.toScreen(w);
    floatText(s.x, s.y, text, 'damage');
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
      const height = Math.max(0.001, Math.min(1.4, p.zones.LibraryCount * 0.019));
      mesh.visible = p.zones.LibraryCount > 0;
      mesh.scale.set(scale, height, scale);
      mesh.position.set(anchor.x, height / 2, anchor.z);
      const seatRot = state.players.length > 2 ? Math.atan2(anchor.x, anchor.z) : 0;
      mesh.rotation.y = state.players.length > 2 ? seatRot : 0;
    }
  }

  // ---- highlights & arrows ------------------------------------------------------------------------

  refreshHighlights(): void {
    const s = this.state;
    if (!s) return;
    const sel = this.selection;
    const chosen = new Set(sel.chosen.map((r) => r?.card).filter((x): x is number => x != null));
    const selectable = new Set(sel.cards);
    const autoPay = new Set(sel.actionable.filter((id, i) => sel.actionable.indexOf(id) !== i));
    const actionable = new Set(sel.actionable);
    const top = s.stack[0];
    const targeted = new Set((top?.targets ?? []).map((r) => r?.card).filter((x): x is number => x != null));
    for (const [id, obj] of this.cards) {
      const c = obj.state;
      let h: Highlight = 'none';
      if (chosen.has(id)) h = 'chosen';
      else if (selectable.has(id)) h = 'selectable';
      else if (autoPay.has(id)) h = 'autoPay';
      else if (actionable.has(id)) h = 'playable';
      else if (targeted.has(id)) h = 'target';
      else if (c.attacking) h = 'attacking';
      else if (c.blocking) h = 'blocking';
      obj.setHighlight(h);
    }
  }

  private refreshArrows(): void {
    const s = this.state;
    if (!s) return;
    const arrows: { from: THREE.Vector3; to: THREE.Vector3; color: string }[] = [];
    for (const a of s.combat ?? []) {
      const from = this.layoutWorld(a.attacker);
      if (!from) continue;
      const pid = a.defender?.player;
      const to = pid != null ? this.playerWorld(pid) : a.defender?.card != null ? this.layoutWorld(a.defender.card) : null;
      if (to && a.blockers.length === 0) arrows.push({ from, to, color: '#ff4a3a' });
      for (const b of a.blockers) {
        const bw = this.layoutWorld(b);
        if (bw) arrows.push({ from: bw, to: from, color: '#c9d4ff' });
      }
    }
    const top = s.stack[0];
    if (top?.source != null) {
      const from = this.layoutWorld(top.source);
      for (const t of top.targets) {
        const to = t?.card != null ? this.layoutWorld(t.card) : t?.player != null ? this.playerWorld(t.player) : null;
        if (from && to) arrows.push({ from, to, color: '#ffcf4a' });
      }
    }
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

  isLocalHand(id: number): boolean {
    const me = this.state?.players.find((p) => p.id === this.localId);
    return !!me?.zones.Hand.includes(id);
  }

  stackItemFor(cardId: number): number | null {
    const item = this.state?.stack.find((s) => s.source === cardId);
    return item ? item.id : null;
  }

  targetablePlayers(): Set<number> {
    return new Set(this.selection.targets.map((t) => t?.player).filter((x): x is number => x != null));
  }
}
