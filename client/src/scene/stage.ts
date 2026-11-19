import * as THREE from 'three';
import gsap from 'gsap';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { onSettings, settings } from '../settings';

// Camera framing measured from Arena's battlefield scenes (docs/arena-reference.md).
export const CAMERA_FOV = 34;
const CAMERA_POS = new THREE.Vector3(0, 47.5, 18);
const CAMERA_TARGET = new THREE.Vector3(0, 0, 0.71);
const DESIGN_ASPECT = 16 / 9;
/** Where the arena floor painting's glowing ring sits: radius as a share of the image width, centre up from the bottom. */
const FLOOR_RING_RADIUS = 0.121;
/** Lava tint per colour of Magic (linear RGB, before the ramp brightens the hottest flow toward white). */
const LAVA_COLORS: Record<string, [number, number, number]> = {
  W: [1.0, 0.76, 0.36],
  U: [0.08, 0.36, 1.0],
  B: [0.48, 0.1, 0.9],
  R: [1.0, 0.24, 0.03],
  G: [0.14, 0.85, 0.12],
};
const COLORLESS_LAVA: [number, number, number] = [0.62, 0.64, 0.72];
const FLOOR_RING_V = 0.589;
/** width / height of the floor painting */
const FLOOR_ASPECT = 2752 / 1536;

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
  private readonly timer = new THREE.Timer();
  private tableMaterial!: THREE.ShaderMaterial;
  private matColorKey = '';
  private keyLight!: THREE.DirectionalLight;
  private shake = 0;
  /** the current camera view; tweened by setView */
  readonly view: CameraView = { ...HOME_VIEW, target: HOME_VIEW.target.clone() };
  private viewTween: gsap.core.Tween | null = null;
  private readonly basePos = new THREE.Vector3();
  /** a scratch camera for framing calculations */
  private readonly probe = new THREE.PerspectiveCamera();
  /** frame-rate governor: when the next frame is due (ms), and until when the table counts as moving */
  private nextFrameAt = 0;
  private wakeUntil = 0;
  /** idle frames since shadows were last drawn */
  private idleShadowFrames = 0;
  /** other systems that are mid-animation (particles still alive...) */
  private readonly busyChecks = new Set<() => boolean>();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // shadows are drawn only on frames where something may have moved (see frame())
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
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
    // anything the player does may move something: draw at the full rate for a moment
    for (const ev of ['pointermove', 'pointerdown', 'wheel', 'keydown'] as const) window.addEventListener(ev, () => this.wake(), { passive: true });
    onSettings((st) => {
      const ratio = st.resolution === 'high' ? Math.min(window.devicePixelRatio, 2) : 1;
      if (this.renderer.getPixelRatio() !== ratio) {
        this.renderer.setPixelRatio(ratio);
        this.resize();
      }
      const low = st.floorDetail === 'low';
      if (('LOW_DETAIL' in this.tableMaterial.defines) !== low) {
        if (low) this.tableMaterial.defines.LOW_DETAIL = '';
        else delete this.tableMaterial.defines.LOW_DETAIL;
        this.tableMaterial.needsUpdate = true;
      }
      this.wake();
    });
    this.resize();
    this.renderer.setAnimationLoop((now: number) => this.frame(now));
  }

  /** Draw at the full frame rate for a while (seconds): input, incoming changes. */
  wake(seconds = 0.6): void {
    this.wakeUntil = Math.max(this.wakeUntil, performance.now() + seconds * 1000);
  }

  /** Register a check for something mid-animation that gsap doesn't drive (live particles). */
  onBusy(check: () => boolean): void {
    this.busyChecks.add(check);
  }

  /** Something on screen is moving fast enough to want the full frame rate. */
  private moving(now: number): boolean {
    if (now < this.wakeUntil || this.shake > 0.001 || this.hitAmt > 0.002) return true;
    // card flights, camera glides, counters: gsap removes finished tweens from its global timeline
    if (gsap.globalTimeline.getChildren(false, true, true).length > 0) return true;
    for (const busy of this.busyChecks) if (busy()) return true;
    return false;
  }

  /** Milliseconds between frames under the frame-rate setting; 0 = every display refresh. */
  private frameInterval(moving: boolean): number {
    switch (settings.frameRate) {
      case 'max':
        return 0;
      case '60':
        return 1000 / 60;
      case '30':
        return 1000 / 30;
      default:
        return moving ? 1000 / 60 : 1000 / 30;
    }
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
   * Tints each mat's lava cracks with its commander's colour identity (WUBRG letters, tableMats order):
   * one colour flows alone, several drift around the mat as a gradient. No identity keeps molten orange.
   */
  setMatColors(identities: (string | undefined)[]): void {
    const key = identities.map((id) => id ?? '-').join('|');
    if (key === this.matColorKey) return;
    this.matColorKey = key;
    const u = this.tableMaterial.uniforms;
    const n = [0, 0, 0, 0];
    identities.slice(0, 4).forEach((id, i) => {
      if (id === undefined) return;
      const cols = id === '' ? [COLORLESS_LAVA] : [...id].map((c) => LAVA_COLORS[c]).filter(Boolean);
      cols.slice(0, 5).forEach((c, k) => (u.uMatCols.value[i * 5 + k] as THREE.Color).setRGB(c[0], c[1], c[2]));
      n[i] = Math.min(5, cols.length);
    });
    u.uMatColN.value = n;
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
    // the floor painting's glowing ring (12.1% of its width) lands on the table's ritual circle
    const floorW = circle.r / FLOOR_RING_RADIUS;
    u.uFloorRect.value.set(circle.x, circle.z, floorW, floorW / FLOOR_ASPECT);
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
    this.renderer.shadowMap.needsUpdate = true;
    this.wake();
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

  private frame(now: number): void {
    // the display refreshes at 60-144 Hz; draw only as often as the setting asks (Auto: 60 fps while
    // anything moves, 30 when the table is still, where the lava and embers drift slowly enough to look the same)
    const moving = this.moving(now);
    const interval = this.frameInterval(moving);
    if (interval > 0) {
      // 1 ms early is fine: vsync timestamps jitter, and a frame missed by a hair would wait a whole refresh
      if (now < this.nextFrameAt - 1) return;
      this.nextFrameAt += interval;
      if (this.nextFrameAt < now) this.nextFrameAt = now;
    }
    // shadows only change when something moves; while still, a slow refresh keeps flyers' bobbing shadows along
    if (moving || ++this.idleShadowFrames >= 3) {
      this.renderer.shadowMap.needsUpdate = true;
      this.idleShadowFrames = 0;
    }
    this.timer.update(now);
    const dt = Math.min(this.timer.getDelta(), 0.05);
    const t = this.timer.getElapsed();
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
    this.scene.background = null;
    r.clearDepth();
    this.camera.layers.set(OVERLAY_LAYER);
    r.render(this.scene, this.camera);
    this.camera.layers.set(0);
    this.scene.background = bg;
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
        // each mat's lava colours (up to 5 per mat, mat i at [i*5]); a count of 0 is classic molten orange
        uMatCols: { value: Array.from({ length: 20 }, () => new THREE.Color()) },
        uMatColN: { value: [0, 0, 0, 0] },
        uCircle: { value: new THREE.Vector3(0, -1.25, 9) },
        // the painted arena floor: centre x/z of its ritual ring, and its world width/height
        uFloor: { value: null as THREE.Texture | null },
        uFloorRect: { value: new THREE.Vector4(0, -1.25, 9 / FLOOR_RING_RADIUS, 9 / FLOOR_RING_RADIUS / FLOOR_ASPECT) },
        uHasFloor: { value: 0 },
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
        uniform vec3 uMatCols[20];
        uniform int uMatColN[4];
        uniform vec3 uCircle;
        uniform sampler2D uFloor;
        uniform vec4 uFloorRect;
        uniform float uHasFloor;
        varying vec2 vUv; varying vec3 vWorld;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1,0)), u.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
        }
        // Low floor detail: fewer noise layers (the finest ones), no fine warp, no drifting crust
        #ifdef LOW_DETAIL
        #define FBM_OCTAVES 2
        #else
        #define FBM_OCTAVES 5
        #endif
        float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < FBM_OCTAVES; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
        float ring(float d, float r, float w) { return smoothstep(w, 0.0, abs(d - r)); }
        // how far round a box's edge (centre-relative q, half-size h) a point lies, 0..1, so colours share it evenly
        float perimeter(vec2 q, vec2 h) {
          float s;
          if (abs(q.x) / h.x >= abs(q.y) / h.y) s = q.x > 0.0 ? q.y + h.y : 2.0 * h.y + 2.0 * h.x + (h.y - q.y);
          else s = q.y > 0.0 ? 2.0 * h.y + (h.x - q.x) : 4.0 * h.y + 2.0 * h.x + (q.x + h.x);
          return s / (4.0 * (h.x + h.y));
        }
        float sdBox(vec2 p, vec4 b) { vec2 q = abs(p - (b.xy + b.zw) * 0.5) - (b.zw - b.xy) * 0.5; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0); }
        void main() {
          vec2 p = vWorld.xz;

          // the painted arena floor over the procedural stone, its ring on the table's circle; the painting
          // fades into darker stone past its edges so the arena never ends in a hard line. Worked out first:
          // where it covers fully, the stone beneath can't be seen and isn't computed
          float inside = 0.0;
          vec3 floorCol = vec3(0.0);
          if (uHasFloor > 0.5) {
            vec2 fuv = vec2(0.5 + (p.x - uFloorRect.x) / uFloorRect.z, ${FLOOR_RING_V.toFixed(3)} - (p.y - uFloorRect.y) / uFloorRect.w);
            floorCol = texture2D(uFloor, clamp(fuv, 0.0, 1.0)).rgb;
            inside = smoothstep(0.0, 0.06, fuv.x) * smoothstep(1.0, 0.94, fuv.x) * smoothstep(0.0, 0.08, fuv.y) * smoothstep(1.0, 0.92, fuv.y);
          }
          vec3 stone;
          if (inside > 0.999) {
            stone = floorCol * 0.92;
          } else {
            float n = fbm(p * 0.09) * 0.6 + fbm(p * 0.6) * 0.4;
            float vn = fbm(p * 0.21 + 3.1); float veins = smoothstep(0.012, 0.0, abs(vn - 0.5)) * 0.55;
            stone = mix(vec3(0.035, 0.035, 0.05), vec3(0.11, 0.1, 0.13), n);
            stone += veins * vec3(0.16, 0.12, 0.06);

            // ritual circle at the table's centre line, slowly breathing
            vec2 c = (p - uCircle.xy) * (9.0 / uCircle.z);
            float d = length(c);
            float pulse = 0.65 + 0.35 * sin(uTime * 0.6);
            float glyph = ring(d, 9.0, 0.06) + ring(d, 8.4, 0.03) + ring(d, 3.2, 0.04);
            float spokes = smoothstep(0.03, 0.0, abs(sin(atan(c.y, c.x) * 6.0 + uTime * 0.05))) * step(3.2, d) * step(d, 8.4);
            stone += (glyph + spokes * 0.35) * vec3(0.35, 0.24, 0.85) * 0.45 * pulse;
            if (uHasFloor > 0.5) stone = mix(stone * 0.35, floorCol * 0.92, inside);
          }

          // player mats: slightly darker inset, bounded by cracks in the stone with lava flowing beneath.
          // Distances are measured from a gently warped point so the edges meander organically. The warp moves
          // a point at most ~1.06 units and a box's distance changes no faster than the point moves, while
          // nothing about an edge (crack, scorch, offshoots, glow) shows more than ~2.5 units out: so farther
          // than 3.6 from every edge only the inset darkening applies, and the rest is skipped
          float near = 1e3, mat0 = 0.0;
          for (int i = 0; i < 4; i++) {
            if (i >= uMatCount) break;
            float s0 = sdBox(p, uMats[i]);
            near = min(near, abs(s0));
            if (s0 < 0.0) mat0 = 1.0;
          }
          if (near > 3.6) {
            stone = mix(stone, stone * 0.82, mat0 * 0.5);
          } else {
          vec2 pw = p + (vec2(fbm(p * 0.33 + 11.0), fbm(p * 0.33 + 27.0)) - 0.5) * 1.1
                      + (vec2(noise(p * 1.7), noise(p * 1.7 + 5.0)) - 0.5) * 0.3
          #ifndef LOW_DETAIL
                      + (vec2(noise(p * 4.3 + 2.0), noise(p * 4.3 + 8.0)) - 0.5) * 0.1
          #endif
                      ;
          float mat = 0.0, e = 1e3;
          int owner = 0;
          for (int i = 0; i < 4; i++) {
            if (i >= uMatCount) break;
            float s = sdBox(pw, uMats[i]);
            mat = max(mat, smoothstep(0.1, -0.1, s));
            if (abs(s) < e) { e = abs(s); owner = i; }
          }
          // the nearest mat's colours: one alone, or several blending as they drift around its edge
          vec3 tint = vec3(1.0, 0.3, 0.04);
          int nc = uMatColN[owner];
          if (nc > 0) {
            vec4 b = uMats[owner];
            vec2 q = p - (b.xy + b.zw) * 0.5, h = (b.zw - b.xy) * 0.5;
            float x = fract(perimeter(q, h) + uTime * 0.012) * float(nc);
            int k = int(floor(x));
            tint = mix(uMatCols[owner * 5 + k], uMatCols[owner * 5 + (k + 1) % nc], smoothstep(0.15, 0.85, fract(x)));
          }
          stone = mix(stone, stone * 0.82, mat * 0.5);

          // the crack: width wanders and nearly pinches shut in places; hairline offshoots branch off it
          float w = 0.045 + 0.13 * smoothstep(0.25, 0.8, noise(p * 0.45 + 3.0));
          float crack = smoothstep(w, w * 0.3, e);
          float ridge = 1.0 - abs(noise(pw * 2.2 + vec2(4.0, 9.0)) * 2.0 - 1.0);
          float branch = smoothstep(0.965 + e * 0.02, 0.99, ridge) * smoothstep(1.3, 0.1, e) * step(0.35, noise(p * 0.8 + 17.0));

          // molten flow: slow drifting heat with faster ripples, hottest at the crack's centre
          float t = uTime;
          float heat = fbm(pw * 0.9 + vec2(t * 0.22, -t * 0.15)) * 1.1 + noise(pw * 3.1 - vec2(t * 0.5, t * 0.35)) * 0.35 - 0.2;
          heat = clamp(heat * (0.85 + 0.15 * sin(t * 0.9 + p.x * 0.15 + p.y * 0.1)), 0.0, 1.0);
          vec3 lava = mix(tint * 0.35, tint * 1.25, smoothstep(0.15, 0.6, heat));
          lava = mix(lava, mix(tint * 1.2, vec3(1.6, 1.5, 1.3), 0.45), smoothstep(0.65, 0.95, heat));
          lava *= 0.65 + 0.55 * smoothstep(w, 0.0, e);
          // cooled crust drifts over stretches of the flow, leaving it dim and dark
          #ifdef LOW_DETAIL
          float crust = 0.0;
          #else
          float crust = smoothstep(0.5, 0.7, fbm(pw * 0.6 + vec2(-t * 0.05, t * 0.04) + 40.0));
          #endif
          lava = mix(lava, tint * 0.12 + 0.02, crust * 0.8);

          // scorched lip, then heat glowing out across the stone
          stone *= 1.0 - smoothstep(w + 0.35, w, e) * (1.0 - crack) * 0.45;
          stone += tint * 0.55 * exp(-max(e - w, 0.0) * 3.0) * (0.25 + 0.75 * heat) * (1.0 - crust * 0.7) * 0.35;
          // offshoots: dark fissures with only a faint ember line deep inside
          stone = mix(stone, mix(vec3(0.02, 0.01, 0.01), lava * 0.45, smoothstep(0.985, 1.0, ridge)), branch * (1.0 - crack));
          stone = mix(stone, lava, crack);
          }

          if (uHasFloor < 0.5) {
            // light pool + vignette (wider for a multiplayer table)
            vec2 lp = p - (uMatCount > 2 ? vec2(0.0) : vec2(-3.0, 2.0));
            float pool = exp(-dot(lp, lp) * (uMatCount > 2 ? 0.0009 : 0.0022));
            stone *= 0.55 + 0.9 * pool;
            stone += vec3(0.05, 0.03, 0.01) * pool;
          }
          gl_FragColor = vec4(stone, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    new THREE.TextureLoader().load('/table-floor.jpg', (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.tableMaterial.uniforms.uFloor.value = tex;
      this.tableMaterial.uniforms.uHasFloor.value = 1;
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
  /**
   * Embers: sparks rising off the arena floor, drifting on a light breeze, flickering and cooling from
   * white-gold to deep red before they die. They spawn where the floor painting had its (now removed)
   * painted embers: mostly the outer stone and rune ring, clusters by the two torches, few over the
   * battlefields. Spawn points live in the painting's own coordinates and go through the same mapping as
   * the floor (uFloorRect), so they stay put on the painting whatever the table layout.
   */
  private buildMotes(): void {
    const count = 900;
    const uv = new Float32Array(count * 2);
    const seed = new Float32Array(count);
    const kind = new Float32Array(count);
    // the painting's torches (u, v from the bottom) and its ritual ring centre
    const torches = [[0.085, 0.975], [0.89, 0.985]];
    const ringU = 0.5025;
    for (let i = 0; i < count; i++) {
      let u = 0;
      let v = 0;
      const r = Math.random();
      if (r < 0.14) {
        // by a torch
        const t = torches[i % 2];
        u = t[0] + (Math.random() - 0.5) * 0.06;
        v = t[1] - Math.random() * 0.1;
      } else {
        // anywhere on the floor, kept mostly to the outer stone: rejection-sample against distance from the ring
        for (let tries = 0; tries < 12; tries++) {
          u = Math.random();
          v = Math.random();
          const dx = (u - ringU) * FLOOR_ASPECT;
          const dy = v - FLOOR_RING_V;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (Math.random() < Math.min(1, Math.max(0.08, (d - 0.42) * 2.2))) break;
        }
      }
      uv[i * 2] = u;
      uv[i * 2 + 1] = v;
      seed[i] = Math.random();
      // 1 in 20 is a big soft out-of-focus ember
      kind[i] = Math.random() < 0.05 ? 1 : 0;
    }
    const geo = new THREE.BufferGeometry();
    // positions are computed in the shader; the attribute only sizes the draw
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('spawn', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('kind', new THREE.BufferAttribute(kind, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uFloorRect: this.tableMaterial.uniforms.uFloorRect,
      },
      vertexShader: /* glsl */ `
        attribute vec2 spawn; attribute float seed; attribute float kind;
        uniform float uTime; uniform vec4 uFloorRect;
        varying float vAlpha; varying vec3 vColor; varying float vSoft;
        void main() {
          // each ember loops through a life of 3-7 s, starting at a different moment
          float life = mix(3.0, 7.0, fract(seed * 7.13));
          float age = fract(uTime / life + seed);
          float cycle = floor(uTime / life + seed);
          // a new spot each life, near its spawn point
          vec2 jitter = vec2(fract(sin(cycle * 12.9898 + seed * 78.233) * 43758.5453), fract(sin(cycle * 39.346 + seed * 11.135) * 24634.6345)) - 0.5;
          vec2 uv = spawn + jitter * 0.03;
          vec3 p = vec3(uFloorRect.x + (uv.x - 0.5) * uFloorRect.z, 0.05, uFloorRect.y + (${FLOOR_RING_V.toFixed(3)} - uv.y) * uFloorRect.w);
          // rise, speeding up a little; drift with the breeze and swirl more as it climbs
          float rise = mix(1.6, 3.2, fract(seed * 3.7));
          p.y += age * life * rise * (0.8 + 0.4 * age);
          float t = uTime * mix(0.6, 1.4, fract(seed * 5.1)) + seed * 40.0;
          p.x += age * 2.4 + sin(t * 1.3) * (0.4 + 1.6 * age) + sin(t * 3.1 + seed) * 0.25;
          p.z += cos(t * 0.9) * (0.3 + 1.2 * age) - age * 0.8;
          // quick flare in, long fade out, flicker throughout
          float flicker = 0.62 + 0.38 * sin(uTime * mix(9.0, 17.0, fract(seed * 9.3)) + seed * 60.0);
          vAlpha = smoothstep(0.0, 0.06, age) * pow(1.0 - age, 1.6) * flicker;
          // cools from white-gold to orange to ember red
          vColor = mix(vec3(1.0, 0.68, 0.28), vec3(1.0, 0.38, 0.08), smoothstep(0.0, 0.45, age));
          vColor = mix(vColor, vec3(0.65, 0.1, 0.04), smoothstep(0.45, 1.0, age));
          vSoft = kind;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          // sized for a camera 40-90 units away: sparks a few pixels across, soft embers much larger
          float size = kind > 0.5 ? 2400.0 : mix(380.0, 720.0, fract(seed * 13.7)) * (1.0 - 0.45 * age);
          gl_PointSize = size / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying float vAlpha; varying vec3 vColor; varying float vSoft;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          // sparks: a warm core in an orange halo; out-of-focus ones: a faint deep-orange disc
          if (vSoft > 0.5) {
            gl_FragColor = vec4(vec3(1.0, 0.42, 0.12) * 1.1, smoothstep(0.5, 0.3, d) * 0.11 * vAlpha);
            return;
          }
          float halo = pow(smoothstep(0.5, 0.0, d), 2.2) * 0.75;
          float core = smoothstep(0.1, 0.0, d);
          vec3 col = mix(vColor * 1.15, mix(vColor, vec3(1.0, 0.85, 0.6), 0.45) * 1.4, core);
          gl_FragColor = vec4(col, (halo + core * 0.8) * vAlpha);
        }`,
    });
    const motes = new THREE.Points(geo, mat);
    motes.frustumCulled = false;
    this.scene.add(motes);
    this.onTick((_, t) => (mat.uniforms.uTime.value = t));
    // spawn points are shuffled, so the first third is a fair sample of the whole floor
    onSettings((st) => {
      motes.visible = st.particles !== 'off';
      geo.setDrawRange(0, st.particles === 'reduced' ? Math.round(count / 3) : count);
    });
  }
}
