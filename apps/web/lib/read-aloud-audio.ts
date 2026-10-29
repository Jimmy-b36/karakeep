import createStretch from "signalsmith-stretch";
import type { AudioLike } from "./read-aloud";

// Emscripten serializes its factory with Function#toString. Next/Turbopack
// rewrites process references into outer imports, which do not exist in the
// worklet realm. Load the pinned, patched standalone distribution unchanged.
createStretch.moduleUrl = "/audio/signalsmith-stretch-1.3.2.js";

export interface StretchNode extends AudioNode {
  addBuffers(buffers: Float32Array[]): Promise<number>;
  dropBuffers(before?: number): Promise<unknown>;
  latency(): Promise<number>;
  schedule(change: {
    output: number;
    outputTime?: number;
    input?: number;
    active: boolean;
    rate?: number;
    semitones?: number;
  }): Promise<unknown>;
}
interface Segment {
  buffer: AudioBuffer;
  from: number;
  to: number;
  onStart?: () => void;
}
interface Clock {
  output: number;
  input: number;
  rate: number;
}

/** One persistent WASM/AudioWorklet time stretcher consumes the decoded stream.
 * Chunk boundaries are metadata, not audio-source swaps. The engine compensates
 * its STFT latency, reads across adjacent buffers, and drains its actual DSP tail.
 * Only the audio-context clock drives source-time/word highlighting (the engine's
 * inputTime messages include analysis lookahead, and must NOT drive the UI).
 */
export class ScheduledSpeechAudio implements AudioLike {
  src = "";
  onended: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private context: AudioContext | null = null;
  private node: StretchNode | null = null;
  private ready: Promise<StretchNode | null> | null = null;
  private fallback: HTMLAudioElement | null = null;
  private fallbackUrl: string | null = null;
  private pending: Promise<void> = Promise.resolve();
  private segments: Segment[] = [];
  private clocks: Clock[] = [];
  private position = 0;
  private end = 0;
  private running = false;
  private rate = 1;
  private latency = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private epoch = 0;
  private playToken = 0;
  private droppedBefore = 0;

  constructor(
    private readonly createContext: () => AudioContext,
    private readonly createNode: (
      context: AudioContext,
    ) => Promise<StretchNode> = (context) =>
      createStretch(context, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      }),
  ) {}

  unlock(): void {
    try {
      this.context ??= this.createContext();
      void this.context.resume().catch(() => {
        /* A user gesture can retry. */
      });
    } catch {
      /* play() exposes failures through the retry UI. */
    }
  }

  async prepare(blob: Blob): Promise<AudioBuffer> {
    this.context ??= this.createContext();
    // decodeAudioData resamples to the actual hardware context rate, not the
    // speech worker WAV rate. addBuffer also handles externally supplied PCM.
    return this.context.decodeAudioData(await blob.arrayBuffer());
  }

  private ensureNode(): Promise<StretchNode | null> {
    if (this.fallback) return Promise.resolve(null);
    if (!this.ready) {
      this.context ??= this.createContext();
      const epoch = this.epoch;
      let timeout: ReturnType<typeof setTimeout>;
      const creation = this.createNode(this.context);
      this.ready = Promise.race([
        creation.then(async (node) => ({
          node,
          latency: await node.latency(),
        })),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            void creation.then(
              (node) => node.disconnect(),
              () => undefined,
            );
            reject(new Error("Audio worklet initialization timed out"));
          }, 5000);
        }),
      ])
        .then(({ node, latency }) => {
          if (epoch !== this.epoch) {
            node.disconnect();
            throw new Error("Cancelled audio session");
          }
          node.addEventListener?.("processorerror", () => {
            if (epoch === this.epoch) this.onerror?.(new Event("error"));
          });
          this.node = node;
          this.latency = latency + 256 / this.context!.sampleRate;
          return node;
        })
        .catch((error: unknown) => {
          if (epoch !== this.epoch) throw error;
          console.warn(
            "Read-aloud worklet unavailable; using native audio",
            error,
          );
          this.fallback = new Audio();
          this.fallback.preservesPitch = true;
          return null;
        })
        .finally(() => clearTimeout(timeout));
    }
    return this.ready;
  }

  setBuffer(buffer: AudioBuffer): void {
    this.clear();
    this.addBuffer(buffer);
  }

  enqueue(buffer: AudioBuffer, onStart: () => void): void {
    this.addBuffer(buffer, onStart);
  }

  private addBuffer(buffer: AudioBuffer, onStart?: () => void): void {
    const segment = {
      buffer,
      from: this.end,
      to: this.end + buffer.duration,
      onStart,
    };
    this.end = segment.to;
    this.segments.push(segment);
    const epoch = this.epoch;
    this.pending = this.pending.then(async () => {
      if (epoch !== this.epoch) return;
      const node = await this.ensureNode();
      if (epoch !== this.epoch || !node) return;
      const sr = this.context!.sampleRate;
      // Round cumulative boundaries, not each chunk length independently: the
      // latter inserts/drops a sample at every non-integral resampling boundary.
      const firstFrame = Math.round(segment.from * sr);
      const length = Math.round(segment.to * sr) - firstFrame;
      const mono = new Float32Array(length);
      // Explicit resampling also covers OfflineAudioContext/test/third-party
      // buffers. Production decodeAudioData normally makes this a straight copy.
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < length; i++) {
          const p = Math.max(
              0,
              ((firstFrame + i) / sr - segment.from) * buffer.sampleRate,
            ),
            a = Math.floor(p),
            f = p - a;
          mono[i] +=
            ((data[a] ?? 0) * (1 - f) +
              (data[Math.min(a + 1, data.length - 1)] ?? 0) * f) /
            buffer.numberOfChannels;
        }
      }
      await node.addBuffers([mono]);
      if (epoch !== this.epoch) return;
    });
    // Enqueued decode failures must surface even when nobody is awaiting play().
    void this.pending.catch(() => {
      if (epoch === this.epoch) this.onerror?.(new Event("error"));
    });
  }

  get playbackRate(): number {
    return this.rate;
  }
  set playbackRate(value: number) {
    if (!Number.isFinite(value) || value <= 0 || value === this.rate) return;
    if (this.fallback) {
      this.rate = value;
      this.fallback.playbackRate = value;
    } else if (this.running) {
      const now = this.context!.currentTime;
      // A newer command replaces unrendered future changes in the worklet.
      this.clocks = this.clocks.filter((clock) => clock.output <= now);
      const output = now + this.latency;
      const input = this.sourceTime(output);
      this.clocks.push({ output, input, rate: value });
      void this.node!.schedule({
        output,
        outputTime: this.context!.currentTime,
        input,
        rate: value,
        semitones: 0,
        active: true,
      });
      this.rate = value;
    } else this.rate = value;
  }

  private sourceTime(output = this.context?.currentTime ?? 0): number {
    let clock = this.clocks[0];
    for (const candidate of this.clocks) {
      if (candidate.output > output) break;
      clock = candidate;
    }
    return clock
      ? Math.min(
          this.end,
          clock.input + Math.max(0, output - clock.output) * clock.rate,
        )
      : this.position;
  }

  get currentTime(): number {
    if (this.fallback) return this.fallback.currentTime;
    this.sync();
    return Math.max(
      0,
      (this.running ? this.sourceTime() : this.position) -
        (this.segments[0]?.from ?? 0),
    );
  }

  async play(): Promise<void> {
    this.context ??= this.createContext();
    const epoch = this.epoch;
    const token = ++this.playToken;
    await this.context.resume();
    await this.pending;
    if (
      epoch !== this.epoch ||
      token !== this.playToken ||
      this.running ||
      !this.segments.length
    )
      return;
    if (this.fallback) {
      if (!this.fallbackUrl) this.loadFallback();
      await this.fallback.play();
      if (epoch === this.epoch && token === this.playToken) this.running = true;
      return;
    }
    if (this.context.state !== "running")
      throw new Error("Audio context is suspended");
    const node = await this.ensureNode();
    if (epoch !== this.epoch || token !== this.playToken || !node) return;
    const output = this.context.currentTime + this.latency;
    this.clocks = [{ output, input: this.position, rate: this.rate }];
    node.connect(this.context.destination);
    await node.schedule({
      output,
      outputTime: this.context.currentTime,
      input: this.position,
      active: true,
      rate: this.rate,
      semitones: 0,
    });
    if (epoch !== this.epoch || token !== this.playToken) return;
    this.running = true;
    this.timer = setInterval(() => this.sync(), 25);
  }

  private loadFallback(): void {
    const media = this.fallback!;
    if (this.fallbackUrl) URL.revokeObjectURL(this.fallbackUrl);
    const segment = this.segments[0];
    if (!segment) return;
    const buffer = segment.buffer;
    const count = buffer.getChannelData(0).length;
    // Native media accepts a self-contained PCM WAV, with no extra decoder or CDN.
    const wav = new ArrayBuffer(44 + count * 2);
    const view = new DataView(wav);
    const text = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i++)
        view.setUint8(offset + i, value.charCodeAt(i));
    };
    text(0, "RIFF");
    view.setUint32(4, wav.byteLength - 8, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, count * 2, true);
    for (let i = 0; i < count; i++) {
      let sample = 0;
      for (let c = 0; c < buffer.numberOfChannels; c++)
        sample += buffer.getChannelData(c)[i] / buffer.numberOfChannels;
      view.setInt16(
        44 + i * 2,
        Math.max(-1, Math.min(1, sample)) * 32767,
        true,
      );
    }
    media.src = this.fallbackUrl = URL.createObjectURL(
      new Blob([wav], { type: "audio/wav" }),
    );
    media.playbackRate = this.rate;
    const epoch = this.epoch;
    media.onerror = () => {
      if (epoch === this.epoch) this.onerror?.(new Event("error"));
    };
    media.onended = () => {
      if (epoch !== this.epoch) return;
      this.segments.shift();
      if (!this.segments.length) {
        this.running = false;
        this.onended?.(new Event("ended"));
        return;
      }
      this.loadFallback();
      this.segments[0].onStart?.();
      if (epoch === this.epoch && this.running)
        void media.play().catch(() => {
          if (epoch === this.epoch) this.onerror?.(new Event("error"));
        });
    };
  }

  private sync(): void {
    if (!this.running || !this.context || this.fallback) return;
    const position = this.sourceTime();
    const epoch = this.epoch;
    while (this.segments.length && position >= this.segments[0].to) {
      if (this.segments.length === 1) {
        const clock = this.clocks[this.clocks.length - 1];
        const endOutput = clock.output + (this.end - clock.input) / clock.rate;
        // Leave the continuous processor connected while its synthesis window
        // decays. This is the engine tail, not fabricated padded output.
        if (this.context.currentTime < endOutput + this.latency) break;
      }
      this.segments.shift();
      if (this.segments.length) {
        this.segments[0].onStart?.();
        if (epoch !== this.epoch) return;
      } else {
        this.position = this.end;
        this.running = false;
        clearInterval(this.timer);
        this.node?.disconnect();
        this.onended?.(new Event("ended"));
        return;
      }
    }
    // Keep analysis history, but release finished chunks in the worklet. Its
    // memory is bounded by current/prefetched chunks plus one second of history.
    const dropBefore = Math.max(0, position - 1);
    if (this.node && dropBefore > this.droppedBefore + 0.25) {
      this.droppedBefore = dropBefore;
      void this.node.dropBuffers(dropBefore);
    }
    while (
      this.clocks.length > 1 &&
      this.clocks[1].output <= this.context.currentTime
    )
      this.clocks.shift();
  }

  pause(): void {
    this.playToken++;
    this.fallback?.pause();
    this.sync();
    if (this.running) this.position = this.sourceTime();
    this.running = false;
    clearInterval(this.timer);
    this.node?.disconnect();
    if (this.node)
      void this.node.schedule({
        output: this.context!.currentTime,
        active: false,
      });
  }

  private clear(): void {
    this.running = false; // navigation must not dispatch stale chunk callbacks
    this.pause();
    this.epoch++;
    if (this.fallback) {
      this.fallback.onended = this.fallback.onerror = null;
      this.fallback.removeAttribute("src");
      this.fallback.load();
    }
    if (this.fallbackUrl) URL.revokeObjectURL(this.fallbackUrl);
    this.fallbackUrl = null;
    if (this.node) void this.node.dropBuffers();
    this.node = null;
    this.ready = null;
    this.pending = Promise.resolve();
    this.segments = [];
    this.clocks = [];
    this.position = this.end = this.droppedBefore = 0;
  }
  removeAttribute(): void {
    this.src = "";
    this.clear();
  }
  load(): void {
    /* PCM is loaded by prepare(). */
  }
  dispose(): void {
    this.clear();
    void this.context?.close().catch(() => {
      /* Already closed. */
    });
    this.context = null;
  }
}

export function createReadAloudAudio(): AudioLike {
  const browser = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  const Context = browser.AudioContext ?? browser.webkitAudioContext;
  return Context ? new ScheduledSpeechAudio(() => new Context()) : new Audio();
}
