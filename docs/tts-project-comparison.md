# TTS project comparison: sentence grouping and natural narration

## Conclusion

**Borrow Kokoro-FastAPI's sentence packer, Readest/foliate-js's abbreviation repair, and ebook2audiobook's short-group handling—not a new engine.** Our 160-codepoint request ceiling still forces mid-sentence synthesis resets. Improving sentence detection without revisiting that ceiling only partially addresses the complaint.

A full stop should be a candidate boundary, not an automatic request boundary. Accumulate complete sentences toward a soft target, permit a bounded overrun to finish a thought or avoid a tiny chunk, and split inside a sentence only when the hard safety ceiling requires it.

This is source-level evidence and a design recommendation, **not a listening comparison or a Pi performance benchmark**.

## How the research ran

Requested execution: a new Rex tab, `tts-project-research`, with two OpenCode Go models:

- `opencode-go/deepseek-v4-pro`: Kokoro-FastAPI, upstream Kokoro and AllTalk.
- `opencode-go/glm-5.3`: Readest, its foliate-js sentence layer, and ebook2audiobook.

Both processes completed successfully. Separate scratch reports and public source checkouts remain under `/tmp/karakeep-tts-project-research-20261030/{backend,readers}`. The parent checked the reported commit SHAs and inspected the central packer, defaults, abbreviation merge and short-group merge implementations. This note excludes speculative causal explanations in the model reports. No application code, production configuration or audio cache was changed.

## What the projects actually do

| Project / inspected path | Relevant behavior | What transfers |
| --- | --- | --- |
| **Kokoro-FastAPI** (`632b716f8008e59341ecedabe30d716a494fa6e0`) | Packs complete sentences using minimum/target/maximum budgets; splits oversized sentences at clauses, then words. | Most directly applicable grouping algorithm: same Kokoro/Misaki versions as our service. |
| **Readest + foliate-js** (`df5070af0cb2d476ffd172fbeaa0e80e830b5338`; foliate `0c7a0edcda672218e958fb92b4cdf090d7ca9daa`) | Uses `Intl.Segmenter` plus abbreviation post-merging. Its own cloud provider batches sentence requests; browser and Edge paths behave differently. | Sentence recognition and buffering ideas, not an assumption that all its engines synthesize multiple sentences together. |
| **ebook2audiobook** (`0a98ac313ec43a470ee1e5feb13dd881ffb3e969`) | Explicitly merges orphan-short text groups into a neighbour within a larger merge budget. | Direct precedent for keeping short sentences from becoming tiny standalone requests. |
| **AllTalk v2 / alltalkbeta** (`f16117e95b540e9bbbd8247b49ca6c6b1350b172`) | The inspected XTTS path delegates splitting to the engine and supports streamed output. | Useful comparison, but a less direct solution than the same-engine Kokoro reference. Other AllTalk engine paths were not comprehensively reviewed. |

### 1. Kokoro-FastAPI: a close match to the requested behavior

Its defaults are **175 minimum-target, 250 target, 450 absolute maximum** in its token-counting units. Its packer appends another whole sentence when either:

- the combined chunk fits the 250 target; or
- the existing chunk is below 175 and the combined chunk still fits 450.

Otherwise it flushes. Thus short sentences stay together, without making the budget unlimited. An individual sentence over the maximum is split at clause punctuation and, if necessary, word boundaries.

Sources:

- [Budget defaults](https://github.com/remsky/Kokoro-FastAPI/blob/632b716f8008e59341ecedabe30d716a494fa6e0/api/src/core/config.py#L62-L66).
- [Clause/word fallback and sentence packer](https://github.com/remsky/Kokoro-FastAPI/blob/632b716f8008e59341ecedabe30d716a494fa6e0/api/src/services/text_processing/text_processor.py#L190-L271).
- [Phonemizer used for its token-counting proxy](https://github.com/remsky/Kokoro-FastAPI/blob/632b716f8008e59341ecedabe30d716a494fa6e0/api/src/services/text_processing/text_processor.py#L41-L76).
- [Project's intonation/size recommendation](https://github.com/remsky/Kokoro-FastAPI/blob/632b716f8008e59341ecedabe30d716a494fa6e0/README.md#L561-L564), an author recommendation rather than our measured result.

**Caveat:** these are not character counts. This project sizes with an espeak-based phoneme-symbol proxy before Misaki synthesis. Our direct Misaki path differs, so do not transplant the numbers as literal character limits or hardware guarantees.

### 2. Readest: sentence detection and delivery batching are separate

Foliate-js joins text for segmentation with length-preserving newline-to-space replacements, then merges apparent sentence fragments ending in titles/initials such as `Dr.`. This is a useful correction to bare `Intl.Segmenter`, which we observed splitting `Dr. Smith` after `Dr.`.

Readest's own voice provider uses listening windows that grow **1 → 4 → 8 sentences**, capped by character and estimated-audio budgets. However it receives audio per sentence. Client-side request batching does **not by itself establish shared model prosody or cross-sentence inference context**. Its Web Speech path constructs utterances per sentence mark, so it is not the pattern we want to copy wholesale for Kokoro.

Sources:

- [Foliate-js segmentation, length-preserving whitespace view and abbreviation merge](https://github.com/readest/foliate-js/blob/0c7a0edcda672218e958fb92b4cdf090d7ca9daa/tts.js#L24-L63).
- [Readest voice window policy/defaults](https://github.com/readest/readest/blob/df5070af0cb2d476ffd172fbeaa0e80e830b5338/apps/readest-app/src/services/tts/providers/readest.ts#L19-L54).
- [Web Speech per-mark utterances](https://github.com/readest/readest/blob/df5070af0cb2d476ffd172fbeaa0e80e830b5338/apps/readest-app/src/services/tts/WebSpeechClient.ts#L27-L77).

### 3. ebook2audiobook: explicitly avoid orphan-short groups

After forming initial groups, it treats a group at or below half its normal budget as short. It first tries to merge backward, otherwise forward, with a merge ceiling of 1.5 times the normal budget. This is a clear implementation of the requested short-sentence behavior.

Source: [Short-group merging](https://github.com/drewThomasson/ebook2audiobook/blob/0a98ac313ec43a470ee1e5feb13dd881ffb3e969/lib/core.py#L2026-L2060).

Do not copy its XTTS-specific punctuation rewrites or randomized pauses into Kokoro. Different model behavior and added pauses do not establish a remedy for our cadence issue.

### 4. AllTalk: streaming is not continuation context

The inspected XTTS integration passes `enable_text_splitting=True` to the model. Its streaming chunk size describes delivery, not a guarantee of linguistic continuity between independent synthesis requests.

Source: [XTTS streaming/inference arguments](https://github.com/erew123/alltalk_tts/blob/f16117e95b540e9bbbd8247b49ca6c6b1350b172/system/tts_engines/xtts/model_engine.py#L1072-L1085).

## Recommended Karakeep design

1. **Keep original text untouched.** Sentence detection may use a whitespace-normalized view with an offset map, but synthesis ranges, codepoint continuations and UTF-16 highlights must refer to the canonical text.
2. **Build deterministic groups of complete sentences within paragraphs.** Use the minimum/soft-target/hard-ceiling shape above; a short sentence should generally join its neighbours. Do not split merely because a full stop appears.
3. **Repair abbreviation boundaries.** Cover `Dr.`, initials, acronyms, decimals, versions, URLs, ellipses and closing quotes. Use an existing platform segmenter with a small tested repair layer, not a new parser dependency by default.
4. **Prefer paragraph ends, not wrapped lines, as a linguistic reset.** Kokoro's default `split_pattern=r'\n+'` can split a single grouped request into multiple model utterances. Account for that explicitly without silently rewriting canonical content or adding periods.
5. **Allow larger requests only after benchmarking.** Compare sentence-aware 160, 320 and 480-character envelopes with the current baseline. The 160 variant is a diagnostic control, not the likely final answer. Kokoro's native English ceiling is 510 phonemes, not 510 characters; leave a measured safety margin rather than target the limit.
6. **Use clause → whitespace → Unicode-safe hard fallback for genuinely oversized input.** A word/URL longer than the hard ceiling needs an explicit bounded policy, not an unbounded request or a promise never to split tokens.
7. **Keep preparation and playback identical.** Precompute or deterministically derive the same groups for both paths; never retroactively merge already-played chunks. Version the chunking/content contract so old continuation offsets cannot mix with a new grouping policy. Only changed chunk texts need new cached audio.
8. **Keep the existing audio engine and conservative silence handling.** Do not add SSML, random gaps, punctuation rewriting, crossfades, a second phonemizer, or a new TTS provider merely because another project has them.

Kokoro source: [English punctuation waterfall/510-phoneme boundary](https://github.com/hexgrad/kokoro/blob/dfb907a02bba8152ca444717ca5d78747ccb4bec/kokoro/pipeline.py#L184-L230); [default newline splitting](https://github.com/hexgrad/kokoro/blob/dfb907a02bba8152ca444717ca5d78747ccb4bec/kokoro/pipeline.py#L361-L376). These behaviors were also checked in the installed pinned 0.9.4 package during local investigation.

### Smallest useful next experiment

Make a fixed comparison set from representative article prose containing short sentences, a long sentence, abbreviations, headings and paragraphs. Compare the current 160-character splitter with sentence-aware 160/320/480 variants using Emma. Measure peak memory, generation time, time to first audio, emitted model segments, forced splits and failures. **Listen to joins**, including batches of short sentences, before selecting limits or deploying.

Preserve the Pi's 2.5-GiB/3-CPU budget and existing 70-second upstream request/90-second preparation-job limits during that experiment. Larger batches mean fewer context resets but more startup latency and longer non-preemptible inference; no safe optimum has been measured yet.

## License and evidence limits

The inspected projects declare Apache-2.0 (Kokoro-FastAPI, ebook2audiobook), MIT (foliate-js), and AGPL-3.0 (Readest, AllTalk); Karakeep itself uses AGPL. This is not a legal compatibility audit. No upstream code was copied; retain applicable notices if adapting code later.

No production access, inference runs, new dependencies or product edits were part of this research. Speechify's internal batching remains undocumented. Request batching, streaming delivery and shared linguistic model context must not be treated as interchangeable.
