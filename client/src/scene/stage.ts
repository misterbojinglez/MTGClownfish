import * as THREE from 'three';
import gsap from 'gsap';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

// Camera framing measured from Arena's battlefield scenes (docs/arena-reference.md).
export const CAMERA_FOV = 34;
const CAMERA_POS = new THREE.Vector3(0, 47.5, 18);
const CAMERA_TARGET = new THREE.Vector3(0, 0, 0.71);
const DESIGN_ASPECT = 16 / 9;

/**
 * Where the camera looks: a point on the table, the compass direction it looks from (yaw 0 = from your
 * side), how far away it is, and how steeply it looks down. The local hand rides along with the camera.
 */
export interface CameraView {
  target: THREE.Vector3;
  yaw: number;
  dist: number;
  pitch: number;
}

/** Arena's duel framing. */
export const HOME_VIEW: CameraView = {
  target: CAMERA_TARGET.clone(),
  yaw: 0,
  dist: CAMERA_POS.distanceTo(CAMERA_TARGET),
  pitch: Math.atan2(CAMERA_POS.y - CAMERA_TARGET.y, CAMERA_POS.z - CAMERA_TARGET.z),
};

export function cameraPosition(v: CameraView, out = new THREE.Vector3()): THREE.Vector3 {
  const flat = Math.cos(v.pitch) * v.dist;
  return out.set(v.target.x + Math.sin(v.yaw) * flat, v.target.y + Math.sin(v.pitch) * v.dist, v.target.z + Math.cos(v.yaw) * flat);
}

/** Camera layer for screen-space cards, rendered after post-processing. */
export const OVERLAY_LAYER = 1;

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Children of this group stay fixed to the screen (the local hand lives here). */
  readonly cameraRig = new THREE.Group();
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly hitPass: ShaderPass;
  private hitAmt = 0;
  private readonly tickers = new Set<(dt: number, t: number) => void>();
  private readonly clock = new THREE.Clock();
  private tableMaterial!: THREE.ShaderMaterial;
  private keyLight!: THREE.DirectionalLight;
  private shake = 0;
  /** the current camera view; tweened by setView */
  readonly view: CameraView = { ...HOME_VIEW, target: HOME_VIEW.target.clone() };
  private viewTween: gsap.core.Tween | null = null;
  private readonly basePos = new THREE.Vector3();
  /** a scratch camera for framing calculations */
  private readonly probe = new THREE.PerspectiveCamera();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 16 / 9, 4, 400);
    this.camera.position.copy(cameraPosition(this.view));
    this.camera.lookAt(this.view.target);
    this.camera.add(this.cameraRig);
    this.scene.add(this.camera);

    this.scene.background = new THREE.Color('#07060a');
    this.scene.fog = new THREE.Fog('#07060a', 70, 140);

    this.buildLights();
    this.buildTable();
    this.buildMotes();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.35, 1.02);
    this.composer.addPass(this.bloom);
    this.hitPass = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, uAmt: { value: 0 }, uCenter: { value: new THREE.Vector2(0.5, 0.5) } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform float uAmt; uniform vec2 uCenter; varying vec2 vUv;
        void main() {
          vec2 dir = vUv - uCenter;
          vec2 off = dir * uAmt * 0.03;
          vec3 col = vec3(0.0);
          for (int i = 0; i < 6; i++) {
            vec2 uv = vUv - dir * uAmt * 0.05 * (float(i) / 5.0);
            col.r += texture2D(tDiffuse, uv + off).r;
            col.g += texture2D(tDiffuse, uv).g;
            col.b += texture2D(tDiffuse, uv - off).b;
          }
          col /= 6.0;
          float lum = dot(col, vec3(0.299, 0.587, 0.114));
          col = mix(col, vec3(lum) * vec3(1.15, 0.85, 0.82), clamp(uAmt * 0.3, 0.0, 0.35));
          float vig = smoothstep(0.55, 1.05, length((vUv - 0.5) * vec2(1.25, 1.0)) * 1.4);
          col = mix(col, col * vec3(0.9, 0.18, 0.14) + vec3(0.22, 0.0, 0.0), vig * clamp(uAmt, 0.0, 1.0) * 0.75);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.hitPass.enabled = false;
    this.composer.addPass(this.hitPass);
    this.composer.addPass(new OutputPass());

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  onTick(fn: (dt: number, t: number) => void): () => void {
    this.tickers.add(fn);
    return () => this.tickers.delete(fn);
  }

  /** A quick zoom toward the table and back, for heavy hits; strength ~0–1. */
  punch(strength: number): void {
    const cam = this.camera;
    const peak = 1 + 0.05 * Math.min(1, strength);
    const st = { z: cam.zoom };
    const apply = () => {
      cam.zoom = st.z;
      cam.updateProjectionMatrix();
    };
    gsap.timeline().to(st, { z: peak, duration: 0.08, ease: 'power2.out', onUpdate: apply }).to(st, { z: 1, duration: 0.45, ease: 'power2.inOut', onUpdate: apply });
  }

  /**
   * A blow that rattles the picture: colour splits and smears outward from where it landed, the frame
   * drains toward red at the edges, and it all snaps back. strength ~0.2–1.2; at = screen point (0–1, y up).
   */
  hitPulse(strength: number, at?: { x: number; y: number }): void {
    if (strength > this.hitAmt) {
      this.hitAmt = strength;
      if (at) this.hitPass.uniforms.uCenter.value.set(at.x, at.y);
      else this.hitPass.uniforms.uCenter.value.set(0.5, 0.5);
    }
  }

  /** Glide the camera to a view (seconds; 0 = cut). Yaw takes the short way round. */
  setView(v: CameraView, duration = 0.9): void {
    this.viewTween?.kill();
    const from = this.view;
    let yaw = v.yaw;
    while (yaw - from.yaw > Math.PI) yaw -= Math.PI * 2;
    while (yaw - from.yaw < -Math.PI) yaw += Math.PI * 2;
    if (duration <= 0) {
      from.target.copy(v.target);
      Object.assign(from, { yaw, dist: v.dist, pitch: v.pitch });
      return;
    }
    const st = { tx: from.target.x, ty: from.target.y, tz: from.target.z, yaw: from.yaw, dist: from.dist, pitch: from.pitch };
    this.viewTween = gsap.to(st, {
      tx: v.target.x,
      ty: v.target.y,
      tz: v.target.z,
      yaw,
      dist: v.dist,
      pitch: v.pitch,
      duration,
      ease: 'power2.inOut',
      onUpdate: () => {
        from.target.set(st.tx, st.ty, st.tz);
        from.yaw = st.yaw;
        from.dist = st.dist;
        from.pitch = st.pitch;
      },
    });
  }

  /** Normalised screen positions (-1..1) of world points as seen from a view, without moving the camera. */
  projectFrom(v: CameraView, points: THREE.Vector3[]): THREE.Vector3[] {
    const c = this.probe;
    c.fov = this.camera.fov;
    c.aspect = this.camera.aspect;
    c.near = this.camera.near;
    c.far = this.camera.far;
    c.updateProjectionMatrix();
    c.position.copy(cameraPosition(v));
    c.lookAt(v.target);
    c.updateMatrixWorld(true);
    return points.map((p) => p.clone().project(c));
  }

  /**
   * Table dressing for the seat arrangement: battlefield mats (world boxes minX, minZ, maxX, maxZ), the
   * ritual circle at the centre, and shadow coverage wide enough for every seat.
   */
  setTableLayout(mats: THREE.Vector4[], circle: { x: number; z: number; r: number }): void {
    const u = this.tableMaterial.uniforms;
    const list = mats.slice(0, 4);
    while (list.length < 4) list.push(new THREE.Vector4());
    u.uMats.value = list;
    u.uMatCount.value = Math.min(4, mats.length);
    u.uCircle.value.set(circle.x, circle.z, circle.r);
    let minX = -34, maxX = 34, minZ = -26, maxZ = 26;
    for (const m of mats) {
      minX = Math.min(minX, m.x - 6);
      minZ = Math.min(minZ, m.y - 6);
      maxX = Math.max(maxX, m.z + 6);
      maxZ = Math.max(maxZ, m.w + 6);
    }
    const sc = this.keyLight.shadow.camera;
    const half = Math.max(-minX, maxX, -minZ, maxZ);
    sc.left = -half;
    sc.right = half;
    sc.top = half;
    sc.bottom = -half;
    sc.far = 90 + half;
    sc.updateProjectionMatrix();
    this.keyLight.shadow.mapSize.set(half > 40 ? 4096 : 2048, half > 40 ? 4096 : 2048);
    this.keyLight.shadow.map?.dispose();
    this.keyLight.shadow.map = null;
  }

  /** A short camera jolt for heavy hits; strength ~0.2–1. */
  addShake(strength: number): void {
    this.shake = Math.min(1.2, this.shake + strength);
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // Arena frames for 16:9; on narrower windows widen the vertical FOV so the table's width still fits.
    if (aspect < DESIGN_ASPECT) {
      const halfH = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2)) * (DESIGN_ASPECT / aspect);
      this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfH));
    } else {
      this.camera.fov = CAMERA_FOV;
    }
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    this.tableMaterial.uniforms.uTime.value = t;
    for (const fn of this.tickers) fn(dt, t);

    if (this.hitAmt > 0.002) {
      this.hitPass.enabled = true;
      this.hitPass.uniforms.uAmt.value = this.hitAmt;
      this.hitAmt *= Math.pow(0.004, dt);
    } else if (this.hitPass.enabled) {
      this.hitAmt = 0;
      this.hitPass.enabled = false;
    }
    cameraPosition(this.view, this.basePos);
    // fog starts beyond whatever the camera is framing, however far back it has pulled
    const fog = this.scene.fog as THREE.Fog;
    fog.near = this.view.dist + 20;
    fog.far = this.view.dist + 90;
    this.camera.position.copy(this.basePos);
    if (this.shake > 0.001) {
      const s = this.shake * this.shake * 0.35;
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
      this.shake *= Math.pow(0.02, dt);
    } else {
      this.shake = 0;
    }
    this.camera.lookAt(this.view.target);
    this.composer.render(dt);
    this.renderOverlay();
  }

  /**
   * Hand, stack and command-slot cards are drawn straight to the screen after post-processing.
   * The composer's OutputPass tone-maps the whole frame (a material's toneMapped flag can't opt out),
   * which washes card art out; drawn here, faces with toneMapped=false show their exact sRGB colours.
   */
  private renderOverlay(): void {
    const r = this.renderer;
    const bg = this.scene.background;
    r.autoClear = false;
    r.shadowMap.autoUpdate = false;
    this.scene.background = null;
    r.clearDepth();
    this.camera.layers.set(OVERLAY_LAYER);
    r.render(this.scene, this.camera);
    this.camera.layers.set(0);
    this.scene.background = bg;
    r.shadowMap.autoUpdate = true;
    r.autoClear = true;
  }

  private buildLights(): void {
    this.scene.add(new THREE.HemisphereLight('#c9c2ff', '#1a120c', 0.55));
    const key = new THREE.DirectionalLight('#ffe6c4', 2.1);
    this.keyLight = key;
    key.position.set(-14, 40, 22);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -34;
    sc.right = 34;
    sc.top = 26;
    sc.bottom = -26;
    sc.near = 5;
    sc.far = 90;
    key.shadow.bias = -0.0004;
    key.shadow.radius = 4;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#7a8cff', 0.6);
    rim.position.set(18, 22, -30);
    this.scene.add(rim);
  }

  /** Procedural arcane stone table with a faint ritual circle and two player mats. */
  private buildTable(): void {
    this.tableMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        // duel layout until a game says otherwise
        uMats: { value: [new THREE.Vector4(-21.8, -0.6, 21.8, 10.6), new THREE.Vector4(-21.8, -12.6, 21.8, -1.9), new THREE.Vector4(), new THREE.Vector4()] },
        uMatCount: { value: 2 },
        uCircle: { value: new THREE.Vector3(0, -1.25, 9) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vWorld;
        void main() {
          vUv = uv;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec4 uMats[4];
        uniform int uMatCount;
        uniform vec3 uCircle;
        varying vec2 vUv; varying vec3 vWorld;
        float box(vec2 p, vec4 b) { return step(b.x, p.x) * step(p.x, b.z) * step(b.y, p.y) * step(p.y, b.w); }
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1,0)), u.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
        }
        float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
        float ring(float d, float r, float w) { return smoothstep(w, 0.0, abs(d - r)); }
        void main() {
          vec2 p = vWorld.xz;
          float n = fbm(p * 0.09) * 0.6 + fbm(p * 0.6) * 0.4;
          float vn = fbm(p * 0.21 + 3.1); float veins = smoothstep(0.012, 0.0, abs(vn - 0.5)) * 0.55;
          vec3 stone = mix(vec3(0.035, 0.035, 0.05), vec3(0.11, 0.1, 0.13), n);
          stone += veins * vec3(0.16, 0.12, 0.06);

          // ritual circle at the table's centre line, slowly breathing
          vec2 c = (p - uCircle.xy) * (9.0 / uCircle.z);
          float d = length(c);
          float pulse = 0.65 + 0.35 * sin(uTime * 0.6);
          float glyph = ring(d, 9.0, 0.06) + ring(d, 8.4, 0.03) + ring(d, 3.2, 0.04);
          float spokes = smoothstep(0.03, 0.0, abs(sin(atan(c.y, c.x) * 6.0 + uTime * 0.05))) * step(3.2, d) * step(d, 8.4);
          stone += (glyph + spokes * 0.35) * vec3(0.35, 0.24, 0.85) * 0.45 * pulse;

          // player mats: slightly darker inset with a thin gilt edge
          float mat = 0.0, edge = 0.0;
          for (int i = 0; i < 4; i++) {
            if (i >= uMatCount) break;
            float m = box(p, uMats[i]);
            mat = max(mat, m);
            edge = max(edge, m * (1.0 - box(p, uMats[i] + vec4(0.15, 0.15, -0.15, -0.15))));
          }
          stone = mix(stone, stone * 0.72, mat * 0.6);
          stone += edge * vec3(0.55, 0.42, 0.2) * 0.6;

          // light pool + vignette (wider for a multiplayer table)
          vec2 lp = p - (uMatCount > 2 ? vec2(0.0) : vec2(-3.0, 2.0));
          float pool = exp(-dot(lp, lp) * (uMatCount > 2 ? 0.0009 : 0.0022));
          stone *= 0.55 + 0.9 * pool;
          stone += vec3(0.05, 0.03, 0.01) * pool;
          gl_FragColor = vec4(stone, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const table = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), this.tableMaterial);
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.02;
    this.scene.add(table);

    // shadows land on a transparent catcher above the shader surface
    const catcher = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), new THREE.ShadowMaterial({ opacity: 0.45 }));
    catcher.rotation.x = -Math.PI / 2;
    catcher.position.y = -0.01;
    catcher.receiveShadow = true;
    this.scene.add(catcher);
  }

  /** Slow drifting embers for atmosphere. */
  private buildMotes(): void {
    const count = 320;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 90;
      pos[i * 3 + 1] = Math.random() * 14;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 64;
      seed[i] = Math.random() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float seed; uniform float uTime; varying float vA;
        void main() {
          vec3 p = position;
          float t = uTime * 0.15 + seed;
          p.y = mod(p.y + uTime * 0.25 + seed, 14.0);
          p.x += sin(t * 1.3) * 1.5; p.z += cos(t) * 1.2;
          vA = smoothstep(0.0, 2.0, p.y) * smoothstep(14.0, 9.0, p.y) * (0.5 + 0.5 * sin(seed * 7.0 + uTime * 2.0));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = 90.0 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(vec3(1.0, 0.62, 0.3) * 1.6, smoothstep(0.5, 0.0, d) * vA * 0.7);
        }`,
    });
    const motes = new THREE.Points(geo, mat);
    this.scene.add(motes);
    this.onTick((_, t) => (mat.uniforms.uTime.value = t));
  }
}
