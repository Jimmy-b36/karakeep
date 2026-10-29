# Read-aloud audio verification

From the repository root, after `pnpm install --frozen-lockfile`:

```sh
node scripts/verify-read-aloud-audio.cjs
TZ=UTC NODE_OPTIONS=--no-experimental-webstorage pnpm test --filter=@karakeep/web -- --run
pnpm typecheck --filter=@karakeep/web
pnpm lint --filter=@karakeep/web
```

The browser check uses the workspace's existing `playwright` and `esbuild`; no new browser-test dependency is necessary. It tries Playwright Chromium, then installed system Chrome (`channel: "chrome"`). Install one of those browsers if neither is available. No login, running application, speech worker, or autoplay-bypass flags are used. A temporary localhost server provides the secure context required by AudioWorklet; temporary files are removed on completion.

Every run bundles **current TypeScript source and its patched dependency**, with minification, into a fresh temporary directory. It does not execute a checked-in or cached JavaScript bundle. Failures exit nonzero.

## What is measured

- Actual OfflineAudioContext PCM, at 24, 44.1, and 48 kHz and 0.75, 1, 1.5, and 2x tempo.
- A 440 Hz sine remains within 5 Hz of the original pitch.
- Measured half-amplitude waveform duration is within 15 ms of `2 / tempo` seconds. Output is **not** trimmed or padded to make this assertion pass; the quieter synthesis tail is retained.
- No internal near-zero run over 2 ms, including chunk boundaries.
- The entire rendered waveform for three adjacent buffers matches a single unsplit buffer to within 1e-5. The same comparison also appends the second buffer after offline rendering is already running (using suspend/resume). This catches per-chunk DSP resets, inserted padding, buffer-indexing faults, and truncated tails.
- Explicit 24-to-44.1 kHz input resampling retains pitch.
- A trusted Playwright click unlocks a real AudioContext. Additional chunks are appended while running; rapid tempo changes, immediate pause, frozen source time, resume, boundary callbacks, and session replacement are exercised.

Vitest separately checks genuine source-time word highlighting and previous/next navigation, cancellation during resume and initialization, stale prefetched decoding after stop, tail completion, and cumulative sample rounding.

## Engine and dependency patch

`signalsmith-stretch@1.3.2` is the official MIT-licensed Signalsmith Stretch JS/WASM AudioWorklet release. Its buffer mode accepts consecutive PCM buffers, preserving the same phase-vocoder state across all chunks. Pitch transposition is explicitly zero; tempo is independent. The scheduler never sets AudioBufferSourceNode.playbackRate and never relies on `onended` to start a ready chunk.

The pinned pnpm patch fixes an upstream streaming-buffer cursor bug in both module entry points: after copying part of a buffer, advance the source read cursor and advance the absolute buffer-start cursor to that buffer's actual end. Without it, the worklet copies the second buffer into an already-full analysis window and throws after roughly 0.1–0.2 seconds. The split-versus-whole real PCM comparison is its regression test. Do not remove this patch without rerunning that comparison against a fixed upstream release.

The engine reads its own analysis context across ready buffers and naturally synthesizes the final decay beyond the last source sample. The adapter allows one engine-latency interval for that real tail before completion; it does not independently zero-flush chunks. Finished input buffers are dropped after one second of analysis history; the player already bounds future prefetch. Startup/resume and tempo commands reserve the engine's reported latency plus two render quanta. Tempo commands therefore take effect after that short lookahead, and the UI uses the same piecewise audio-context/source-time map. The engine's `inputTime` notifications include analysis lookahead and are deliberately not used for word highlighting.

`decodeAudioData` resamples WAVs to the hardware context rate. The adapter also handles externally supplied mismatched-rate buffers explicitly and rounds cumulative buffer boundaries, preventing one-frame drift per chunk. Ready adjacent chunks are continuous; a chunk arriving after its samples were needed cannot retroactively eliminate a generation/network underrun.
