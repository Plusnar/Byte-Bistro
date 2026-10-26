/**
 * Sound effects synthesised with WebAudio: no audio files ship with the game.
 *
 * One-shots (`play`) are built from noise and oscillators each time they sound;
 * loops (`loop`) keep running until the handle they return is stopped. Browsers
 * only let audio start after the page has been clicked or typed into, so the
 * context is resumed on the first such event and anything asked for before then
 * is silently skipped.
 */

export type SfxId =
  | "thunder"
  | "zap"
  | "warning"
  | "splat"
  | "throw"
  | "crash"
  | "horn"
  | "beam"
  | "abduct"
  | "land"
  | "spray"
  | "squeak"
  // The kitchen itself
  | "pickup"
  | "place"
  | "trash"
  | "chop"
  | "scrub"
  | "ding"
  | "burnt"
  | "ignite"
  | "puff"
  | "toss"
  | "bonk"
  | "serve"
  | "combo"
  | "wrong"
  | "fail"
  | "tick"
  | "start"
  | "win"
  | "lose"
  | "hey";

export type LoopId = "siren" | "ufo" | "engine" | "water" | "sizzle";

export interface LoopHandle {
  /** Fades the loop out over `seconds` and stops it. */
  stop(seconds?: number): void;
  /** 0..1 loudness of the loop, eased to over a short time. */
  setLevel(level: number): void;
}

const SILENT_LOOP: LoopHandle = { stop: () => undefined, setLevel: () => undefined };

type AudioContextConstructor = new () => AudioContext;

export class SynthSfx {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly unlock = (): void => {
    this.ensureContext();
    void this.context?.resume();
  };

  constructor(private readonly volume = 0.55) {
    if (typeof window === "undefined") return;
    window.addEventListener("pointerdown", this.unlock, { passive: true });
    window.addEventListener("keydown", this.unlock);
  }

  dispose(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("pointerdown", this.unlock);
      window.removeEventListener("keydown", this.unlock);
    }
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.master = null;
  }

  play(id: SfxId, gain = 1): void {
    const context = this.ready();
    if (!context || !this.master) return;
    const now = context.currentTime;
    switch (id) {
      case "thunder":
        // A crack, then a long rumble rolling off.
        this.noiseBurst(now, 0.12, 0.9 * gain, { type: "highpass", from: 2400, to: 900 });
        this.noiseBurst(now + 0.05, 2.6, 0.75 * gain, { type: "lowpass", from: 900, to: 90 });
        this.tone(now, 1.6, 0.4 * gain, "sine", 55, 32);
        break;
      case "zap":
        this.tone(now, 0.25, 0.25 * gain, "sawtooth", 1400, 160);
        this.noiseBurst(now, 0.18, 0.3 * gain, { type: "bandpass", from: 3000, to: 1200 });
        break;
      case "warning":
        // Three rising alarm beeps.
        for (let i = 0; i < 3; i += 1) this.tone(now + i * 0.22, 0.16, 0.22 * gain, "square", 660 + i * 110, 700 + i * 110);
        break;
      case "splat":
        this.noiseBurst(now, 0.22, 0.6 * gain, { type: "lowpass", from: 1800, to: 300 });
        this.tone(now, 0.12, 0.3 * gain, "sine", 220, 80);
        break;
      case "throw":
        this.noiseBurst(now, 0.25, 0.25 * gain, { type: "bandpass", from: 600, to: 2200 });
        break;
      case "crash":
        this.noiseBurst(now, 1.2, 0.9 * gain, { type: "lowpass", from: 5000, to: 400 });
        this.tone(now, 0.5, 0.7 * gain, "sine", 90, 35);
        for (let i = 0; i < 5; i += 1) {
          this.tone(now + 0.05 + i * 0.07, 0.18, 0.12 * gain, "triangle", 1800 + i * 420, 1200 + i * 300);
        }
        break;
      case "horn":
        this.tone(now, 0.55, 0.22 * gain, "sawtooth", 392, 392);
        this.tone(now, 0.55, 0.18 * gain, "sawtooth", 494, 494);
        break;
      case "beam":
        this.tone(now, 0.9, 0.2 * gain, "sine", 300, 1200);
        break;
      case "abduct":
        this.tone(now, 1.4, 0.24 * gain, "triangle", 220, 1760);
        this.tone(now, 1.4, 0.12 * gain, "sine", 225, 1800);
        break;
      case "land":
        this.noiseBurst(now, 0.3, 0.6 * gain, { type: "lowpass", from: 900, to: 120 });
        this.tone(now, 0.25, 0.4 * gain, "sine", 120, 45);
        break;
      case "spray":
        this.noiseBurst(now, 0.35, 0.18 * gain, { type: "highpass", from: 3000, to: 3000 });
        break;
      case "squeak":
        // Two quick high chirps.
        this.tone(now, 0.08, 0.16 * gain, "square", 2600, 3400);
        this.tone(now + 0.1, 0.07, 0.13 * gain, "square", 3000, 3800);
        break;
      case "pickup":
        // A soft upward blip.
        this.tone(now, 0.09, 0.16 * gain, "triangle", 520, 880);
        break;
      case "place":
        // Set down on a counter: a short knock.
        this.tone(now, 0.08, 0.2 * gain, "sine", 300, 150);
        this.noiseBurst(now, 0.05, 0.12 * gain, { type: "lowpass", from: 2200, to: 600 });
        break;
      case "trash":
        // Into the bin: a hollow thud and a rattle.
        this.tone(now, 0.22, 0.35 * gain, "sine", 140, 55);
        this.noiseBurst(now + 0.04, 0.18, 0.2 * gain, { type: "bandpass", from: 1200, to: 500 });
        break;
      case "chop":
        // Knife on board: a crisp tick over a wooden knock.
        this.noiseBurst(now, 0.045, 0.32 * gain, { type: "highpass", from: 3800, to: 2400 });
        this.tone(now, 0.07, 0.22 * gain, "sine", 420, 180);
        break;
      case "scrub":
        // Splash and scrub in the sink.
        this.noiseBurst(now, 0.22, 0.2 * gain, { type: "bandpass", from: 700, to: 1800 });
        this.tone(now + 0.03, 0.06, 0.08 * gain, "sine", 900, 1400);
        break;
      case "hey":
        // A cook calling across the kitchen: two short rising notes, like a whistle.
        this.tone(now, 0.1, 0.22 * gain, "triangle", 740, 980);
        this.tone(now + 0.1, 0.14, 0.2 * gain, "triangle", 1046, 1318);
        break;

      case "ding":
        // Ready: a bright two-note bell.
        this.tone(now, 0.5, 0.2 * gain, "sine", 1318, 1318);
        this.tone(now + 0.09, 0.6, 0.16 * gain, "sine", 1760, 1760);
        this.tone(now, 0.3, 0.05 * gain, "triangle", 2637, 2637);
        break;
      case "burnt":
        // A sour fizzle as the food chars.
        this.noiseBurst(now, 0.6, 0.25 * gain, { type: "bandpass", from: 2400, to: 500 });
        this.tone(now, 0.45, 0.12 * gain, "sawtooth", 220, 110);
        break;
      case "ignite":
        // Flames catching: a whoosh.
        this.noiseBurst(now, 0.7, 0.55 * gain, { type: "lowpass", from: 400, to: 3000 });
        this.tone(now, 0.5, 0.18 * gain, "sine", 90, 60);
        break;
      case "puff":
        // The last flame out: a soft hiss settling.
        this.noiseBurst(now, 0.5, 0.25 * gain, { type: "highpass", from: 4000, to: 1500 });
        break;
      case "toss":
        // An ingredient thrown across the kitchen.
        this.noiseBurst(now, 0.18, 0.18 * gain, { type: "bandpass", from: 900, to: 2800 });
        this.tone(now, 0.15, 0.08 * gain, "triangle", 500, 900);
        break;
      case "bonk":
        // A cook knocked over.
        this.tone(now, 0.18, 0.35 * gain, "square", 260, 90);
        this.tone(now + 0.02, 0.25, 0.2 * gain, "sine", 180, 60);
        break;
      case "serve":
        // A plate served: a cheerful rising arpeggio and a coin.
        [784, 988, 1175, 1568].forEach((frequency, index) =>
          this.tone(now + index * 0.07, 0.22, 0.17 * gain, "triangle", frequency, frequency));
        this.tone(now + 0.3, 0.35, 0.12 * gain, "sine", 2093, 2093);
        break;
      case "combo":
        // Another in a row: a sparkle on top.
        [1568, 2093, 2637].forEach((frequency, index) =>
          this.tone(now + 0.35 + index * 0.05, 0.18, 0.09 * gain, "sine", frequency, frequency));
        break;
      case "wrong":
        // A dish nobody ordered: a flat double honk.
        this.tone(now, 0.14, 0.18 * gain, "square", 330, 300);
        this.tone(now + 0.17, 0.2, 0.18 * gain, "square", 262, 240);
        break;
      case "fail":
        // An order lost: a falling buzzer.
        this.tone(now, 0.6, 0.22 * gain, "sawtooth", 330, 110);
        this.tone(now, 0.6, 0.12 * gain, "square", 165, 70);
        break;
      case "tick":
        // An order about to run out: a clock tick.
        this.tone(now, 0.05, 0.18 * gain, "square", 1800, 1600);
        this.tone(now + 0.16, 0.05, 0.14 * gain, "square", 1500, 1300);
        break;
      case "start":
        // The shift opens: a short fanfare.
        [523, 659, 784].forEach((frequency, index) =>
          this.tone(now + index * 0.12, 0.2, 0.18 * gain, "triangle", frequency, frequency));
        this.tone(now + 0.36, 0.55, 0.2 * gain, "triangle", 1047, 1047);
        break;
      case "win":
        // Shift over, well done: a major flourish.
        [523, 659, 784, 1047, 1319].forEach((frequency, index) =>
          this.tone(now + index * 0.1, 0.4, 0.16 * gain, "triangle", frequency, frequency));
        this.tone(now + 0.5, 0.9, 0.12 * gain, "sine", 1568, 1568);
        break;
      case "lose":
        // Shift over, badly: a sagging three-note slide.
        [392, 349, 294].forEach((frequency, index) =>
          this.tone(now + index * 0.22, 0.32, 0.18 * gain, "triangle", frequency, frequency * 0.94));
        this.tone(now + 0.66, 0.8, 0.16 * gain, "sawtooth", 220, 196);
        break;
    }
  }

  /** Starts a loop; the handle stops it. Returns a silent handle before audio is unlocked. */
  loop(id: LoopId, level = 1): LoopHandle {
    const context = this.ready();
    if (!context || !this.master) return SILENT_LOOP;
    const now = context.currentTime;
    const out = context.createGain();
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(level, now + 0.3);
    out.connect(this.master);
    const sources: AudioScheduledSourceNode[] = [];

    if (id === "siren") {
      // A two-tone wail swept by a slow oscillator.
      const voice = context.createOscillator();
      voice.type = "sawtooth";
      voice.frequency.value = 700;
      const sweep = context.createOscillator();
      sweep.frequency.value = 0.9;
      const depth = context.createGain();
      depth.gain.value = 230;
      sweep.connect(depth).connect(voice.frequency);
      const tone = context.createBiquadFilter();
      tone.type = "lowpass";
      tone.frequency.value = 1800;
      const gain = context.createGain();
      gain.gain.value = 0.09;
      voice.connect(tone).connect(gain).connect(out);
      sources.push(voice, sweep);
    } else if (id === "ufo") {
      // The classic flying-saucer warble.
      const voice = context.createOscillator();
      voice.type = "sine";
      voice.frequency.value = 520;
      const wobble = context.createOscillator();
      wobble.frequency.value = 7;
      const depth = context.createGain();
      depth.gain.value = 90;
      wobble.connect(depth).connect(voice.frequency);
      const hum = context.createOscillator();
      hum.type = "triangle";
      hum.frequency.value = 70;
      const gain = context.createGain();
      gain.gain.value = 0.12;
      const humGain = context.createGain();
      humGain.gain.value = 0.18;
      voice.connect(gain).connect(out);
      hum.connect(humGain).connect(out);
      sources.push(voice, wobble, hum);
    } else if (id === "sizzle") {
      // Food frying: crackling high noise, flickering in loudness.
      const fry = this.noiseSource(context);
      const shape = context.createBiquadFilter();
      shape.type = "highpass";
      shape.frequency.value = 3200;
      const crackle = context.createOscillator();
      crackle.type = "square";
      crackle.frequency.value = 13;
      const depth = context.createGain();
      depth.gain.value = 0.05;
      const gain = context.createGain();
      gain.gain.value = 0.09;
      crackle.connect(depth).connect(gain.gain);
      fry.connect(shape).connect(gain).connect(out);
      sources.push(fry, crackle);
    } else if (id === "water") {
      // Gushing water: a rush of noise with a bubbling wobble in its brightness.
      const rush = this.noiseSource(context);
      const shape = context.createBiquadFilter();
      shape.type = "bandpass";
      shape.frequency.value = 900;
      shape.Q.value = 0.7;
      const bubble = context.createOscillator();
      bubble.frequency.value = 5;
      const depth = context.createGain();
      depth.gain.value = 400;
      bubble.connect(depth).connect(shape.frequency);
      const gain = context.createGain();
      gain.gain.value = 0.45;
      rush.connect(shape).connect(gain).connect(out);
      sources.push(rush, bubble);
    } else {
      // An electric car: a high whine over a filtered rush of air.
      const whine = context.createOscillator();
      whine.type = "sawtooth";
      whine.frequency.setValueAtTime(380, now);
      whine.frequency.linearRampToValueAtTime(900, now + 1.4);
      const whineGain = context.createGain();
      whineGain.gain.value = 0.06;
      whine.connect(whineGain).connect(out);
      const air = this.noiseSource(context);
      const airFilter = context.createBiquadFilter();
      airFilter.type = "bandpass";
      airFilter.frequency.value = 700;
      const airGain = context.createGain();
      airGain.gain.value = 0.35;
      air.connect(airFilter).connect(airGain).connect(out);
      sources.push(whine, air);
    }
    for (const source of sources) source.start(now);

    let stopped = false;
    return {
      stop: (seconds = 0.4) => {
        if (stopped || !this.context) return;
        stopped = true;
        const at = this.context.currentTime;
        out.gain.cancelScheduledValues(at);
        out.gain.setValueAtTime(out.gain.value, at);
        out.gain.linearRampToValueAtTime(0, at + seconds);
        for (const source of sources) source.stop(at + seconds + 0.05);
      },
      setLevel: (next: number) => {
        if (stopped || !this.context) return;
        out.gain.setTargetAtTime(Math.max(0, next), this.context.currentTime, 0.15);
      },
    };
  }

  private ready(): AudioContext | null {
    const context = this.context;
    return context && context.state === "running" ? context : null;
  }

  private ensureContext(): void {
    if (this.context || typeof window === "undefined") return;
    const Constructor = (window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext) as
      AudioContextConstructor | undefined;
    if (!Constructor) return;
    this.context = new Constructor();
    this.master = this.context.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.context.destination);
  }

  private noiseSource(context: AudioContext): AudioBufferSourceNode {
    if (!this.noise) {
      const length = context.sampleRate * 2;
      this.noise = context.createBuffer(1, length, context.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    }
    const source = context.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    return source;
  }

  private noiseBurst(
    at: number,
    seconds: number,
    gain: number,
    filter: { readonly type: BiquadFilterType; readonly from: number; readonly to: number },
  ): void {
    const context = this.context!;
    const source = this.noiseSource(context);
    const shape = context.createBiquadFilter();
    shape.type = filter.type;
    shape.frequency.setValueAtTime(filter.from, at);
    shape.frequency.exponentialRampToValueAtTime(Math.max(20, filter.to), at + seconds);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(gain, at);
    envelope.gain.exponentialRampToValueAtTime(0.001, at + seconds);
    source.connect(shape).connect(envelope).connect(this.master!);
    source.start(at);
    source.stop(at + seconds + 0.05);
  }

  private tone(
    at: number,
    seconds: number,
    gain: number,
    type: OscillatorType,
    from: number,
    to: number,
  ): void {
    const context = this.context!;
    const voice = context.createOscillator();
    voice.type = type;
    voice.frequency.setValueAtTime(from, at);
    voice.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + seconds);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(gain, at + 0.01);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    voice.connect(envelope).connect(this.master!);
    voice.start(at);
    voice.stop(at + seconds + 0.05);
  }
}
