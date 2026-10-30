/**
 * Sound: an original, fully synthesized set (WebAudio, no sample files). Every effect is built from
 * oscillators and filtered noise at play time, so spells can be tinted by colour and impacts scaled
 * by size. Effects go through a shared reverb; a quiet ambient bed sits underneath.
 */

type Color = 'W' | 'U' | 'B' | 'R' | 'G' | 'M' | 'C';

interface ToneOpts {
  type?: OscillatorType;
  attack?: number;
  /** exponential glide target frequency over the note */
  glide?: number;
  detune?: number;
  vibrato?: number;
  pan?: number;
  wet?: number;
}

interface NoiseOpts {
  filter?: BiquadFilterType;
  from: number;
  to?: number;
  q?: number;
  attack?: number;
  pan?: number;
  wet?: number;
}

// chord tones per colour (Hz): bright major for white, airy suspended blue, dark minor black,
// biting red, warm open green, golden lydian for multicolour, hollow fifths for colourless
const CHORDS: Record<Color, number[]> = {
  W: [523.25, 659.25, 783.99, 1046.5],
  U: [440, 587.33, 659.25, 880],
  B: [196, 233.08, 293.66, 277.18],
  R: [329.63, 392, 493.88, 466.16],
  G: [349.23, 440, 523.25, 698.46],
  M: [392, 493.88, 554.37, 739.99],
  C: [261.63, 392, 523.25, 783.99],
};

const STORE_KEY = 'tabletop.audio';

function colorOf(colors: string | undefined): Color {
  const cs = (colors ?? '').replace(/[^WUBRG]/g, '');
  if (cs.length > 1) return 'M';
  return (cs as Color) || 'C';
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private ambBus!: GainNode;
  private reverb!: ConvolverNode;
  private noiseBuf!: AudioBuffer;
  private last = new Map<string, number>();
  private ambientOn = false;
  muted = false;
  volume = 0.8;

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
      if (typeof saved.muted === 'boolean') this.muted = saved.muted;
      if (typeof saved.volume === 'number') this.volume = saved.volume;
    } catch {
      /* storage unavailable: defaults */
    }
    // browsers only allow audio after a gesture
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
  }

  private unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.ambBus = ctx.createGain();
    this.ambBus.gain.value = 0.55;
    this.ambBus.connect(this.master);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.4, 2.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.9;
    this.reverb.connect(wet).connect(this.master);

    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.startAmbient();
  }

  private save(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ muted: this.muted, volume: this.volume }));
    } catch {
      /* ignore */
    }
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    this.save();
    return this.muted;
  }

  // ---- building blocks ----------------------------------------------------------------------------

  private impulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  /** Route a voice to the sfx bus (dry) and the reverb (wet), optionally panned. */
  private out(node: AudioNode, pan = 0, wet = 0.2, bus?: AudioNode): void {
    const ctx = this.ctx!;
    let tail: AudioNode = node;
    if (pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      tail.connect(p);
      tail = p;
    }
    tail.connect(bus ?? this.sfxBus);
    if (wet > 0) {
      const g = ctx.createGain();
      g.gain.value = wet;
      tail.connect(g).connect(this.reverb);
    }
  }

  private tone(freq: number, t0: number, dur: number, gain: number, o: ToneOpts = {}): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (o.glide) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.glide), t0 + dur);
    if (o.detune) osc.detune.value = o.detune;
    if (o.vibrato) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 5.5;
      depth.gain.value = freq * o.vibrato;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(t0);
      lfo.stop(t0 + dur + 0.05);
    }
    const env = ctx.createGain();
    const a = o.attack ?? 0.005;
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + a);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(env);
    this.out(env, o.pan, o.wet ?? 0.2);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  private noise(t0: number, dur: number, gain: number, o: NoiseOpts): GainNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.filter ?? 'bandpass';
    f.frequency.setValueAtTime(o.from, t0);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
    f.Q.value = o.q ?? 1;
    const env = ctx.createGain();
    const a = o.attack ?? 0.005;
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + a);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(env);
    this.out(env, o.pan, o.wet ?? 0.15);
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + dur + 0.05);
    return env;
  }

  /** Start time for a sound, or null if muted/locked or the same sound just played (bursts of events). */
  private begin(key: string, minGap = 0.04): number | null {
    const ctx = this.ctx;
    if (!ctx || this.muted) return null;
    const now = ctx.currentTime;
    if (now - (this.last.get(key) ?? -1) < minGap) return null;
    this.last.set(key, now);
    return now + 0.005;
  }

  private vary(f: number, cents = 30): number {
    return f * Math.pow(2, ((Math.random() * 2 - 1) * cents) / 1200);
  }

  // ---- interface ----------------------------------------------------------------------------------

  click(): void {
    const t = this.begin('click', 0.03);
    if (t == null) return;
    this.tone(1300, t, 0.05, 0.07, { glide: 760, wet: 0.05 });
    this.noise(t, 0.025, 0.04, { filter: 'highpass', from: 4000, wet: 0 });
  }

  hover(): void {
    const t = this.begin('hover', 0.05);
    if (t == null) return;
    this.tone(this.vary(2300, 60), t, 0.035, 0.018, { wet: 0.05 });
  }

  chime(): void {
    const t = this.begin('chime', 0.2);
    if (t == null) return;
    [880, 1318.5].forEach((f, i) => this.tone(f, t + i * 0.07, 0.6, 0.05, { type: 'triangle', wet: 0.5 }));
  }

  // ---- cards --------------------------------------------------------------------------------------

  draw(pan = 0, quiet = false): void {
    const t = this.begin('draw', 0.06);
    if (t == null) return;
    const g = quiet ? 0.05 : 0.11;
    this.noise(t, 0.16, g, { from: this.vary(1500, 200), to: 4200, q: 1.4, attack: 0.03, pan });
  }

  place(pan = 0): void {
    const t = this.begin('place', 0.05);
    if (t == null) return;
    this.noise(t, 0.08, 0.13, { filter: 'lowpass', from: 1100, pan, wet: 0.05 });
    this.tone(this.vary(120), t, 0.13, 0.14, { glide: 60, pan, wet: 0.05 });
  }

  land(pan = 0): void {
    const t = this.begin('land', 0.08);
    if (t == null) return;
    this.tone(this.vary(85, 50), t, 0.32, 0.32, { glide: 38, pan, wet: 0.15 });
    this.noise(t, 0.22, 0.16, { filter: 'lowpass', from: 520, to: 140, pan, wet: 0.1 });
    this.noise(t + 0.02, 0.1, 0.05, { filter: 'bandpass', from: 2400, q: 2, pan, wet: 0.1 });
  }

  tap(pan = 0): void {
    const t = this.begin('tap', 0.05);
    if (t == null) return;
    this.noise(t, 0.04, 0.05, { filter: 'bandpass', from: 2600, q: 3, pan, wet: 0.05 });
    this.tone(this.vary(520), t, 0.05, 0.04, { glide: 380, pan, wet: 0.05 });
  }

  token(pan = 0): void {
    const t = this.begin('token', 0.06);
    if (t == null) return;
    this.tone(320, t, 0.09, 0.12, { glide: 980, pan, wet: 0.2 });
    this.tone(1568, t + 0.06, 0.45, 0.04, { type: 'triangle', pan, wet: 0.5 });
  }

  /** A spell heads to the stack: a rising whoosh and a colour chord swelling in. */
  cast(colors?: string, pan = 0): void {
    const t = this.begin('cast', 0.12);
    if (t == null) return;
    const chord = CHORDS[colorOf(colors)];
    this.noise(t, 0.5, 0.12, { from: 260, to: 3200, q: 1.2, attack: 0.25, pan, wet: 0.3 });
    chord.forEach((f, i) => this.tone(f, t + 0.05 + i * 0.045, 0.9, 0.035, { type: 'triangle', attack: 0.3, vibrato: 0.004, pan, wet: 0.6 }));
  }

  /** A permanent lands: a thump scaled by size, then the colour chord rings out. */
  etb(colors?: string, power = 0, pan = 0): void {
    const t = this.begin('etb', 0.08);
    if (t == null) return;
    const big = Math.min(1, power / 7);
    const chord = CHORDS[colorOf(colors)];
    this.tone(95 - big * 30, t, 0.35 + big * 0.4, 0.22 + big * 0.25, { glide: 36, pan, wet: 0.2 });
    this.noise(t, 0.2 + big * 0.3, 0.1 + big * 0.12, { filter: 'lowpass', from: 900, to: 120, pan, wet: 0.2 });
    chord.forEach((f, i) => this.tone(f, t + 0.02 + i * 0.03, 1.3, 0.04, { type: 'triangle', pan, wet: 0.7 }));
    this.tone(chord[0] * 4, t + 0.12, 0.6, 0.015, { pan, wet: 0.8 });
  }

  /** An activated or triggered ability: a short two-note ping. */
  ability(colors?: string, pan = 0): void {
    const t = this.begin('ability', 0.08);
    if (t == null) return;
    const c = CHORDS[colorOf(colors)];
    this.tone(c[0] * 2, t, 0.4, 0.06, { type: 'triangle', pan, wet: 0.5 });
    this.tone(c[2] * 2, t + 0.07, 0.5, 0.05, { type: 'triangle', pan, wet: 0.6 });
  }

  death(pan = 0): void {
    const t = this.begin('death', 0.1);
    if (t == null) return;
    // crackle: noise with stepped random amplitude, sweeping down like burning paper
    const env = this.noise(t, 0.8, 0.14, { from: 2400, to: 260, q: 0.8, attack: 0.02, pan, wet: 0.3 });
    for (let i = 1; i < 16; i++) env.gain.setValueAtTime(0.02 + Math.random() * 0.12 * (1 - i / 16), t + i * 0.045);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    this.tone(150, t, 0.7, 0.1, { type: 'sawtooth', glide: 55, pan, wet: 0.3 });
  }

  exile(pan = 0): void {
    const t = this.begin('exile', 0.1);
    if (t == null) return;
    this.noise(t, 0.6, 0.1, { filter: 'highpass', from: 1500, to: 7000, attack: 0.45, pan, wet: 0.6 });
    [800, 1200, 1800].forEach((f, i) => this.tone(f, t + i * 0.06, 0.6, 0.03, { glide: f * 2.2, pan, wet: 0.7 }));
  }

  // ---- combat and damage --------------------------------------------------------------------------

  attack(): void {
    const t = this.begin('attack', 0.3);
    if (t == null) return;
    this.noise(t, 0.35, 0.12, { from: 220, to: 1400, q: 1.5, attack: 0.12, wet: 0.2 });
    this.tone(72, t, 0.3, 0.3, { glide: 45, wet: 0.2 });
    this.tone(72, t + 0.16, 0.3, 0.22, { glide: 45, wet: 0.2 });
  }

  block(pan = 0): void {
    const t = this.begin('block', 0.12);
    if (t == null) return;
    // inharmonic partials read as metal
    [523, 1237, 1871, 2693].forEach((f, i) => this.tone(this.vary(f, 15), t, 0.7 - i * 0.12, 0.06 / (i + 1), { type: 'triangle', pan, wet: 0.4 }));
    this.noise(t, 0.06, 0.12, { filter: 'highpass', from: 3000, pan, wet: 0.2 });
  }

  whoosh(pan = 0): void {
    const t = this.begin('whoosh', 0.05);
    if (t == null) return;
    this.noise(t, 0.22, 0.07, { from: 500, to: 2200, q: 1, attack: 0.12, pan, wet: 0.1 });
  }

  hit(amount: number, onPlayer: boolean, pan = 0): void {
    const t = this.begin('hit', 0.04);
    if (t == null) return;
    const s = Math.min(1, amount / 8);
    this.tone(onPlayer ? 100 : 140, t, 0.25 + s * 0.25, 0.25 + s * 0.3, { glide: 38, pan, wet: 0.2 });
    this.noise(t, 0.12 + s * 0.1, 0.14 + s * 0.12, { filter: 'lowpass', from: 1800, to: 300, pan, wet: 0.2 });
    if (onPlayer) this.noise(t, 0.05, 0.1, { filter: 'highpass', from: 2500, pan, wet: 0.1 });
  }

  zap(colors?: string, pan = 0): void {
    const t = this.begin('zap', 0.08);
    if (t == null) return;
    const c = CHORDS[colorOf(colors)];
    this.tone(c[3] * 2, t, 0.35, 0.05, { type: 'sawtooth', glide: c[0] / 2, pan, wet: 0.4 });
    this.noise(t, 0.3, 0.08, { from: 3000, to: 600, q: 2, pan, wet: 0.3 });
  }

  lifeGain(pan = 0): void {
    const t = this.begin('life', 0.2);
    if (t == null) return;
    [1046.5, 1318.5, 1568, 2093].forEach((f, i) => this.tone(f, t + i * 0.07, 0.6, 0.045, { type: 'triangle', pan, wet: 0.6 }));
  }

  // ---- turn and game ------------------------------------------------------------------------------

  yourTurn(): void {
    const t = this.begin('turn', 0.5);
    if (t == null) return;
    [146.83, 220, 293.66, 369.99].forEach((f) => {
      this.tone(f, t, 1.4, 0.05, { type: 'sawtooth', attack: 0.12, wet: 0.5 });
      this.tone(f * 1.003, t, 1.4, 0.04, { type: 'triangle', attack: 0.12, wet: 0.5 });
    });
  }

  opponentTurn(): void {
    const t = this.begin('turn', 0.5);
    if (t == null) return;
    [110, 164.81].forEach((f) => this.tone(f, t, 0.9, 0.06, { type: 'triangle', attack: 0.08, wet: 0.5 }));
  }

  victory(): void {
    const t = this.begin('end', 1);
    if (t == null) return;
    [[261.63, 329.63, 392], [349.23, 440, 523.25], [392, 493.88, 587.33], [523.25, 659.25, 783.99, 1046.5]].forEach((ch, i) =>
      ch.forEach((f) => this.tone(f, t + i * 0.28, i === 3 ? 2.2 : 0.5, 0.05, { type: 'sawtooth', attack: 0.04, wet: 0.5 })),
    );
  }

  defeat(): void {
    const t = this.begin('end', 1);
    if (t == null) return;
    [[220, 261.63, 329.63], [174.61, 207.65, 261.63], [146.83, 174.61, 220]].forEach((ch, i) =>
      ch.forEach((f) => this.tone(f, t + i * 0.5, i === 2 ? 2.4 : 0.7, 0.05, { type: 'triangle', attack: 0.1, wet: 0.6 })),
    );
  }

  // ---- ambience -----------------------------------------------------------------------------------

  /** A low pad with a slowly breathing filter, plus the odd distant shimmer. */
  private startAmbient(): void {
    if (this.ambientOn || !this.ctx) return;
    this.ambientOn = true;
    const ctx = this.ctx;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    filter.Q.value = 0.7;
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = 0.05;
    depth.gain.value = 160;
    lfo.connect(depth).connect(filter.frequency);
    lfo.start();
    const pad = ctx.createGain();
    pad.gain.value = 0.04;
    for (const [f, d] of [[55, 0], [82.41, 4], [110, -5], [164.81, 3]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = d;
      o.connect(filter);
      o.start();
    }
    filter.connect(pad);
    pad.connect(this.ambBus);
    const send = ctx.createGain();
    send.gain.value = 0.3;
    pad.connect(send).connect(this.reverb);

    const sparkle = () => {
      if (this.ctx && !this.muted) {
        const t = this.ctx.currentTime + 0.01;
        const notes = [659.25, 783.99, 987.77, 1174.66, 1318.5];
        const f = notes[Math.floor(Math.random() * notes.length)];
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t);
        env.gain.exponentialRampToValueAtTime(0.012, t + 0.6);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
        osc.connect(env);
        this.out(env, Math.random() * 1.6 - 0.8, 1, this.ambBus);
        osc.start(t);
        osc.stop(t + 3.6);
      }
      setTimeout(sparkle, 6000 + Math.random() * 9000);
    };
    setTimeout(sparkle, 4000);
  }
}

export const sfx = new AudioEngine();
