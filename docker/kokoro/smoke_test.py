"""Run inside the isolated test container after its health check passes."""
import base64
import io
import json
import os
import secrets
import time
import wave
from http.client import HTTPConnection

from service import MAX_TEXT_LENGTH, VOICES

TOKEN = os.environ["KOKORO_TOKEN"]


def request(path, body=None, token=TOKEN, background=False):
    data = None if body is None else json.dumps(body).encode()
    connection = HTTPConnection("127.0.0.1", 4320, timeout=65)
    try:
        connection.request("GET" if body is None else "POST", path, body=data, headers={
            "Authorization": "Bearer " + token, "Content-Type": "application/json",
            **({"X-Speech-Priority": "background"} if background else {}),
        })
        response = connection.getresponse()
        return response.status, json.load(response), response.getheader("X-Speech-Cache")
    finally:
        connection.close()


invalid_token = secrets.token_hex(32)
assert request("/voices", token=invalid_token)[0] == 401
assert request("/synthesize", {"text": "Hello", "voice": "kokoro:af_heart"}, token=invalid_token)[0] == 401
for body in ({"text": "", "voice": "kokoro:af_heart"}, {"text": "Hello", "voice": "kokoro:../../etc/passwd"}, {"text": "x" * (MAX_TEXT_LENGTH + 1), "voice": "kokoro:af_heart"}):
    assert request("/synthesize", body)[0] == 400
status, voices, _ = request("/voices")
assert status == 200
assert {v["id"] for v in voices} == {"kokoro:" + v for v in VOICES}
text = "Hello, hello! Today's reading has twelve books and repeated words. This checks natural speech and accurate highlighting."
maximum_chunk = ("Bright morning sunshine fills the quiet room while we read another interesting story together. " * 4)[:MAX_TEXT_LENGTH]
assert len(maximum_chunk) == MAX_TEXT_LENGTH
reports = []
for voice, text in [*[(v, text) for v in voices], (voices[0], maximum_chunk), (voices[0], "Yes. Exactly. This thought continues\nacross a wrapped line.")]:
    started = time.monotonic()
    status, result, cache_status = request("/synthesize", {"text": text, "voice": voice["id"]})
    assert status == 200, (voice["id"], status, result)
    elapsed = time.monotonic() - started
    assert cache_status == "miss"
    cached_status, cached_result, cached_header = request("/synthesize", {"text": text, "voice": voice["id"]}, background=True)
    assert cached_status == 200 and cached_header == "hit" and cached_result == result
    with wave.open(io.BytesIO(base64.b64decode(result["audio"], validate=True))) as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, 24000)
        assert abs(wav.getnframes() / wav.getframerate() - result["duration"]) < 0.01
    assert result["words"]
    previous_end = 0
    previous_start = 0.0
    for word in result["words"]:
        assert previous_end <= word["from"] < word["to"] <= len(text)
        assert previous_start <= word["start"] <= word["end"] <= result["duration"] + 0.1
        previous_end, previous_start = word["to"], word["start"]
    assert elapsed < 65
    reports.append({"voice": voice["id"], "characters": len(text), "generation_seconds": round(elapsed, 2), "audio_seconds": round(result["duration"], 2), "real_time_factor": round(elapsed / result["duration"], 2)})
    print(json.dumps(reports[-1]), flush=True)
assert request("/synthesize", {"text": "Uncached background preparation must yield to this listener.", "voice": "kokoro:bf_emma"}, background=True)[0] == 503
assert request("/health")[0] == 200
print("PASS: authentication, validation, eight voices, maximum chunk, WAV audio, timings, cache hits and foreground priority.")
