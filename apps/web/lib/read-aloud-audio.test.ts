import { describe, expect, it, vi } from "vitest";
import { ReadAloudPlayer } from "./read-aloud";
import { createReadAloudAudio, ScheduledSpeechAudio } from "./read-aloud-audio";
import type { StretchNode } from "./read-aloud-audio";

function buffer(duration = 2, sampleRate = 48000): AudioBuffer {
  return {
    duration,
    sampleRate,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(Math.round(duration * sampleRate)),
  } as unknown as AudioBuffer;
}
function harness() {
  const nodes: {
    addBuffers: ReturnType<typeof vi.fn>;
    schedule: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    dropBuffers: ReturnType<typeof vi.fn>;
    latency: ReturnType<typeof vi.fn>;
  }[] = [];
  const context = {
    currentTime: 10,
    sampleRate: 48000,
    state: "running",
    destination: {},
    resume: vi.fn<() => Promise<void>>(async () => undefined),
    close: vi.fn(async () => undefined),
    decodeAudioData: vi.fn(async () => buffer()),
  };
  const createNode = vi.fn(async () => {
    const node = {
      addBuffers: vi.fn(async () => 2),
      schedule: vi.fn(async () => undefined),
      connect: vi.fn(),
      disconnect: vi.fn(),
      dropBuffers: vi.fn(async () => undefined),
      latency: vi.fn(async () => 0.1),
    };
    nodes.push(node);
    return node as unknown as StretchNode;
  });
  const audio = new ScheduledSpeechAudio(
    () => context as unknown as AudioContext,
    createNode,
  );
  return { audio, context, nodes, createNode };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("continuous pitch-preserving scheduled audio", () => {
  it("queues consecutive buffers into ONE worklet, without per-chunk source swaps", async () => {
    const { audio, nodes, createNode, context } = harness();
    audio.setBuffer(buffer());
    await audio.play();
    const changed = vi.fn();
    audio.enqueue(buffer(3), changed);
    await tick();
    expect(createNode).toHaveBeenCalledOnce();
    expect(nodes[0].addBuffers).toHaveBeenCalledTimes(2);
    expect(nodes[0].schedule).toHaveBeenCalledOnce();
    expect(nodes[0].schedule.mock.calls[0][0]).toMatchObject({
      rate: 1,
      semitones: 0,
      active: true,
      input: 0,
    });
    context.currentTime = 12.605333333333;
    expect(audio.currentTime).toBeCloseTo(0.5);
    expect(changed).toHaveBeenCalledOnce();
    expect(nodes[0].dropBuffers).toHaveBeenCalled();
    audio.dispose();
  });
  it("maps speed changes to genuine source time without changing pitch or resetting the DSP", async () => {
    const { audio, context, nodes, createNode } = harness();
    audio.setBuffer(buffer());
    audio.enqueue(buffer(3), vi.fn());
    await audio.play();
    context.currentTime = 10.605333333333;
    audio.playbackRate = 2;
    expect(audio.currentTime).toBeCloseTo(0.5);
    const schedule = nodes[0].schedule.mock.calls.at(-1)![0];
    expect(schedule).toMatchObject({ rate: 2, semitones: 0, active: true });
    expect(schedule.input).toBeCloseTo(0.605333333333);
    context.currentTime = 11.710666666666;
    expect(audio.currentTime).toBeCloseTo(0.605333333333);
    expect(createNode).toHaveBeenCalledOnce();
    audio.dispose();
  });
  it("freezes source-time on pause, disconnects immediately, resumes at the saved input", async () => {
    const { audio, context, nodes } = harness();
    audio.setBuffer(buffer());
    await audio.play();
    context.currentTime = 10.855333333333;
    audio.pause();
    expect(nodes[0].disconnect).toHaveBeenCalledOnce();
    context.currentTime = 20;
    expect(audio.currentTime).toBeCloseTo(0.75);
    await audio.play();
    expect(nodes[0].schedule.mock.calls.at(-1)![0].input).toBeCloseTo(0.75);
    audio.dispose();
  });
  it("cancels a pending resume when paused", async () => {
    const { audio, context, nodes } = harness();
    audio.setBuffer(buffer());
    let resume!: () => void;
    context.resume.mockImplementationOnce(
      () => new Promise<void>((r) => (resume = r)),
    );
    const pending = audio.play();
    audio.pause();
    resume();
    await pending;
    expect(nodes.every((n) => n.connect.mock.calls.length === 0)).toBe(true);
    audio.dispose();
  });
  it("never installs stale node initialization after navigation", async () => {
    const { audio, createNode, nodes } = harness();
    let resolve!: (node: StretchNode) => void;
    createNode.mockImplementationOnce(
      () => new Promise<StretchNode>((r) => (resolve = r)),
    );
    audio.setBuffer(buffer());
    const pending = audio.play();
    await tick();
    audio.removeAttribute();
    const stale = {
      latency: vi.fn(async () => 0.1),
      disconnect: vi.fn(),
      addBuffers: vi.fn(),
    } as unknown as StretchNode;
    resolve(stale);
    await pending.catch(() => undefined);
    expect(stale.disconnect).toHaveBeenCalledOnce();
    expect(stale.addBuffers).not.toHaveBeenCalled();
    audio.setBuffer(buffer());
    await audio.play();
    expect(nodes).toHaveLength(1);
    audio.dispose();
  });
  it("resamples supplied 24kHz PCM to the actual 48kHz hardware context", async () => {
    const { audio, nodes } = harness();
    audio.setBuffer(buffer(1, 24000));
    await audio.play();
    expect(nodes[0].addBuffers.mock.calls[0][0][0]).toHaveLength(48000);
    audio.dispose();
  });
  it("allows the real DSP tail to drain before final completion", async () => {
    const { audio, context } = harness();
    const ended = vi.fn();
    audio.onended = ended;
    audio.setBuffer(buffer());
    await audio.play();
    context.currentTime = 12.11;
    void audio.currentTime;
    expect(ended).not.toHaveBeenCalled();
    context.currentTime = 12.4;
    void audio.currentTime;
    expect(ended).toHaveBeenCalledOnce();
    audio.dispose();
  });
  it("guards queued player decoding after stop, and keeps word navigation attached to the active chunk", async () => {
    const { audio, context, nodes } = harness();
    let decoded!: (b: AudioBuffer) => void;
    context.decodeAudioData
      .mockImplementationOnce(async () => buffer())
      .mockImplementationOnce(() => new Promise((r) => (decoded = r)));
    const firstWord = { start: 0, end: 1, from: 0, to: 5 };
    const player = new ReadAloudPlayer(
      {
        fetchChunk: vi.fn(async ({ start }) => ({
          blob: new Blob(["wav"]),
          next: start === 0 ? 10 : null,
          contentVersion: "v1",
          range: `${start}-${start + 10}/20`,
          text: start === 0 ? "First" : "Second",
          words: [firstWord],
        })),
        createAudio: () => audio,
        createObjectURL: vi.fn(),
        revokeObjectURL: vi.fn(),
        onSnapshot: vi.fn(),
      },
      "bookmark",
      "voice",
      1,
    );
    player.start();
    await tick();
    player.updateProgress();
    expect(player.currentSnapshot.currentWord).toEqual(firstWord);
    player.stop();
    decoded(buffer());
    await tick();
    expect(nodes[0].addBuffers).toHaveBeenCalledOnce();
    expect(player.currentSnapshot.status).toBe("idle");
    player.dispose();
  });
  it("keeps word highlights and previous/next attached to source-time after tempo, pause and jump", async () => {
    const { audio, context, nodes } = harness();
    const word = { start: 0, end: 1, from: 0, to: 5 };
    const player = new ReadAloudPlayer(
      {
        fetchChunk: vi.fn(async ({ start }) => ({
          blob: new Blob(["wav"]),
          next: start === 0 ? 10 : null,
          contentVersion: "v1",
          range: `${start}-${start + 10}/20`,
          text: start === 0 ? "First" : "Other",
          words: [word],
        })),
        createAudio: () => audio,
        createObjectURL: vi.fn(),
        revokeObjectURL: vi.fn(),
        onSnapshot: vi.fn(),
      },
      "bookmark",
      "voice",
      1,
    );
    player.start();
    await tick();
    await tick();
    expect(nodes[0].addBuffers).toHaveBeenCalledTimes(2);
    context.currentTime = 10.605333333333;
    player.setSpeed(2);
    context.currentTime = 11.510666666666;
    player.updateProgress();
    expect(player.currentSnapshot).toMatchObject({
      currentText: "Other",
      currentWord: word,
      canPrevious: true,
      canNext: false,
    });
    player.pause();
    context.currentTime = 20;
    player.resume();
    await tick();
    player.updateProgress();
    expect(player.currentSnapshot.currentWord).toEqual(word);
    player.startAt(0);
    await tick();
    await tick();
    expect(player.currentSnapshot).toMatchObject({
      currentText: "First",
      canPrevious: false,
      canNext: true,
    });
    expect(nodes).toHaveLength(2);
    expect(nodes[0].disconnect).toHaveBeenCalled();
    player.dispose();
  });
  it("coalesces rapid future tempo commands without accumulating phantom source time", async () => {
    const { audio, context, nodes } = harness();
    audio.setBuffer(buffer());
    await audio.play();
    context.currentTime = 10.605333333333;
    audio.playbackRate = 0.75;
    audio.playbackRate = 1.5;
    audio.playbackRate = 2;
    const changes = nodes[0].schedule.mock.calls
      .slice(1)
      .map((call) => call[0]);
    expect(changes.map((change) => change.input)).toEqual([
      changes[0].input,
      changes[0].input,
      changes[0].input,
    ]);
    context.currentTime = 10.910666666666;
    expect(audio.currentTime).toBeCloseTo(1.005333333333);
    audio.dispose();
  });
  it("rounds cumulative resampling boundaries rather than inserting one frame per chunk", async () => {
    const { audio, nodes } = harness();
    audio.setBuffer(buffer(1 / 44100, 44100));
    for (let i = 1; i < 100; i++)
      audio.enqueue(buffer(1 / 44100, 44100), vi.fn());
    await audio.play();
    const frames = nodes[0].addBuffers.mock.calls.reduce(
      (sum, call) => sum + call[0][0].length,
      0,
    );
    expect(frames).toBe(Math.round((100 * 48000) / 44100));
    audio.dispose();
  });
  it("does not accumulate worklet RPCs when the audio clock is suspended", async () => {
    const { audio, context, nodes } = harness();
    audio.setBuffer(buffer(5));
    await audio.play();
    context.currentTime = 12;
    void audio.currentTime;
    const calls = nodes[0].dropBuffers.mock.calls.length;
    for (let i = 0; i < 100; i++) void audio.currentTime;
    expect(nodes[0].dropBuffers).toHaveBeenCalledTimes(calls);
    audio.dispose();
  });
  it("reports suspended contexts", async () => {
    const { audio, context } = harness();
    context.state = "suspended";
    audio.setBuffer(buffer());
    await expect(audio.play()).rejects.toThrow("suspended");
    audio.dispose();
  });
  it("supports Safari's context alias and the HTML fallback", () => {
    class Fallback {}
    vi.stubGlobal("Audio", Fallback);
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    expect(createReadAloudAudio()).toBeInstanceOf(Fallback);
    vi.stubGlobal("webkitAudioContext", class {});
    expect(createReadAloudAudio()).toBeInstanceOf(ScheduledSpeechAudio);
    vi.unstubAllGlobals();
  });
});
