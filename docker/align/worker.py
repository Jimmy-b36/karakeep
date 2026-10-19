"""Containerized WhisperX forced-alignment worker (see VENDOR.md).

Loads the torchaudio wav2vec2 alignment model once (warm) and exposes POST /align,
which force-aligns the already-known sentence text against a 16-bit PCM WAV and returns
word timings. Transcription and diarization are deliberately not imported.
"""
import os
import io
import json
import wave
import base64
import threading
import hmac
import socket
from typing import cast
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SAMPLE_RATE = 16000
MODEL_DIR = os.environ.get("MODEL_DIR", "/opt/align-model")
MAX_WAV = 8 * 1024 * 1024  # decoded WAV bytes; the server never aligns larger clips
MAX_TEXT = 10000
REQUEST_DEADLINE = 15

_model = None
_metadata = None
_ready = False
_load_lock = threading.Lock()
_align_lock = threading.Lock()


def ensure_model():
    global _model, _metadata, _ready
    with _load_lock:
        if _ready:
            return
        from whisperx.alignment import load_align_model
        _model, _metadata = load_align_model("en", "cpu", model_dir=MODEL_DIR)
        _ready = True


def decode_wav(data: bytes):
    import numpy as np
    import torch
    import torchaudio

    with wave.open(io.BytesIO(data), "rb") as w:
        sr = w.getframerate()
        nch = w.getnchannels()
        sw = w.getsampwidth()
        if not (8000 <= sr <= 192000 and 1 <= nch <= 2 and 0 < w.getnframes() <= sr * 120):
            raise ValueError("WAV must contain at most 120 seconds of mono/stereo audio")
        frames = w.readframes(w.getnframes())
    if sw == 2:
        x = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 1:
        x = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif sw == 4:
        x = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError("unsupported WAV sample width %d" % sw)
    if nch > 1:
        x = x.reshape(-1, nch).mean(axis=1)
    t = torch.from_numpy(x)
    if sr != SAMPLE_RATE:
        t = torchaudio.functional.resample(t, sr, SAMPLE_RATE)
    return t


def align_text(text: str, audio):
    from whisperx.alignment import align

    duration = float(audio.numel()) / SAMPLE_RATE
    result = align([{"text": text, "start": 0.0, "end": duration}], _model, _metadata, audio=audio, device="cpu")
    words = []
    for w in result.get("word_segments", []):
        word = w.get("word")
        start, end = w.get("start"), w.get("end")
        if not isinstance(word, str) or not word:
            continue
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            continue
        start, end = float(start), float(end)
        if not (0.0 <= start <= end <= duration + 0.05):
            continue
        words.append({"word": word, "start": round(start, 3), "end": round(end, 3)})
    return {"duration": round(duration, 3), "words": words}


class AlignmentServer(ThreadingHTTPServer):
    # Admit before spawning a thread or reading audio, including unauthenticated clients.
    def __init__(self, address, handler, token):
        if len(token) < 32:
            raise ValueError("REEDIT_ALIGN_TOKEN must contain at least 32 characters")
        self.token = token
        self.slot = threading.BoundedSemaphore(1)
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        assert isinstance(request, socket.socket)
        request.settimeout(10)
        if not self.slot.acquire(blocking=False):
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nRetry-After: 1\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slot.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slot.release()


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        # Absolute header/body deadline also stops clients that trickle bytes forever.
        self.deadline = threading.Timer(REQUEST_DEADLINE, self.expire_request)
        self.deadline.start()

    def expire_request(self):
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def finish(self):
        self.deadline.cancel()
        super().finish()

    def log_message(self, format, *args):  # silence per-request logging
        return

    def _json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            pass  # Client disconnected or the request deadline closed the socket.

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "ready": _ready})
            return
        self._json(404, {"error": "Not found"})

    def do_POST(self):
        self.close_connection = True
        expected = ("Bearer " + cast(AlignmentServer, self.server).token).encode()
        if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), expected):
            self._json(401, {"error": "Unauthorized"})
            return
        if self.path != "/align":
            self._json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if not (0 < length <= 12 * 1024 * 1024):
                self._json(413, {"error": "Request too large"})
                return
            payload = json.loads(self.rfile.read(length))
            self.deadline.cancel()
            if not isinstance(payload, dict):
                self._json(400, {"error": "Expected an object"})
                return
            text = payload.get("text")
            wav_b64 = payload.get("wav")
            if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
                self._json(400, {"error": "Invalid text"})
                return
            if not isinstance(wav_b64, str) or len(wav_b64) > 12 * 1024 * 1024:
                self._json(400, {"error": "Invalid audio"})
                return
            wav = base64.b64decode(wav_b64, validate=True)
            if len(wav) > MAX_WAV:
                self._json(413, {"error": "Audio too large"})
                return
            audio = decode_wav(wav)
            if audio.numel() < 400 or audio.numel() > MAX_WAV * 2:
                self._json(400, {"error": "Audio out of range"})
                return
            ensure_model()
            with _align_lock:
                self._json(200, align_text(text.strip(), audio))
        except ValueError as e:
            self._json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 - report any aligner failure to the caller
            self._json(500, {"error": "Alignment failed: %r" % (e,)})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "4319"))
    # Validate credentials before loading the model; publish only to a private interface.
    server = AlignmentServer(("0.0.0.0", port), Handler, os.environ.get("REEDIT_ALIGN_TOKEN", ""))
    ensure_model()
    print("align worker listening on 0.0.0.0:%d ready=%s" % (port, _ready), flush=True)
    server.serve_forever()
