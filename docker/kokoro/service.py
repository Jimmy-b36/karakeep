"""Private, offline Kokoro service. Audio and timings come from the same synthesis."""
import base64
import hmac
import io
import json
import os
import re
import sys
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
MAX_TEXT_LENGTH = 320
VOICES = {
    "af_heart": ("Heart · American female", "en-US"),
    "af_bella": ("Bella · American female", "en-US"),
    "am_adam": ("Adam · American male", "en-US"),
    "am_michael": ("Michael · American male", "en-US"),
    "bf_emma": ("Emma · British female", "en-GB"),
    "bf_isabella": ("Isabella · British female", "en-GB"),
    "bm_george": ("George · British male", "en-GB"),
    "bm_lewis": ("Lewis · British male", "en-GB"),
}


def voice_id(value):
    if not isinstance(value, str) or not value.startswith("kokoro:"):
        raise ValueError("Invalid voice")
    name = value.removeprefix("kokoro:")
    if name not in VOICES:
        raise ValueError("Invalid voice")
    return name


def synthesize(pipeline, voice_file, text):
    import numpy as np
    audio_parts, words = [], []
    elapsed = 0.0
    # Misaki can drop apostrophes inside merged code/URL tokens; retain original offsets.
    positions = [i for i, character in enumerate(text) if character not in "'‘’"]
    normalized = "".join(text[i] for i in positions)
    cursor = 0
    for result in pipeline(text, voice=voice_file, speed=1):
        audio = result.audio.numpy()
        duration = len(audio) / 24000
        for token in result.tokens or []:
            spoken_text = token.text.translate(str.maketrans("", "", "'‘’"))
            if not spoken_text:
                continue
            position = normalized.find(spoken_text, cursor)
            if position < 0:
                raise ValueError("Tokenizer text cannot be mapped to the original")
            cursor = position + len(spoken_text)
            begin_position, end_position = positions[position], positions[cursor - 1] + 1
            if token.start_ts is None or token.end_ts is None:
                if token.phonemes:
                    raise ValueError("Spoken token has no timing")
                continue
            start, end = float(token.start_ts), float(token.end_ts)
            if not 0 <= start <= end <= duration + 0.1:
                raise ValueError("Invalid generated timing")
            # Browser DOM ranges use UTF-16 offsets, Python strings use codepoints.
            begin = len(text[:begin_position].encode("utf-16-le")) // 2
            finish = len(text[:end_position].encode("utf-16-le")) // 2
            words.append({"from": begin, "to": finish, "start": elapsed + start, "end": elapsed + end})
        audio_parts.append(audio)
        elapsed += duration
    if not words or not audio_parts or any(a["start"] > b["start"] for a, b in zip(words, words[1:], strict=False)):
        raise ValueError("No usable word alignment")
    audio = np.concatenate(audio_parts)
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    payload = output.getvalue()
    if len(payload) > 32 * 1024 * 1024:
        raise ValueError("Audio too large")
    return {"audio": base64.b64encode(payload).decode("ascii"), "words": words, "duration": elapsed}


def trim_speech(result, text):
    """Remove model edge padding on delivery, including from existing cache entries."""
    import numpy as np

    with wave.open(io.BytesIO(base64.b64decode(result["audio"]))) as wav:
        rate = wav.getframerate()
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
    audible = np.flatnonzero(samples)
    if not len(audible):
        return result
    # Trim only digital silence: retain every nonzero sample, however quiet.
    first = max(0, int(audible[0]) - round(0.05 * rate))
    pause = 0.25 if re.search(r"[.!?:;][\"'’”)]*\s*$", text) else 0.1
    last = min(len(samples), int(audible[-1]) + 1 + round(pause * rate))
    if first == 0 and last == len(samples):
        return result
    duration = (last - first) / rate
    shift = first / rate
    words = [dict(word, start=min(duration, max(0, word["start"] - shift)),
                  end=min(duration, max(0, word["end"] - shift))) for word in result["words"]]
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(samples[first:last].tobytes())
    return {"audio": base64.b64encode(output.getvalue()).decode("ascii"),
            "words": words, "duration": duration}


def main(prepare=False):
    from cache import SpeechCache
    from inference import MODEL_HASH, load_pipelines

    pipelines, voice_files = load_pipelines(VOICES, MODEL_REVISION, prepare)
    if prepare:
        for name in ("af_heart", "bf_emma"):
            list(pipelines[name[0]]("This is a synthetic timing check.", voice=voice_files[name], speed=1))
        print("All eight voices and both English tokenizers prepared.")
        return
    token = os.environ.get("KOKORO_TOKEN", "")
    if len(token) < 32:
        raise RuntimeError("KOKORO_TOKEN must contain at least 32 characters")
    # Old entries may omit names when espeak was silently unavailable.
    cache = SpeechCache(os.environ.get("KOKORO_CACHE_DIR", "/cache"), f"v3:{MODEL_HASH}:{MODEL_REVISION}")
    busy = threading.Lock()
    last_foreground = float("-inf")

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, format, *args):
            pass  # Never log article text, credentials or request bodies.

        def reply(self, status, value, retry_after=1, cache_hit=None):
            body = json.dumps(value, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            if status == 503:
                self.send_header("Retry-After", str(retry_after))
            if cache_hit is not None:
                self.send_header("X-Speech-Cache", "hit" if cache_hit else "miss")
            self.end_headers()
            self.wfile.write(body)

        def authorized(self):
            return hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + token).encode())

        def do_GET(self):
            if self.path == "/health":
                return self.reply(200, {"ok": True})
            if not self.authorized():
                return self.reply(401, {"error": "Unauthorized"})
            if self.path == "/voices":
                return self.reply(200, [{"id": f"kokoro:{name}", "name": f"Kokoro {label} · word highlighting", "language": language} for name, (label, language) in VOICES.items()])
            self.reply(404, {"error": "Not found"})

        def do_POST(self):
            nonlocal last_foreground
            self.close_connection = True
            if not self.authorized():
                return self.reply(401, {"error": "Unauthorized"})
            if self.path != "/synthesize":
                return self.reply(404, {"error": "Not found"})
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                return self.reply(400, {"error": "Expected JSON"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 48000:
                    return self.reply(413, {"error": "Invalid body length"})
                data = json.loads(self.rfile.read(size))
                text = data.get("text") if isinstance(data, dict) else None
                # shortcut: cap sentence batches at 320 codepoints; benchmark the Pi before raising it.
                if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_LENGTH:
                    return self.reply(400, {"error": "Invalid text or voice"})
                selected_voice = voice_id(data.get("voice"))
            except (ValueError, OSError):
                return self.reply(400, {"error": "Invalid request"})
            # Only bracketed text can have legacy Markdown-preprocessed cache entries.
            cache_voice = f"{selected_voice}:literal-v1" if "[" in text else selected_voice
            # Legacy multiline cache entries contain per-line prosody resets.
            if "\n" in text or "\r" in text:
                cache_voice = f"{selected_voice}:unwrapped-v1"
            background = self.headers.get("X-Speech-Priority") == "background"
            if not background:
                last_foreground = time.monotonic()
            cached = cache.get(text, cache_voice)
            if cached is not None:
                return self.reply(200, trim_speech(cached, text), cache_hit=True)
            if background and time.monotonic() - last_foreground < 30:
                return self.reply(503, {"error": "Listening has priority"}, retry_after=30)
            # Reserve 40s of the app's 70s request deadline for sentence synthesis.
            acquired = busy.acquire(blocking=False) if background else busy.acquire(timeout=30)
            if not acquired:
                return self.reply(503, {"error": "Busy"})
            try:
                cached = cache.get(text, cache_voice)
                if cached is not None:
                    return self.reply(200, trim_speech(cached, text), cache_hit=True)
                result = synthesize(pipelines[selected_voice[0]], voice_files[selected_voice], text)
                try:
                    cache.put(text, cache_voice, result)
                except OSError:
                    if background:
                        raise
                    print("Speech cache write failed; serving uncached audio", file=sys.stderr, flush=True)
                self.reply(200, trim_speech(result, text), cache_hit=False)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as error:
                location = traceback.extract_tb(error.__traceback__)[-1]
                # Log code location, never exception messages that may contain article text.
                print(f"Speech generation failed: {type(error).__name__} at {os.path.basename(location.filename)}:{location.lineno}", file=sys.stderr, flush=True)
                self.reply(502, {"error": "Local speech generation failed"})
            finally:
                if not background:
                    last_foreground = time.monotonic()
                busy.release()

    # Docker deployments explicitly opt into their private interface; publish no ports.
    ThreadingHTTPServer((os.environ.get("KOKORO_BIND", "127.0.0.1"), 4320), Handler).serve_forever()


if __name__ == "__main__":
    main(prepare="--prepare" in sys.argv[1:])
