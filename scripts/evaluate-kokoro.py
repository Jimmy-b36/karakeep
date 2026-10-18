"""Isolated synthetic evaluation only; never loads a user's library or credentials."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import wave

MODEL_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
MODEL_HASH = "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4"
ROOT = Path("/tmp/kokoro-evaluation")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare", action="store_true")
    args = parser.parse_args()
    import torch
    from huggingface_hub import hf_hub_download
    from kokoro import KModel, KPipeline
    import numpy as np

    torch.set_num_threads(2)
    ROOT.mkdir(exist_ok=True)
    paths = {}
    for filename in ["config.json", "kokoro-v1_0.pth", "voices/af_heart.pt"]:
        paths[filename] = hf_hub_download(
            "hexgrad/Kokoro-82M", filename, revision=MODEL_REVISION,
            local_files_only=not args.prepare,
        )
    model_file = Path(paths["kokoro-v1_0.pth"])
    assert hashlib.sha256(model_file.read_bytes()).hexdigest() == MODEL_HASH
    model = KModel(config=paths["config.json"], model=str(model_file)).eval()
    pipeline = KPipeline(lang_code="a", model=model, repo_id="hexgrad/Kokoro-82M")
    voice = paths["voices/af_heart.pt"]
    if args.prepare:
        list(pipeline("This is a synthetic timing check.", voice=voice))
        print("Model, voice and tokenizer prepared; next evaluation must run offline.")
        return

    fixtures = [
        "The quick brown fox jumps over the lazy dog.",
        "Don't skip the numbers: twelve books cost $24.50 in 2026.",
        "Repeated words, repeated words. Then a pause, and another sentence.",
        "This paragraph tests longer generation. " * 12,
    ]
    output = ROOT / "out"
    output.mkdir(exist_ok=True)
    reports = []
    for index, text in enumerate(fixtures):
        started = time.monotonic()
        samples = []
        tokens = []
        offset = 0.0
        for result in pipeline(text, voice=voice, speed=1):
            audio = result.audio.numpy()
            duration = len(audio) / 24000
            for token in result.tokens or []:
                if token.start_ts is None or token.end_ts is None:
                    # Punctuation may have no phonemes; do not invent timestamps.
                    assert not token.phonemes, f"Untimed spoken token: {token.text}"
                    continue
                start, end = float(token.start_ts), float(token.end_ts)
                assert 0 <= start <= end <= duration + 0.1, (token.text, start, end, duration)
                tokens.append({"text": token.text, "start": offset + start, "end": offset + end})
            samples.append(audio)
            offset += duration
        assert tokens and samples
        assert all(a["start"] <= b["start"] for a, b in zip(tokens, tokens[1:]))
        elapsed = time.monotonic() - started
        audio = np.concatenate(samples)
        with wave.open(str(output / f"sample-{index}.wav"), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(24000)
            wav.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
        report = {"text": text, "tokens": tokens, "audio_seconds": offset,
                  "generation_seconds": elapsed, "real_time_factor": elapsed / offset}
        (output / f"sample-{index}.json").write_text(json.dumps(report, indent=2))
        reports.append(report)
    (output / "summary.json").write_text(json.dumps({
        "model_revision": MODEL_REVISION, "model_sha256": MODEL_HASH,
        "voice": "af_heart", "device": "cpu", "threads": 2, "samples": reports,
        "limitation": "Structural timestamp checks only; human audio/timing quality review still required.",
    }, indent=2))
    print(json.dumps([{k: r[k] for k in ["audio_seconds", "generation_seconds", "real_time_factor"]} for r in reports]))


if __name__ == "__main__":
    main()
