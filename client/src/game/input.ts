import * as THREE from 'three';
import type { Stage } from '../scene/stage';
import type { Table } from './table';

export interface InputHandlers {
  clickCard(id: number, button: number): void;
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
  private drag: { id: number; startY: number; startX: number; moved: boolean } | null = null;

  constructor(
    private readonly stage: Stage,
    private readonly table: Table,
    private readonly handlers: InputHandlers,
  ) {
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
    const hits = this.ray.intersectObjects(this.table.pickables(), false);
    // hand and stack cards sit in front of the table; prefer whatever is nearest the camera
    return hits.length ? (hits[0].object.userData.cardId as number) : null;
  }

  private onMove(e: PointerEvent): void {
    if (this.drag) {
      const dy = this.drag.startY - e.clientY;
      if (Math.abs(dy) > 8 || Math.abs(e.clientX - this.drag.startX) > 8) this.drag.moved = true;
      const obj = this.table.cards.get(this.drag.id);
      if (obj && this.drag.moved) {
        obj.body.position.y = Math.max(0, dy / 40);
        obj.body.position.x = (e.clientX - this.drag.startX) / 40;
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
    if (id == null) return;
    if (e.button === 0 && this.table.isLocalHand(id)) {
      this.drag = { id, startY: e.clientY, startX: e.clientX, moved: false };
      return;
    }
    this.handlers.clickCard(id, e.button === 2 ? 3 : 1);
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const obj = this.table.cards.get(d.id);
    if (obj) obj.body.position.set(0, 0, 0);
    const dy = d.startY - e.clientY;
    // a plain click or a drag up out of the hand plays the card; a short drag just drops it back
    if (!d.moved || dy > window.innerHeight * 0.12) this.handlers.clickCard(d.id, 1);
  }
}
