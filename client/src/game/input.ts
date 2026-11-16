import * as THREE from 'three';
import type { Stage } from '../scene/stage';
import type { Table } from './table';

/** How far up (share of the window height) a hand card must be dragged to play it; below that, a drag reorders the hand. */
const PLAY_DRAG = 0.12;

/** What an attacker or blocker is being dragged onto. */
export type AimTarget = { player: number } | { card: number };

export interface InputHandlers {
  clickCard(id: number, button: number): void;
  /** whether a press on this card starts an attack/block drag (your creature, while declaring) */
  aimKind?(id: number): 'attack' | 'block' | null;
  /** the legal target under the pointer for this drag, if any: a card hit, a plate, or a spot on the table */
  aimTarget?(kind: 'attack' | 'block', from: number, card: number | null, plate: number | null, table: THREE.Vector3 | null): AimTarget | null;
  /** the drag was released on a target */
  aimDrop?(kind: 'attack' | 'block', from: number, target: AimTarget): void;
  /** the drag moved: where to draw the arrow (null target: follow the pointer) */
  aimMove?(kind: 'attack' | 'block', from: number, target: AimTarget | null, point: THREE.Vector3 | null): void;
  /** a click on empty table: the player whose side it is */
  clickTable(playerId: number): void;
  /** any click on empty table (or off the mats), with whose side it is; true when it was handled (skip clickTable) */
  clickEmpty?(playerId: number | null): boolean;
  /** whether a drag on empty table draws a selection box (while declaring attackers or blockers) */
  canBoxSelect?(): boolean;
  /** a selection box was drawn (screen pixels); additive: Shift was held */
  boxSelect?(rect: { left: number; top: number; right: number; bottom: number }, additive: boolean): void;
  hover(id: number | null): void;
}

/**
 * Pointer → card. Hand cards can be clicked or dragged upward past a threshold to play them,
 * the way Arena does; right-click is passed through (Forge reads it as "undo this declaration").
 */
export class Input {
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private hovered: number | null = null;
  private drag: { id: number; startY: number; startX: number; moved: boolean; grab: THREE.Vector3; depth: number } | null = null;
  /** dragging a line from an attacker to its target, or a blocker to an attacker (Arena style) */
  private aim: { id: number; kind: 'attack' | 'block'; startX: number; startY: number; moved: boolean; target: AimTarget | null } | null = null;
  /** a selection box being drawn on empty table; pid is whose side the press landed on (for a plain click) */
  private box: { startX: number; startY: number; x: number; y: number; moved: boolean; pid: number | null; el: HTMLDivElement | null } | null = null;

  constructor(
    private readonly stage: Stage,
    private readonly table: Table,
    private readonly handlers: InputHandlers,
  ) {
    this.ray.layers.enableAll(); // hand cards live on the overlay layer
    const canvas = stage.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerleave', () => this.setHover(null));
  }

  private pick(e: PointerEvent): number | null {
    this.ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.stage.camera);
    // 1. the popped-up hand card itself (it's wider than its slot)
    const hovered = this.hovered != null ? this.table.cards.get(this.hovered) : undefined;
    if (hovered && this.table.isLocalHand(hovered.id) && this.ray.intersectObjects(hovered.meshes, false).length) return hovered.id;
    // 2. hand slots, which never move under the pointer
    const hand = this.ray.intersectObjects(this.table.handZoneMeshes(), false);
    if (hand.length) return hand[0].object.userData.cardId as number;
    // 3. the stack and the table, nearest first
    const hits = this.ray.intersectObjects(this.table.pickables(), false);
    return hits.length ? (hits[0].object.userData.cardId as number) : null;
  }

  private onMove(e: PointerEvent): void {
    if (this.box) {
      const b = this.box;
      b.x = e.clientX;
      b.y = e.clientY;
      if (!b.moved && Math.hypot(b.x - b.startX, b.y - b.startY) > 8) {
        b.moved = true;
        b.el = document.createElement('div');
        b.el.className = 'marquee';
        document.body.append(b.el);
      }
      if (b.el) {
        const r = this.boxRect(b);
        Object.assign(b.el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` });
      }
      return;
    }
    if (this.aim) {
      const a = this.aim;
      if (Math.hypot(e.clientX - a.startX, e.clientY - a.startY) > 10) a.moved = true;
      if (!a.moved) return;
      a.target = this.aimTargetAt(e, a);
      this.handlers.aimMove?.(a.kind, a.id, a.target, this.tablePoint(e.clientX, e.clientY));
      return;
    }
    if (this.drag) {
      const dy = this.drag.startY - e.clientY;
      if (Math.hypot(dy, e.clientX - this.drag.startX) > 24) this.drag.moved = true;
      const obj = this.table.cards.get(this.drag.id);
      if (obj && this.drag.moved) {
        // keep the grabbed point of the card exactly under the cursor
        const p = this.pointOnPlane(e.clientX, e.clientY, this.drag.depth);
        obj.root.position.copy(p.sub(this.drag.grab));
        // still low, near the hand: sliding it sideways reorders the hand (higher up, it's about to be played)
        if (dy < window.innerHeight * PLAY_DRAG) this.table.moveHandCard(this.drag.id, obj.root.position.x);
      }
      return;
    }
    this.setHover(this.pick(e));
  }

  private setHover(id: number | null): void {
    if (id === this.hovered) return;
    if (this.hovered != null) {
      const prev = this.table.cards.get(this.hovered);
      if (prev) prev.hovered = false;
    }
    this.hovered = id;
    if (id != null) {
      const obj = this.table.cards.get(id);
      if (obj) obj.hovered = true;
    }
    this.stage.renderer.domElement.style.cursor = id != null ? 'pointer' : 'default';
    this.handlers.hover(id);
  }

  private onDown(e: PointerEvent): void {
    const id = this.pick(e);
    if (id == null) {
      if (e.button !== 0) return;
      // empty table: hit the table plane and work out whose side it is
      const hit = new THREE.Vector3();
      const pid = this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit) ? this.table.playerAt(hit) : null;
      // declaring attackers or blockers: a drag here draws a selection box; a plain click still lands on release
      if (this.handlers.canBoxSelect?.()) {
        this.box = { startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, moved: false, pid, el: null };
        return;
      }
      if (!this.handlers.clickEmpty?.(pid) && pid != null) this.handlers.clickTable(pid);
      return;
    }
    // your creature while declaring attackers or blockers: a drag aims it, a click works as before
    const kind = e.button === 0 ? this.handlers.aimKind?.(id) ?? null : null;
    if (kind) {
      this.aim = { id, kind, startX: e.clientX, startY: e.clientY, moved: false, target: null };
      return;
    }
    if (e.button === 0 && this.table.isLocalHand(id)) {
      const obj = this.table.cards.get(id)!;
      const depth = -obj.root.position.z;
      // offset from the card's centre to where the cursor grabbed it, in screen-locked (camera) space
      const grab = this.pointOnPlane(e.clientX, e.clientY, depth).sub(obj.root.position);
      this.drag = { id, startY: e.clientY, startX: e.clientX, moved: false, grab, depth };
      this.table.beginDrag(id);
      return;
    }
    this.handlers.clickCard(id, e.button === 2 ? 3 : 1);
  }

  private onUp(e: PointerEvent): void {
    const b = this.box;
    if (b) {
      this.box = null;
      b.el?.remove();
      if (b.moved) this.handlers.boxSelect?.(this.boxRect(b), e.shiftKey);
      else {
        if (!this.handlers.clickEmpty?.(b.pid) && b.pid != null) this.handlers.clickTable(b.pid);
      }
      return;
    }
    const a = this.aim;
    if (a) {
      this.aim = null;
      this.handlers.aimMove?.(a.kind, a.id, null, null);
      if (!a.moved) this.handlers.clickCard(a.id, 1);
      else {
        const target = this.aimTargetAt(e, a);
        if (target) this.handlers.aimDrop?.(a.kind, a.id, target);
      }
      return;
    }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const dy = d.startY - e.clientY;
    // a plain click or a drag up out of the hand plays the card; a short drag just drops it back
    const play = !d.moved || dy > window.innerHeight * PLAY_DRAG;
    this.table.endDrag(d.id, play);
    if (play) this.handlers.clickCard(d.id, 1);
  }

  private boxRect(b: { startX: number; startY: number; x: number; y: number }): { left: number; top: number; right: number; bottom: number } {
    return { left: Math.min(b.startX, b.x), top: Math.min(b.startY, b.y), right: Math.max(b.startX, b.x), bottom: Math.max(b.startY, b.y) };
  }

  /** The legal target under the pointer for an aim drag: a player's plate, a card, or their side of the table. */
  private aimTargetAt(e: PointerEvent, a: { id: number; kind: 'attack' | 'block' }): AimTarget | null {
    const plateEl = document.elementsFromPoint(e.clientX, e.clientY).find((el) => (el as HTMLElement).dataset?.pid != null) as HTMLElement | undefined;
    const plate = plateEl ? Number(plateEl.dataset.pid) : null;
    const card = plate == null ? this.pick(e) : null;
    return this.handlers.aimTarget?.(a.kind, a.id, card === a.id ? null : card, plate, this.tablePoint(e.clientX, e.clientY)) ?? null;
  }

  /** Where the cursor meets the table top. */
  tablePoint(clientX: number, clientY: number): THREE.Vector3 | null {
    this.ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.stage.camera);
    const hit = new THREE.Vector3();
    return this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit) ? hit : null;
  }

  /** The point under the cursor at a given distance in front of the camera, in camera space. */
  private pointOnPlane(clientX: number, clientY: number, depth: number): THREE.Vector3 {
    const cam = this.stage.camera;
    const ndcX = (clientX / window.innerWidth) * 2 - 1;
    const ndcY = -(clientY / window.innerHeight) * 2 + 1;
    const halfH = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * depth;
    return new THREE.Vector3(ndcX * halfH * cam.aspect, ndcY * halfH, -depth);
  }
}
