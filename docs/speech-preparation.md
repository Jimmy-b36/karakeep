# Persistent Emma article preparation

On a configured Kokoro server, the speech worker queues the ten most recently saved readable link articles at startup. It pages past empty/image-only content. Unsaved RSS items are excluded. Successful crawls, manual re-saves and promotion into the library enqueue future preparation.

Preparation uses **kokoro:bf_emma** only. Other voices still work on demand. Select Kokoro Emma in Listen to use the prepared audio; existing browser voice preferences are not overwritten.

Each durable queue job prepares one canonical article chunk (up to 160 characters), then enqueues a versioned continuation. Foreground listeners take priority; background work waits during listening and survives temporary worker restarts without exhausting its retries. Stop/restart does not discard completed cached audio.

## Cache

- Kokoro's `/cache` must be writable and persistent. The Pi uses the named Docker volume `karakeep-kokoro-cache`; do not publish the worker's port.
- Cache entries are private, compressed timed-audio JSON, keyed by exact text, voice, pinned model/voice revision and alignment version.
- The single-writer cache uses atomic replacement and removes interrupted writes at startup.
- Storage is bounded to 2 GiB, evicting least-recently-used chunks. Older evicted audio is regenerated on demand.
- Playback retains the normal owner/session/CSRF checks before contacting the worker. Cached audio is not exposed by a public file server.

The Pi cannot generate an entire library instantly. The initial ten-article backfill runs in the background; cached chunks are fast, but uncached chunks can still buffer. A new content/model/alignment version requires new audio. Article jumps can create different chunk boundaries and therefore cache misses.

## Pi deployment and rollback

Kokoro Compose: `/data/coolify/auxiliary/kokoro/compose.json` (2.5 GiB, 3 CPUs, read-only root filesystem, private network). App image and raw/rendered Compose are persisted in Coolify.

Release artifacts and private rollback material: `/root/speech-cache-release-20261023` and `/root/speech-cache-release-20261023-v2`. Coolify settings snapshots are under `/data/coolify/backups/speech-cache-release-20261023*-before.json`. A consistent application SQLite backup was taken at `/data/backups/pre-speech-cache-20261023.db` inside Karakeep's data volume. These backups contain secrets/user data; keep them private. Do not restore the whole application database merely to roll back an image.

Validated: unit/integration tests, app and worker builds, isolated ARM64 smoke tests, all eight voices, native word timings with unspoken punctuation, persistent cache across restart, actual article cache hits, public app health and unauthenticated speech rejection. Manual listening and logged-in browser interaction were not performed.
