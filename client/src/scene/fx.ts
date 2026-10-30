import * as THREE from 'three';
import gsap from 'gsap';
import type { Stage } from './stage';

const MAX_PARTICLES = 6000;

interface Particle {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  color: THREE.Color;
  size: number;
  life: number;
  maxLife: number;
  drag: number;
  gravity: number;
}

/** One additive point cloud shared by every burst, trail and spark. */
export class Particles {
  private readonly particles: Particle[] = [];
  private readonly geo = new THREE.BufferGeometry();
  private readonly positions = new Float32Array(MAX_PARTICLES * 3);
  private readonly colors = new Float32Array(MAX_PARTICLES * 3);
  private readonly sizes = new Float32Array(MAX_PARTICLES);
  private readonly alphas = new Float32Array(MAX_PARTICLES);
  private cursor = 0;

  constructor(stage: Stage) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({ alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), color: new THREE.Color(), size: 1, life: 0, maxLife: 1, drag: 0, gravity: 0 });
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float size; attribute float alpha; attribute vec3 color;
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vColor = color; vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * 260.0 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor; varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vColor * (1.0 + a), a * a * vAlpha);
        }`,
    });
    const points = new THREE.Points(this.geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 10;
    stage.scene.add(points);
    stage.onTick((dt) => this.tick(dt));
  }

  emit(o: { pos: THREE.Vector3; vel: THREE.Vector3; color: THREE.ColorRepresentation; size: number; life: number; drag?: number; gravity?: number }): void {
    const p = this.particles[this.cursor];
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    p.alive = true;
    p.pos.copy(o.pos);
    p.vel.copy(o.vel);
    p.color.set(o.color);
    p.size = o.size;
    p.life = p.maxLife = o.life;
    p.drag = o.drag ?? 1.5;
    p.gravity = o.gravity ?? 0;
  }

  private tick(dt: number): void {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (!p.alive) {
        this.alphas[i] = 0;
        continue;
      }
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        this.alphas[i] = 0;
        continue;
      }
      p.vel.multiplyScalar(Math.exp(-p.drag * dt));
      p.vel.y -= p.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      const k = p.life / p.maxLife;
      this.positions.set([p.pos.x, p.pos.y, p.pos.z], i * 3);
      this.colors.set([p.color.r, p.color.g, p.color.b], i * 3);
      this.sizes[i] = p.size * (0.4 + 0.6 * k);
      this.alphas[i] = Math.min(1, k * 2.2);
    }
    for (const name of ['position', 'color', 'size', 'alpha']) (this.geo.attributes[name] as THREE.BufferAttribute).needsUpdate = true;
  }
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export const MANA_COLORS: Record<string, string> = {
  W: '#fff3c2',
  U: '#5fb4ff',
  B: '#b07ce0',
  R: '#ff6a3d',
  G: '#5fdc78',
  C: '#d8d8e8',
};

export function colorFor(colors: string | undefined): string {
  const c = (colors ?? '').replace(/[^WUBRG]/g, '');
  if (c.length > 1) return '#ffd36a';
  return MANA_COLORS[c] ?? MANA_COLORS.C;
}

export class Fx {
  readonly particles: Particles;

  constructor(private readonly stage: Stage) {
    this.particles = new Particles(stage);
  }

  /** Card lands on the battlefield: a dust ring and a short flash. */
  etb(pos: THREE.Vector3, color: string, scale = 1): void {
    for (let i = 0; i < 70; i++) {
      const a = (i / 70) * Math.PI * 2;
      const speed = rand(4, 8) * scale;
      this.particles.emit({
        pos: pos.clone().add(new THREE.Vector3(Math.cos(a) * 1.4 * scale, 0.1, Math.sin(a) * 1.9 * scale)),
        vel: new THREE.Vector3(Math.cos(a) * speed, rand(0.3, 1.6), Math.sin(a) * speed),
        color: i % 3 === 0 ? color : '#e9dcc4',
        size: rand(0.25, 0.55),
        life: rand(0.35, 0.7),
        drag: 4,
      });
    }
    this.flash(pos, color, 2.2 * scale, 0.35);
  }

  /** A permanent dies: embers lift from where it stood. */
  death(pos: THREE.Vector3, scale = 1): void {
    for (let i = 0; i < 120; i++) {
      this.particles.emit({
        pos: pos.clone().add(new THREE.Vector3(rand(-1.2, 1.2) * scale, rand(0, 0.3), rand(-1.7, 1.7) * scale)),
        vel: new THREE.Vector3(rand(-0.8, 0.8), rand(1.5, 4.5), rand(-0.8, 0.8)),
        color: Math.random() < 0.7 ? '#ff7a2a' : '#ffd08a',
        size: rand(0.18, 0.4),
        life: rand(0.7, 1.5),
        drag: 0.8,
        gravity: -0.6,
      });
    }
  }

  /** Exile: a cold upward shimmer. */
  exile(pos: THREE.Vector3, scale = 1): void {
    for (let i = 0; i < 90; i++) {
      this.particles.emit({
        pos: pos.clone().add(new THREE.Vector3(rand(-1.2, 1.2) * scale, rand(0, 0.4), rand(-1.7, 1.7) * scale)),
        vel: new THREE.Vector3(rand(-0.3, 0.3), rand(3, 7), rand(-0.3, 0.3)),
        color: Math.random() < 0.6 ? '#bfe6ff' : '#ffffff',
        size: rand(0.15, 0.35),
        life: rand(0.5, 1.1),
        drag: 1.2,
      });
    }
  }

  /** Sparks where a hit connects. */
  impact(pos: THREE.Vector3, color = '#ffb35a', power = 1): void {
    const n = Math.round(40 + power * 18);
    for (let i = 0; i < n; i++) {
      const dir = new THREE.Vector3(rand(-1, 1), rand(0.2, 1.2), rand(-1, 1)).normalize();
      this.particles.emit({
        pos: pos.clone(),
        vel: dir.multiplyScalar(rand(5, 12) * (0.7 + power * 0.12)),
        color: Math.random() < 0.5 ? color : '#fff2d0',
        size: rand(0.15, 0.4),
        life: rand(0.25, 0.55),
        drag: 3.5,
        gravity: 9,
      });
    }
    this.flash(pos, color, 1.5 + power * 0.25, 0.22);
  }

  /** A flat ring racing outward across the table from an impact. */
  shockwave(pos: THREE.Vector3, color: string, size = 1): void {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.2), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 48), mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, 0.08, pos.z);
    ring.scale.setScalar(0.6);
    this.stage.scene.add(ring);
    const end = 3 + size * 2.4;
    gsap.to(ring.scale, { x: end, y: end, z: end, duration: 0.55, ease: 'power2.out' });
    gsap.to(mat, { opacity: 0, duration: 0.55, ease: 'power1.in', onComplete: () => { ring.removeFromParent(); ring.geometry.dispose(); mat.dispose(); } });
  }

  /** A trail sample behind a moving card or bolt. */
  trail(pos: THREE.Vector3, color: string, size = 0.35): void {
    this.particles.emit({
      pos: pos.clone().add(new THREE.Vector3(rand(-0.2, 0.2), rand(-0.2, 0.2), rand(-0.2, 0.2))),
      vel: new THREE.Vector3(rand(-0.4, 0.4), rand(0, 0.6), rand(-0.4, 0.4)),
      color,
      size,
      life: rand(0.25, 0.5),
      drag: 2,
    });
  }

  /** A soft light bloom that fades out. */
  flash(pos: THREE.Vector3, color: string, radius: number, duration: number): void {
    const light = new THREE.PointLight(color, 40, radius * 6, 2);
    light.position.copy(pos).add(new THREE.Vector3(0, 1.2, 0));
    this.stage.scene.add(light);
    gsap.to(light, { intensity: 0, duration, ease: 'power2.out', onComplete: () => { light.removeFromParent(); } });
  }

  /** A glowing bolt arcing from one point to another (spell → target, damage). */
  bolt(from: THREE.Vector3, to: THREE.Vector3, color: string, duration = 0.45): Promise<void> {
    const mid = from.clone().lerp(to, 0.5).add(new THREE.Vector3(0, 4 + from.distanceTo(to) * 0.12, 0));
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 12, 12),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(3), toneMapped: false }),
    );
    this.stage.scene.add(orb);
    const st = { t: 0 };
    return new Promise((resolve) => {
      gsap.to(st, {
        t: 1,
        duration,
        ease: 'power1.in',
        onUpdate: () => {
          const p = curve.getPoint(st.t);
          orb.position.copy(p);
          this.trail(p, color, 0.45);
          this.trail(p, '#ffffff', 0.2);
        },
        onComplete: () => {
          orb.removeFromParent();
          orb.geometry.dispose();
          this.impact(to, color, 1);
          resolve();
        },
      });
    });
  }
}

/** Curved, animated arrows for targets, attacks and blocks. */
export class Arrows {
  private readonly group = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;

  constructor(stage: Stage) {
    stage.scene.add(this.group);
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // the ribbon lies flat; whichever way its triangles wind, it must be visible from above
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec3 color; varying vec2 vUv; varying vec3 vColor;
        void main() { vUv = uv; vColor = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; varying vec2 vUv; varying vec3 vColor;
        void main() {
          float flow = fract(vUv.x * 6.0 - uTime * 1.8);
          float core = smoothstep(0.5, 0.0, abs(vUv.y - 0.5));
          float a = core * (0.45 + 0.55 * smoothstep(0.0, 0.5, flow) * smoothstep(1.0, 0.5, flow));
          a *= smoothstep(0.0, 0.05, vUv.x);
          gl_FragColor = vec4(vColor * 2.2, a);
        }`,
    });
    stage.onTick((_, t) => (this.material.uniforms.uTime.value = t));
  }

  set(arrows: { from: THREE.Vector3; to: THREE.Vector3; color: string }[]): void {
    for (const child of [...this.group.children]) {
      child.removeFromParent();
      (child as THREE.Mesh).geometry.dispose();
    }
    for (const a of arrows) this.group.add(this.build(a.from, a.to, a.color));
  }

  private build(from: THREE.Vector3, to: THREE.Vector3, color: string): THREE.Mesh {
    const lift = 2 + from.distanceTo(to) * 0.18;
    const mid = from.clone().lerp(to, 0.5).add(new THREE.Vector3(0, lift, 0));
    const curve = new THREE.QuadraticBezierCurve3(from.clone().setY(from.y + 0.3), mid, to.clone().setY(to.y + 0.3));
    const segments = 48;
    const width = 0.32;
    const pos: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const c = new THREE.Color(color);
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const p = curve.getPoint(t);
      const tan = curve.getTangent(t);
      const side = new THREE.Vector3().crossVectors(tan, up).normalize();
      // arrow head: widen then pinch over the last 12%
      const head = t > 0.86 ? (1 - t) / 0.14 * 2.6 : 1;
      const w = width * (t > 0.86 ? head : 1);
      pos.push(...p.clone().addScaledVector(side, w).toArray(), ...p.clone().addScaledVector(side, -w).toArray());
      uv.push(t, 0, t, 1);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    const idx: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.renderOrder = 20;
    mesh.frustumCulled = false;
    return mesh;
  }
}

/** Damage / life numbers that pop at a screen position and drift up. */
export function floatText(x: number, y: number, text: string, kind: 'damage' | 'heal' | 'info', big = false): void {
  const el = document.createElement('div');
  el.className = `float-text ${kind}${big ? ' big' : ''}`;
  el.textContent = text;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  document.getElementById('hud')!.appendChild(el);
  gsap.fromTo(el, { scale: 0.4, opacity: 0 }, { scale: 1.15, opacity: 1, duration: 0.18, ease: 'back.out(3)' });
  gsap.to(el, { y: big ? -90 : -70, opacity: 0, duration: big ? 1.3 : 1.1, delay: big ? 0.9 : 0.35, ease: 'power1.in', onComplete: () => el.remove() });
}
