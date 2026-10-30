import * as THREE from 'three';
import type { Stage } from '../scene/stage';
import type { Table } from './table';

export interface InputHandlers {
  clickCard(id: number, button: number): void;
  /** a click on empty table: the player whose side it is */
  clickTable(playerId: number): void;
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
    if (this.drag) {
      const dy = this.drag.startY - e.clientY;
      if (Math.hypot(dy, e.clientX - this.drag.startX) > 24) this.drag.moved = true;
      const obj = this.table.cards.get(this.drag.id);
      if (obj && this.drag.moved) {
        // keep the grabbed point of the card exactly under the cursor
        const p = this.pointOnPlane(e.clientX, e.clientY, this.drag.depth);
        obj.root.position.copy(p.sub(this.drag.grab));
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
      if (this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) {
        const pid = this.table.playerAt(hit);
        if (pid != null) this.handlers.clickTable(pid);
      }
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
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const dy = d.startY - e.clientY;
    // a plain click or a drag up out of the hand plays the card; a short drag just drops it back
    const play = !d.moved || dy > window.innerHeight * 0.12;
    this.table.endDrag(d.id, play);
    if (play) this.handlers.clickCard(d.id, 1);
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
