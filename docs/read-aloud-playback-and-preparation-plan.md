# Read-aloud playback and incomplete preparation: investigation and repair plan

## Scope and confidence

The original findings below describe the pre-fix source and initially involved no production access. A subsequent authorized read-only production investigation and local implementation are summarized next. Existing unrelated untracked research notes were left alone.

## Implementation update (2026-10-30)

- Confirmed 41/41 canonical Emma chunks cached for the reported bookmark. Raw WAV digital-zero edge padding averaged 620 ms per chunk. The local delivery fix reduces this to 147 ms (76%) while preserving every nonzero sample and adjusting word times; no cache purge or audio-engine rewrite.
- Confirmed two other top-ten articles stalled at token-mapping failures around code/URL apostrophes. Misaki can omit apostrophes inside merged tokens, independently of its Markdown preprocessing. The fix maps apostrophe-normalized tokens back to original UTF-16 spans and disables Markdown preprocessing for literal article text. Standalone apostrophe punctuation has no word highlight; model durations remain unchanged.
- Validated the patched phonemizer/mapper against all 714 canonical chunks in the affected user's ten readable saved articles, using actual tokenizer output but no model inference. All map successfully.
- Implemented each user's ten newest readable saved links, startup/30-minute reconciliation with overlap protection, and chunk-identifying failure logs. Added regression tests.
- Existing plain-text cache entries remain usable. Bracketed text uses a new cache voice variant to avoid legacy Markdown-preprocessed output. Raw cache WAVs remain unchanged; padding is normalized on delivery.
- No production writes, restarts, or deployments. Browser/device/voice/speed reproduction, manual listening, Safari checks and post-deployment verification remain outstanding. Speculative time-based prefetch, underrun-engine changes, and sentence-chunker changes are deferred because the measured causes can be fixed without them.

See `docs/speech-preparation.md` for current behavior and regression commands. Historical line numbers below refer to the pre-fix source.

The two symptoms may reinforce each other: incompletely prepared audio requires foreground generation, and generation slower than playback can exhaust the buffered runway. They can also be independent: synthesized phrase boundaries or native fallback source swaps can sound discontinuous even on cache hits.

## Findings from primary sources

### 1. Ready chunks already use a continuous audio engine

`apps/web/lib/read-aloud-audio.ts:92-139,147-194,347-392` initializes one Signalsmith worklet, appends PCM, and advances chunk metadata without swapping sources. `apps/web/lib/read-aloud.ts:757-789` queues decoded prefetched buffers into it.

Executed `node scripts/verify-read-aloud-audio.cjs` successfully during this investigation. At 24/44.1/48 kHz and 0.75/1/1.5/2x, split-versus-whole synthetic PCM was sample-identical; real-time lifecycle and native fallback lifecycle checks also passed. See `docs/read-aloud-audio-verification.md` for the checks' scope.

**Interpretation:** do not replace the audio engine without evidence. This does not test real speech prosody, slow synthesis, deployed assets, or the affected user's browser.

### 2. Short independent synthesis requests can break speech cadence

`packages/shared/utils/speech.ts:16-39` caps chunks at 160 Unicode characters and searches backward for whitespace, not sentence completion. `packages/shared/utils/readableContent.ts:33-55` prefers nearby line boundaries but does not find sentence boundaries. `docker/kokoro/inference.py:45-57` synthesizes each request independently; `docker/kokoro/service.py:36-74` concatenates its raw outputs without boundary-silence processing.

**Confirmed limitation:** requests can split a sentence and lack cross-request linguistic context. **Unverified hypothesis:** the reported stutter includes model-generated pauses or abrupt intonation. Compare original WAVs and listen before changing silence; indiscriminate trimming/crossfades can clip speech and invalidate word timing.

### 3. Prefetch is bounded by chunk count, not playable time

`apps/web/lib/read-aloud.ts:706-754` fetches/decodes sequentially, retaining up to three future entries. It starts after initial playback begins (`:650-651`). Three chunks can represent little time around headings or at 2x. `schedulePrefetched` marks an entry scheduled before the asynchronous worklet upload finishes (`:757-789`; adapter upload at `apps/web/lib/read-aloud-audio.ts:159-194`). A fetched response is therefore not necessarily playable runway.

The scheduler's source clock advances toward the current end; adding audio after the engine needed it cannot repair already-rendered missing samples. If the queue empties, completion eventually triggers `handleEnded` and a navigation/reinitialization path (`apps/web/lib/read-aloud.ts:791-805`).

**Hypothesis needing reproduction:** late fetch/decode/upload causes gaps or loss near an underrun. Current synthetic boundary tests cover buffers appended in time, not the full slow-generation failure mode.

### 4. Native fallback is not gapless

`apps/web/lib/read-aloud-audio.ts:286-345` creates a separate WAV/object URL per chunk and waits for native `ended` before loading/playing the next one. Worklet initialization errors/timeouts select that fallback (`:92-139`). Without AudioContext, the player also uses per-blob native playback (`:568-629` in `apps/web/lib/read-aloud.ts`).

**Confirmed behavior:** fallback boundaries involve media reloads. **Unknown:** whether the user's deployed browser is taking this path. The existing fallback test proves output/lifecycle, not gaplessness.

### 5. "Top 10" currently means queued candidates, not verified ready articles

`apps/workers/workers/speechWorker.ts:28-75` selects the ten newest readable saved LINK bookmarks at worker startup. Selection is global across users, ordered by creation time, and excludes unreadable/unsaved items; this may differ from a particular UI list. `:78-143` prepares one chunk per durable job and chains continuations. A queued article is not yet a fully cached article.

Preparation uses only `kokoro:bf_emma` (`packages/shared/utils/speech.ts:6`; worker `:107-110`), while browser preferences preserve another selected voice (`apps/web/lib/hooks/useReadAloud.ts:19-30,143-159`). Other voices miss Emma's cache by design. Text changes and arbitrary jump offsets can also produce different cache keys/boundaries (see `docs/speech-preparation.md`).

### 6. Preparation can be postponed, fail, or lose cached chunks

`docker/kokoro/service.py:149-158,174-184` updates the foreground timestamp even for cache hits and rejects background cache misses for 30 seconds after foreground activity. Frequent listening requests can defer preparation indefinitely. Foreground priority is intentional, but this is not a completion guarantee.

`packages/shared-server/src/queues.ts:130-148` configures five retries and does not retain failed preparation jobs. Busy responses are specially deferred without consuming normal failure retries (`apps/workers/workers/speechWorker.ts:112-121`), but other repeated errors can terminate a continuation. Startup is a backfill trigger, not a periodic reconciliation loop (`apps/workers/index.ts:154-159`).

The Kokoro cache is bounded and LRU-evicted (`docker/kokoro/cache.py`; `docs/speech-preparation.md`). A historical "fully prepared" log is not proof that every chunk remains cached today.

## Prioritized repair plan

### Phase 1 — Diagnose the actual deployment and affected articles

1. Record deployed app/worker revision, selected voice, browser, playback speed, and whether the worklet or native fallback is active. Check the standalone worklet asset, CSP and processor errors. Use affected bookmark IDs, not article text in logs.
2. Enumerate the exact expected top-ten set using the actual UI ordering/filter, and compare it with `prepareRecentSpeech`. For each candidate report eligibility, content version, canonical chunk count, cache hit coverage for Emma, available queue/log evidence, and first missing offset. There is no existing cache-inspection API: non-generating inspection requires authorized host access and exact canonical cache keys; POST synthesis probes can generate misses and update LRU timestamps. Failed jobs are not retained, and Restate stats return `failed: 0` unconditionally (`packages/plugins/queue-restate/src/index.ts:72-89`), so an empty failure count is not evidence of success.
3. Reproduce a fully cached article and an uncached article at 1x/2x. Record per-chunk cache hit/miss, generation/request/decode/upload timing, buffered seconds and underruns. Propagate diagnostic cache status privately through the existing authenticated route if needed; expose neither raw text nor public cache URLs.
4. Listen to adjacent raw WAVs. Distinguish actual audio gaps, abrupt model cadence, and highlight/UI jumps. Capture leading/trailing quiet durations only as measurements.

**Deliverable:** a compact matrix tying each reported failure to fallback, late data, speech boundaries, wrong voice, selection mismatch, failed preparation, or eviction. Do not infer readiness from job-enqueued logs.

### Phase 2 — Fix confirmed playback causes, smallest change first

- If worklet initialization fails in deployment, fix asset loading/CSP/browser compatibility first. Keep native fallback for availability, but do not claim it is seamless. Improve fallback continuity only if this remains a supported affected path after that fix; existing native per-chunk reloads cannot guarantee gaplessness.
- Add delayed-fetch/decode/upload regression tests first. Buffer by decoded playable seconds adjusted for speed, with a hard memory/chunk cap; retain sequential worker requests. Allow a small initial runway where required, rather than beginning with an immediately starving stream. Choose the target from measured latency, not a guessed large queue.
- Define explicit underrun recovery: stop/freeze at the last actually playable source position, show buffering, and resume from the exact unplayed sample once sufficient audio is uploaded. Do not let source time/highlights run through missing audio or silently discard the beginning of a late segment. Keep normal ready boundaries on the existing continuous path.
- If raw cached speech confirms cadence breaks, change the shared Kokoro chunker to prefer sentence/clause/paragraph boundaries inside the existing 160-character cap, falling back to word boundaries for long sentences. Use identical boundaries for preparation and playback. Only consider a larger cap after Pi RAM/latency benchmarks; the current cap is a documented hardware guardrail (`docker/kokoro/service.py:142`).
- Only normalize measured excessive edge silence if sentence-aware splitting is insufficient. Preserve natural punctuation pauses and recalibrate all word timestamps/duration; version the cache representation if synthesis output changes.

### Phase 3 — Make preparation complete and recoverable

- Agree one concrete eligibility/order contract. If the intended behavior is each user's ten newest readable saved articles, select per user; if it is a particular sorted UI list, use that ordering explicitly. Do not expand to the entire library by accident.
- Keep Emma-only preparation initially and make that constraint visible near voice selection. Preparing all voices multiplies work without addressing the underlying completion failure.
- Add a lightweight reconciliation pass on startup and periodically for the eligible set. Walk deterministic canonical chunks, use cache hits to skip completed work, and enqueue missing work idempotently. Preserve existing cached chunks; do not clear the cache or restore a database. Recover interrupted/exhausted continuations through reconciliation.
- Retain actionable failure information and completion coverage. Extend existing preparation error logs with bookmark ID, chunk start, content version, and retries remaining, without article text. Reuse queue/job metadata and structured logs before introducing a new state table. Treat historical completion as advisory because eviction can invalidate it; recheck coverage for diagnosis and repair.
- Preserve foreground priority initially. If measured starvation is the blocker, first avoid treating a trivial cache hit as a long inference reservation or permit background work only when measured playback runway is safe. Do not simply remove the foreground guard and cause listener latency spikes. Review fairness only after actual queue/throughput measurements.

### Phase 4 — Validate and roll out

Tests:

- Player/scheduler: late next chunk before/at/after the boundary, delayed worklet upload, short headings, 2x, pause/resume while buffering, stop/voice change/navigation during decode, stale callbacks, and no skipped/repeated words after recovery.
- Real browser PCM: preserve existing split-versus-whole checks and add the underrun/resume scenario; test supported Safari/iOS as well as Chrome if those are affected. Separately assess native fallback.
- Chunker: sentences, paragraphs, long sentence fallback, punctuation, Unicode, exact offset continuity, no lost/duplicated content, <=160 characters, matching preparation/playback boundaries.
- Preparation: exact top-ten eligibility/order, multi-user semantics, missing content, voice mismatch, failed continuation, restart, duplicate enqueue, content recrawl, cache eviction, and bounded retries/reconciliation.
- Real Pi: benchmark synthesis time versus audio duration at 1x/2x and memory use with the final chunking/buffer policy. Manually listen to affected articles from the real cache, not just synthetic tone fixtures.

Acceptance:

- All chunks of the agreed ten eligible articles exist for the prepared voice after a documented quiet preparation window; exceptions are visible and recoverable, not silently called ready.
- Fully cached playback has no artificial reload/pause at normal chunk boundaries on the primary engine.
- Deliberately delayed chunks cause controlled buffering with no missing/repeated speech, not a clock running into absent samples.
- Existing pitch, timing/highlighting, cancellation, access-control and cache-persistence checks still pass.

## Recommended order

Start with deployment/cache coverage and one affected article. Then fix the demonstrated playback path and add preparation reconciliation. Sentence-aware chunking is the next small quality improvement if raw speech confirms cadence issues. Avoid an engine rewrite, new speech provider, all-voice backfill, cache purge, or larger synthesis requests until measurements justify them.
