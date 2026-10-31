# Persistent Emma article preparation

On a configured Kokoro server, the speech worker queues **each user's ten most recently saved readable link articles** at startup and every 30 minutes. Reconciliation reuses cached chunks and revisits failed or evicted continuations; passes do not overlap within a worker process. It pages past empty/image-only content. Unsaved RSS items are excluded. Successful crawls, manual re-saves and promotion into the library enqueue future preparation.

Preparation uses **kokoro:bf_emma** only. Other voices still work on demand. Select Kokoro Emma in Listen to use the prepared audio; existing browser voice preferences are not overwritten.

Each durable queue job prepares one canonical article batch (up to 320 Unicode codepoints), then enqueues a versioned continuation. Foreground listeners take priority; busy background work is deferred without exhausting its retries. Other failures still have bounded retries and are revisited by reconciliation. Failure logs include bookmark ID, offset, content version and retries remaining, never article text. Stop/restart does not discard completed cached audio.

## Sentence batches

Preparation and playback use the same deterministic shared chunker. It groups complete sentences within a paragraph, targeting 240 codepoints. A group below 160 codepoints can exceed that target to include the next sentence, up to a hard 320-codepoint ceiling; a short final sentence can also join the preceding group when it fits. Titles/initials and `e.g.`/`i.e.` are repaired after platform sentence segmentation. Blank lines end paragraphs; ordinary wrapped lines do not split model utterances. Canonical text and offsets are never rewritten.

A sentence larger than the hard ceiling falls back to substantial clause boundaries, then whitespace, then a Unicode-codepoint-safe cut for an overlong token. Such forced mid-sentence splits remain possible. The native pipeline retains its 510-phoneme segmentation limit, but oversized/truncated phoneme results now fail explicitly rather than silently dropping text.

The content-version hash includes `speech-sentences-v1`. Old playback continuations receive restart/409, and old preparation jobs restart at zero. Changed batch texts need new cached audio; there is no cache purge or database migration.

Foreground lock acquisition is capped at 30 seconds, reserving 40 seconds of the application's 70-second request deadline for synthesis. The initial isolated Pi check measured a 320-codepoint technical sample at 25.3 seconds and peak cgroup memory at 1.76 GB under the existing 2.5-GiB/3-CPU limits; this exposed the old 45-second lock wait as too long for the larger batches. A busy lock returns retryable 503 instead of consuming the synthesis budget.

**Rollout:** deploy the updated Kokoro service before the application/worker image, because the old service rejects requests above 160 characters. The 240/320 envelope is provisional: run Pi latency/RSS and listening checks before deployment. A local Mac ONNX/Emma check with 3 inference threads measured 160/240/320-character requests at about 2.0/3.0/3.9 seconds with process peak RSS about 1.69/2.00/2.36 GB. These are sequential single-process measurements, not Pi/container guarantees or a listening comparison; the 320-character case is close enough to the 2.5-GiB limit to require that deployment gate.

## Cache

- Kokoro's `/cache` must be writable and persistent. The Pi uses the named Docker volume `karakeep-kokoro-cache`; do not publish the worker's port.
- Cache entries are private, compressed timed-audio JSON, keyed by exact text, voice, pinned model/voice revision and alignment version. Namespace `v3` excludes earlier audio that may have silently omitted unfamiliar names while espeak was unavailable; old files are not purged.
- The single-writer cache uses atomic replacement and removes interrupted writes at startup.
- Article text is phonemized literally, without Markdown pronunciation preprocessing. Bracketed text uses a cache voice variant (`:literal-v1`) so legacy preprocessed entries cannot omit text. Requests containing CR/LF use `:unwrapped-v1` to avoid reusing audio generated with per-line utterance resets. Other matching entries remain reusable.
- Responses remove only digital-zero edge padding, retaining every nonzero PCM sample plus 50 ms before speech and 100 ms afterward (250 ms after sentence/clause punctuation). Word times shift/clamp to the delivered WAV; UTF-16 text offsets do not change. Raw cached WAVs are not rewritten.
- Storage is bounded to 2 GiB, evicting least-recently-used chunks. Older evicted audio is regenerated on demand.
- Playback retains the normal owner/session/CSRF checks before contacting the worker. Cached audio is not exposed by a public file server.

The Pi cannot generate an entire library instantly. The initial ten-article backfill runs in the background; cached chunks are fast, but uncached chunks can still buffer. A new content/model/alignment version requires new audio. Article jumps can create different chunk boundaries and therefore cache misses.

## Regression checks

With the Kokoro Python dependencies installed (the Dockerfile runs these too):

```sh
python -m unittest discover -s docker/kokoro -p 'test_*.py'
pnpm test --filter=@karakeep/shared -- --run utils/speech.test.ts
pnpm test --filter=@karakeep/api -- --run routes/speech.test.ts
pnpm test --filter=@karakeep/workers -- --run
pnpm typecheck --filter=@karakeep/shared --filter=@karakeep/api --filter=@karakeep/workers
node scripts/verify-read-aloud-audio.cjs
```

The 2026-10-30 read-only production investigation found 41/41 cached chunks for the reported example and two incomplete articles failing token mapping around code/URL apostrophes. Local validation of the patched phonemizer/offset mapper passed all 714 canonical chunks across that user's ten readable saved articles, without running model inference. Applying the padding fix locally to the example's 41 cached WAVs reduced mean digital edge silence from 620 ms to 147 ms (76%), preserving every nonzero sample and valid word times. The padding/recovery fixes were subsequently deployed in `bccd3084`, with 714/714 Emma chunks verified across the user's top ten at that time. These historical measurements do not validate the newer sentence-batching policy above. Manual listening and Pi benchmarking of that policy remain outstanding.

## Pi deployment and rollback

Kokoro Compose: `/data/coolify/auxiliary/kokoro/compose.json` (2.5 GiB, 3 CPUs, read-only root filesystem, private network). App image and raw/rendered Compose are persisted in Coolify.

**Phonemizer runtime:** retain the existing `noexec` `/tmp`, but mount `/opt/phonemizer-tmp` as a private 16-MiB executable tmpfs (`rw,nosuid,nodev,exec,size=16m,mode=0700,uid=10001,gid=10001`) and set `TMPDIR=/opt/phonemizer-tmp`. The espeak wrapper copies its shared library into a temporary directory before loading it. A `noexec` temporary directory disables this fallback; Kokoro can then omit unfamiliar names or fail on author-name-only blocks. Startup now rejects a missing fallback instead of silently serving incomplete narration. The ARM64 workflow tests the same read-only/noexec layout, including an unfamiliar name and trailing paragraph separators.

Release artifacts and private rollback material: `/root/speech-cache-release-20261023` and `/root/speech-cache-release-20261023-v2`. Coolify settings snapshots are under `/data/coolify/backups/speech-cache-release-20261023*-before.json`. A consistent application SQLite backup was taken at `/data/backups/pre-speech-cache-20261023.db` inside Karakeep's data volume. These backups contain secrets/user data; keep them private. Do not restore the whole application database merely to roll back an image.

Validated: unit/integration tests, app and worker builds, isolated ARM64 smoke tests, all eight voices, native word timings with unspoken punctuation, persistent cache across restart, actual article cache hits, public app health and unauthenticated speech rejection. Manual listening and logged-in browser interaction were not performed.
