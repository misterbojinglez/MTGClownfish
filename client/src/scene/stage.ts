import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// Camera framing measured from Arena's battlefield scenes (docs/arena-reference.md).
export const CAMERA_FOV = 34;
export const CAMERA_POS = new THREE.Vector3(0, 47.5, 18);
export const CAMERA_TARGET = new THREE.Vector3(0, 0, 0.71);
const DESIGN_ASPECT = 16 / 9;

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Children of this group stay fixed to the screen (the local hand lives here). */
  readonly cameraRig = new THREE.Group();
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly tickers = new Set<(dt: number, t: number) => void>();
  private readonly clock = new THREE.Clock();
  private tableMaterial!: THREE.ShaderMaterial;
  private shake = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 16 / 9, 4, 400);
    this.camera.position.copy(CAMERA_POS);
    this.camera.lookAt(CAMERA_TARGET);
    this.camera.add(this.cameraRig);
    this.scene.add(this.camera);

    this.scene.background = new THREE.Color('#07060a');
    this.scene.fog = new THREE.Fog('#07060a', 70, 140);

    this.buildLights();
    this.buildTable();
    this.buildMotes();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.6, 0.86);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  onTick(fn: (dt: number, t: number) => void): () => void {
    this.tickers.add(fn);
    return () => this.tickers.delete(fn);
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

    if (this.shake > 0.001) {
      const s = this.shake * this.shake * 0.35;
      this.camera.position.set(CAMERA_POS.x + (Math.random() - 0.5) * s, CAMERA_POS.y + (Math.random() - 0.5) * s, CAMERA_POS.z + (Math.random() - 0.5) * s);
      this.shake *= Math.pow(0.02, dt);
    } else if (this.shake !== 0) {
      this.shake = 0;
      this.camera.position.copy(CAMERA_POS);
    }
    this.camera.lookAt(CAMERA_TARGET);
    this.composer.render(dt);
  }

  private buildLights(): void {
    this.scene.add(new THREE.HemisphereLight('#c9c2ff', '#1a120c', 0.55));
    const key = new THREE.DirectionalLight('#ffe6c4', 2.1);
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
      uniforms: { uTime: { value: 0 } },
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
        varying vec2 vUv; varying vec3 vWorld;
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
          vec2 c = p - vec2(0.0, -1.25);
          float d = length(c);
          float pulse = 0.65 + 0.35 * sin(uTime * 0.6);
          float glyph = ring(d, 9.0, 0.06) + ring(d, 8.4, 0.03) + ring(d, 3.2, 0.04);
          float spokes = smoothstep(0.03, 0.0, abs(sin(atan(c.y, c.x) * 6.0 + uTime * 0.05))) * step(3.2, d) * step(d, 8.4);
          stone += (glyph + spokes * 0.35) * vec3(0.35, 0.24, 0.85) * 0.45 * pulse;

          // player mats: slightly darker inset with a thin gilt edge
          float matL = step(abs(p.x), 21.8) * step(-0.6, p.y) * step(p.y, 10.6);
          float matO = step(abs(p.x), 21.8) * step(-12.6, p.y) * step(p.y, -1.9);
          float mat = max(matL, matO);
          stone = mix(stone, stone * 0.72, mat * 0.6);
          float edgeL = matL * (1.0 - step(abs(p.x), 21.65) * step(-0.45, p.y) * step(p.y, 10.45));
          float edgeO = matO * (1.0 - step(abs(p.x), 21.65) * step(-12.45, p.y) * step(p.y, -2.05));
          stone += (edgeL + edgeO) * vec3(0.55, 0.42, 0.2) * 0.6;

          // light pool + vignette
          float pool = exp(-dot(p - vec2(-3.0, 2.0), p - vec2(-3.0, 2.0)) * 0.0022);
          stone *= 0.55 + 0.9 * pool;
          stone += vec3(0.05, 0.03, 0.01) * pool;
          gl_FragColor = vec4(stone, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const table = new THREE.Mesh(new THREE.PlaneGeometry(160, 110), this.tableMaterial);
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.02;
    this.scene.add(table);

    // shadows land on a transparent catcher above the shader surface
    const catcher = new THREE.Mesh(new THREE.PlaneGeometry(160, 110), new THREE.ShadowMaterial({ opacity: 0.45 }));
    catcher.rotation.x = -Math.PI / 2;
    catcher.position.y = -0.01;
    catcher.receiveShadow = true;
    this.scene.add(catcher);
  }

  /** Slow drifting embers for atmosphere. */
  private buildMotes(): void {
    const count = 220;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 70;
      pos[i * 3 + 1] = Math.random() * 14;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 40;
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
