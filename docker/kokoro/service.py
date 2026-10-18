"""Private, offline Kokoro service. Audio and timings come from the same synthesis."""
import base64
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import threading
import wave

MODEL_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
MODEL_HASH = "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4"
VOICE = "kokoro:af_heart"


def synthesize(pipeline, voice_file, text):
    import numpy as np
    audio_parts, words = [], []
    elapsed = 0.0
    cursor = 0
    for result in pipeline(text, voice=voice_file, speed=1):
        audio = result.audio.numpy()
        duration = len(audio) / 24000
        for token in result.tokens or []:
            position = text.find(token.text, cursor)
            if position < 0:
                raise ValueError("Tokenizer text cannot be mapped to the original")
            cursor = position + len(token.text)
            if token.start_ts is None or token.end_ts is None:
                if token.phonemes:
                    raise ValueError("Spoken token has no timing")
                continue
            start, end = float(token.start_ts), float(token.end_ts)
            if not 0 <= start <= end <= duration + 0.1:
                raise ValueError("Invalid generated timing")
            # Browser DOM ranges use UTF-16 offsets, Python strings use codepoints.
            begin = len(text[:position].encode("utf-16-le")) // 2
            finish = len(text[:cursor].encode("utf-16-le")) // 2
            words.append({"from": begin, "to": finish, "start": elapsed + start, "end": elapsed + end})
        audio_parts.append(audio)
        elapsed += duration
    if not words or not audio_parts or any(a["start"] > b["start"] for a, b in zip(words, words[1:])):
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


def main():
    import torch
    from huggingface_hub import hf_hub_download
    from kokoro import KModel, KPipeline

    token = os.environ.get("KOKORO_TOKEN", "")
    if len(token) < 32:
        raise RuntimeError("KOKORO_TOKEN must contain at least 32 characters")
    torch.set_num_threads(2)
    def artifact(filename):
        return hf_hub_download("hexgrad/Kokoro-82M", filename, revision=MODEL_REVISION, local_files_only=True)
    model_file = artifact("kokoro-v1_0.pth")
    if hashlib.sha256(Path(model_file).read_bytes()).hexdigest() != MODEL_HASH:
        raise RuntimeError("Model checksum mismatch")
    model = KModel(config=artifact("config.json"), model=model_file).eval()
    pipeline = KPipeline(lang_code="a", model=model, repo_id="hexgrad/Kokoro-82M")
    voice_file = artifact("voices/af_heart.pt")
    busy = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_args):
            pass  # Never log article text, credentials or request bodies.

        def reply(self, status, value):
            body = json.dumps(value, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            if status == 503:
                self.send_header("Retry-After", "1")
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
                return self.reply(200, [{"id": VOICE, "name": "Kokoro Heart · word highlighting", "language": "en-US"}])
            self.reply(404, {"error": "Not found"})

        def do_POST(self):
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
                if not isinstance(text, str) or not text.strip() or len(text) > 2000 or data.get("voice") != VOICE:
                    return self.reply(400, {"error": "Invalid text or voice"})
            except (ValueError, OSError):
                return self.reply(400, {"error": "Invalid request"})
            if not busy.acquire(blocking=False):
                return self.reply(503, {"error": "Busy"})
            try:
                self.reply(200, synthesize(pipeline, voice_file, text))
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                self.reply(502, {"error": "Local speech generation failed"})
            finally:
                busy.release()

    ThreadingHTTPServer(("0.0.0.0", 4320), Handler).serve_forever()


if __name__ == "__main__":
    main()
