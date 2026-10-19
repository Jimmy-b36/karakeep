# WhisperX alignment-only worker (sandboxed, Karakeep fork)

Forced alignment of the already-known sentence text against the generated WAV,
using **WhisperX alignment only** — transcription (`faster-whisper`) and diarization
(`pyannote.audio`) are deliberately not installed or invoked. The model is the
torchaudio `WAV2VEC2_ASR_BASE_960H` wav2vec2 alignment model (English). Audio never
waits on alignment: the Reedit server serves the WAV immediately and requests timings
asynchronously through the worker below.

## Pinned sources (audit trail)

| Component | Pin | License |
|---|---|---|
| `whisperx` (PyPI `whisperx==3.1.1`, alignment module only) | git tag `v3.1.1` == commit `d8a2b4ffc9e33584e453c3d433cedf6f60651350` | BSD-4-Clause (Max Bain) |
| Alignment model | torchaudio `WAV2VEC2_ASR_BASE_960H` (fairseq `wav2vec2_base_ls960`) | Review before production distribution (downloaded from download.pytorch.org) |
| Runtime deps | `requirements.txt` (torch 2.2.2, torchaudio 2.2.2, numpy 1.26.4, pandas 2.2.2, nltk 3.8.1, ffmpeg-python 0.2.0) | BSD/MIT/PSF |

### Deviations from the upstream wheel (applied at build time, in the Dockerfile)

1. `whisperx/__init__.py` is neutralized so `import whisperx.alignment` does not pull the
   transcription/diarization entrypoints whose dependencies are absent by design.
2. `alignment.py`'s top-level `from transformers import ...` is moved into the
   HuggingFace-model branch. It is only required by the non-torchaudio path, which this
   worker never uses; the move avoids installing `transformers`.

Both patches are applied by `prepare.py` during the image build with an
invariant assertion so a silent upstream change fails the build instead of drifting.

## Build & run (isolated — no host mounts, no runtime network)

```bash
docker build -t karakeep-align -f docker/align/Dockerfile .
# Feasibility/latency fixture: WAV bytes in on stdin, text as argv, JSON out on stdout.
say -o /tmp/align-fixture.aiff "The quick brown fox jumps over the lazy dog."
afconvert -f WAVE -d LEI16 /tmp/align-fixture.aiff /tmp/align-fixture.wav
docker run -i --rm --network none karakeep-align python fixture.py "The quick brown fox jumps over the lazy dog." < /tmp/align-fixture.wav
```

The worker listens on `0.0.0.0:4319` inside the container and requires a bearer token
(`REEDIT_ALIGN_TOKEN`, at least 32 characters; reuse the same secret as the server's
`REEDIT_ALIGN_TOKEN`). It admits one request at a time before spawning a handler or
reading audio; excess requests receive 503. Request bodies have size limits and
deadlines. Karakeep reaches it with `REEDIT_ALIGN_URL` on the private service network.
Never publish its port; loopback publication does not imply disabled outbound networking.

The server's `POST /align` response is `{"duration": seconds, "words": [{"word", "start",
"end"}, ...]}`. `packages/shared-server/src/speech-offsets.ts` maps the verbatim tokens to
UTF-16 offsets in the original article text before the private JSON reaches the browser.

`POST /align` body: `{"text": string, "wav": base64(16-bit PCM WAV)}` → `200` with
`{"duration": seconds, "words": [{"word","start","end"}, ...]}`. Word strings are the
verbatim whitespace-separated tokens of the input text (original case/punctuation), in
order — the browser maps them back to UTF-16 source offsets.
