# Sentence-aware TTS batching research

## Decision

Use sentence-aware accumulation, not one synthesis request per full stop: append complete sentences within a paragraph until a conservative size target is reached, then flush. Never deliberately cut through a sentence; only use a clause/whitespace fallback when one sentence alone exceeds the hard limit.

For the current local integration, keep the **160-character hard ceiling** reported in the repository context and use a lower soft target (for example, 140–150 characters) so a short following sentence can be grouped when it fits. The suggested 320–480-character range is a **benchmark candidate only**: it cannot be used while the shared service rejects inputs above 160, and it is not proven safe merely by Kokoro's phoneme limit.

## What the official sources establish

1. **Speechify exposes request limits, not a documented internal chunking policy.** Its current API documentation says `/v1/audio/speech` accepts 2,000 spoken characters and `/v1/audio/stream` accepts 20,000. The streaming request as transmitted (including markup) may be 32,000 characters; SSML tags do not count towards the spoken-character limit. The docs tell clients to split longer text, but do **not** describe how Speechify internally groups sentences or preserves sentence/paragraph context.  
   Source: [Speechify API limits](https://docs.speechify.ai/docs/api-limits).

2. **Speechify streaming is delivery behavior, not evidence about linguistic batching.** `POST /v1/audio/stream` returns audio as it is generated (HTTP chunked) for lower-latency playback. This is distinct from deciding the text supplied in one request, so it should not be used as evidence that a model carries context across separate client requests.  
   Source: [Speechify Stream Speech](https://docs.speechify.ai/build/api-reference/v1/audio/stream).

3. **Speechify supports explicit SSML pauses.** Its documentation supports `<break>` inside `<speak>`; a timed break is 0–10 seconds and total inserted silence is capped at 30 seconds per document. This is provider-specific capability, not evidence that Kokoro accepts the same markup.  
   Source: [Speechify SSML](https://docs.speechify.ai/build/guides/text-to-speech/ssml).

4. **The official Kokoro `KPipeline` source has a phoneme, not character, inference boundary for English.** In the current upstream source, English tokenization splits when the next segment would exceed 510 phonemes, preferring `!.?…`, then `:;`, then `,—` where possible. The default `KPipeline.__call__` `split_pattern` is `r'\n+'`, so newlines create top-level input segments. A long punctuation-free sentence can still need splitting. This upstream source is relevant but version-sensitive; validate against the installed pinned package before relying on exact behavior.  
   Source: [hexgrad/kokoro `pipeline.py`](https://github.com/hexgrad/kokoro/blob/main/kokoro/pipeline.py); [official repository](https://github.com/hexgrad/kokoro).

## Recommended local policy (design recommendation, not a Speechify claim)

1. Preserve the canonical article text and offsets exactly; treat ordinary whitespace as equivalent only when detecting boundaries. Do not rewrite text or joining whitespace, because playback ranges, cache keys and UTF-16 highlighting depend on it. Preserve paragraph boundaries.
2. Within each paragraph, identify sentence candidates and append whole candidates to the current batch while the **hard limit** remains satisfied. Flush before adding a candidate that would exceed it. Do not make every terminal punctuation mark a request boundary.
3. Flush at a paragraph boundary by default. This keeps paragraph-level grouping where it is cheap, without combining unrelated blocks indefinitely.
4. If one sentence exceeds the hard limit, split it in descending preference: clause punctuation (`;`, `:`, comma/dash), then whitespace. Preserve text exactly. Avoid cutting inside words, numbers and URLs where possible; an individual token longer than the safety ceiling still requires a Unicode-codepoint-safe fallback or an explicit error, not an unbounded request. Record that this was a forced split.
5. Use ordinary punctuation for normal prosody. Do not add artificial pauses merely to imitate Speechify SSML; add pause markup only if the local engine/interface explicitly supports and tests it.

### Boundary traps

A period is not always a sentence end. At minimum, protect:

- decimals and versions: `3.14`, `v1.2.3`;
- initials/acronyms: `U.S.`, `e.g.`, `i.e.`;
- common titles/abbreviations: `Dr.`, `Mr.`, `Ms.`, `Prof.`, `etc.`;
- URLs, email addresses, domains, ellipses, quoted punctuation, and closing brackets.

These are heuristics, not a complete language parser. The reported local check that `Intl.Segmenter('en', { granularity: 'sentence' })` separates `Dr. Smith` after `Dr.` is a concrete reason not to treat it as perfect abbreviation handling. A small post-merge/exception layer is preferable to adding a dependency for this scope.

## Local implementation context to preserve

Repository observations supplied for this research report: the shared chunker is currently whitespace-based with a hard 160-character limit; the service rejects inputs above 160; the same chunker is used by API and preparation paths. Therefore any future limit or grouping change must update both callers together and remain compatible with the 70-second upstream request timeout and 90-second preparation-job timeout. No application code was changed by this research task.

The same local observations show that the installed pinned Kokoro 0.9.4 English path uses the 510-phoneme boundary and punctuation waterfall above. Synthetic local measurements approximately produced 151, 295, and 441 phonemes for 160-, 320-, and 480-character inputs; a 640-character sample became two segments (421 and 164 phonemes). These are implementation-specific observations, **not** a hardware-safe character limit or an upstream guarantee.

## Benchmark before changing limits

Compare the current whitespace-160 behavior with sentence-aware grouping at the same 160 hard limit first. Only then test a coordinated higher envelope such as 320 and 480 characters. Use representative prose with short sentences, abbreviations, decimals, lists, long sentences, headings, paragraphs, URLs, and non-English content if supported.

Measure request count, time to first audio, total synthesis time, peak memory/CPU or GPU usage, timeout/error rate, and listening quality at joins (cut words, reset intonation, unnatural silence). Log characters and emitted phonemes/segments per batch where available. Keep the smaller envelope if the larger one harms latency, causes forced splits/truncation, or approaches the timeout; character count is only a proxy for Kokoro's phoneme limit.

## Recommended next experiment

The 160-character sentence-aware variant is a low-risk baseline, not the likely end state: any longer sentence would still need a forced mid-sentence cut. Benchmark complete-sentence batches near 320 and 480 characters before choosing a coordinated higher ceiling, and compare real article joins by listening. Accumulate short sentences within the chosen envelope rather than enforcing one request per sentence. Keep the existing player, shared preparation/playback chunker and literal offset mapping; do not introduce SSML or a new provider for this change. Version the chunking/content contract if boundaries change, so old continuation offsets cannot mix with the new policy.

## Residual uncertainty

- No official Speechify source found documents its internal sentence/paragraph batching or context behavior; none is asserted here.
- Upstream `main` can differ from the installed Kokoro package, and non-English paths may behave differently; validate the exact installed source and run real local inference.
- The best soft target depends on voice, language, hardware, queueing, and the local service timeout, so it must be measured rather than inferred from external API limits.
