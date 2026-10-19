"""Feasibility/latency fixture: align one WAV (stdin) against its known text (argv).

Prints JSON with model-load time, three align-pass timings, audio duration and the
recovered word timings. Runs entirely inside the container (no host mounts, no network).
"""
import io
import json
import sys
import time
import wave

import numpy as np
import torch
import torchaudio
from whisperx.alignment import load_align_model, align  # noqa: E402

SAMPLE_RATE = 16000
MODEL_DIR = "/opt/align-model"


def decode_wav(data):
    with wave.open(io.BytesIO(data), "rb") as w:
        sr = w.getframerate()
        nch = w.getnchannels()
        sw = w.getsampwidth()
        frames = w.readframes(w.getnframes())
    if sw == 2:
        x = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 1:
        x = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        x = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483648.0
    if nch > 1:
        x = x.reshape(-1, nch).mean(axis=1)
    t = torch.from_numpy(x)
    if sr != SAMPLE_RATE:
        t = torchaudio.functional.resample(t, sr, SAMPLE_RATE)
    return t


def main():
    text = sys.argv[1] if len(sys.argv) > 1 else ""
    wav = sys.stdin.buffer.read()
    t0 = time.perf_counter()
    model, metadata = load_align_model("en", "cpu", model_dir=MODEL_DIR)
    load_s = time.perf_counter() - t0
    audio = decode_wav(wav)
    duration = float(audio.numel()) / SAMPLE_RATE
    align_times = []
    words = []
    for _ in range(3):
        t1 = time.perf_counter()
        result = align([{"text": text, "start": 0.0, "end": duration}], model, metadata, audio=audio, device="cpu")
        align_times.append(round(time.perf_counter() - t1, 3))
        words = [{"word": w["word"], "start": round(w["start"], 3), "end": round(w["end"], 3)}
                 for w in result["word_segments"] if "start" in w and "end" in w]
    print(json.dumps({"load_s": round(load_s, 3), "align_s": align_times,
                      "duration": round(duration, 3), "words": words}))


if __name__ == "__main__":
    main()
