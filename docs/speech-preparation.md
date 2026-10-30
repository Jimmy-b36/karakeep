# Persistent Emma article preparation

On a configured Kokoro server, the speech worker queues **each user's ten most recently saved readable link articles** at startup and every 30 minutes. Reconciliation reuses cached chunks and revisits failed or evicted continuations; passes do not overlap within a worker process. It pages past empty/image-only content. Unsaved RSS items are excluded. Successful crawls, manual re-saves and promotion into the library enqueue future preparation.

Preparation uses **kokoro:bf_emma** only. Other voices still work on demand. Select Kokoro Emma in Listen to use the prepared audio; existing browser voice preferences are not overwritten.

Each durable queue job prepares one canonical article chunk (up to 160 characters), then enqueues a versioned continuation. Foreground listeners take priority; busy background work is deferred without exhausting its retries. Other failures still have bounded retries and are revisited by reconciliation. Failure logs include bookmark ID, offset, content version and retries remaining, never article text. Stop/restart does not discard completed cached audio.

## Cache

- Kokoro's `/cache` must be writable and persistent. The Pi uses the named Docker volume `karakeep-kokoro-cache`; do not publish the worker's port.
- Cache entries are private, compressed timed-audio JSON, keyed by exact text, voice, pinned model/voice revision and alignment version.
- The single-writer cache uses atomic replacement and removes interrupted writes at startup.
- Article text is phonemized literally, without Markdown pronunciation preprocessing. Bracketed text uses a new cache voice variant (`:literal-v1`) so legacy preprocessed entries cannot omit text; other entries remain reusable.
- Responses remove only digital-zero edge padding, retaining every nonzero PCM sample plus 50 ms before speech and 100 ms afterward (250 ms after sentence/clause punctuation). Word times shift/clamp to the delivered WAV; UTF-16 text offsets do not change. Raw cached WAVs are not rewritten.
- Storage is bounded to 2 GiB, evicting least-recently-used chunks. Older evicted audio is regenerated on demand.
- Playback retains the normal owner/session/CSRF checks before contacting the worker. Cached audio is not exposed by a public file server.

The Pi cannot generate an entire library instantly. The initial ten-article backfill runs in the background; cached chunks are fast, but uncached chunks can still buffer. A new content/model/alignment version requires new audio. Article jumps can create different chunk boundaries and therefore cache misses.

## Regression checks

With the Kokoro Python dependencies installed (the Dockerfile runs these too):

```sh
python -m unittest discover -s docker/kokoro -p 'test_*.py'
pnpm test --filter=@karakeep/workers -- --run
pnpm typecheck --filter=@karakeep/workers
node scripts/verify-read-aloud-audio.cjs
```

The 2026-10-30 read-only production investigation found 41/41 cached chunks for the reported example and two incomplete articles failing token mapping around code/URL apostrophes. Local validation of the patched phonemizer/offset mapper passed all 714 canonical chunks across that user's ten readable saved articles, without running model inference. Applying the padding fix locally to the example's 41 cached WAVs reduced mean digital edge silence from 620 ms to 147 ms (76%), preserving every nonzero sample and valid word times. This is not a manual listening test or a deployed fix. Both the Kokoro image and application worker image need updating to apply all changes; no cache purge or DB migration is needed.

## Pi deployment and rollback

Kokoro Compose: `/data/coolify/auxiliary/kokoro/compose.json` (2.5 GiB, 3 CPUs, read-only root filesystem, private network). App image and raw/rendered Compose are persisted in Coolify.

Release artifacts and private rollback material: `/root/speech-cache-release-20261023` and `/root/speech-cache-release-20261023-v2`. Coolify settings snapshots are under `/data/coolify/backups/speech-cache-release-20261023*-before.json`. A consistent application SQLite backup was taken at `/data/backups/pre-speech-cache-20261023.db` inside Karakeep's data volume. These backups contain secrets/user data; keep them private. Do not restore the whole application database merely to roll back an image.

Validated: unit/integration tests, app and worker builds, isolated ARM64 smoke tests, all eight voices, native word timings with unspoken punctuation, persistent cache across restart, actual article cache hits, public app health and unauthenticated speech rejection. Manual listening and logged-in browser interaction were not performed.
