"""Offline ONNX inference, retaining Kokoro's own phonemizer and word durations."""
import hashlib
import json
import os
from functools import partial
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import onnxruntime as ort  # pyright: ignore[reportMissingImports]
import requests
import torch  # pyright: ignore[reportMissingImports]
from huggingface_hub import hf_hub_download  # pyright: ignore[reportMissingImports]
from kokoro import KPipeline  # pyright: ignore[reportAttributeAccessIssue, reportMissingImports]

MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx"
MODEL_HASH = "beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a"


def join_model_timestamps(tokens, phonemes, duration, vocab):
    # Match the actual model input: omitted phonemes and punctuation cannot consume frames.
    known = np.concatenate(([0], np.cumsum([p in vocab for p in phonemes])))
    frames = np.asarray(duration).reshape(-1)
    if len(frames) != known[-1] + 2 or not np.all(np.isfinite(frames)) or np.any(frames < 0):
        raise ValueError("Invalid model durations")
    raw = "".join((t.phonemes or "") + (" " if t.whitespace else "") for t in tokens)
    if not raw.strip().startswith(phonemes):
        raise ValueError("Token phonemes differ from the model input")
    padding = len(raw) - len(raw.lstrip())
    # Preserve Kokoro's three-frame boundary calibration; each frame is 600/24000 s.
    edges = (np.concatenate(([0], np.cumsum(frames[1:-1]))) + max(0, frames[0] - 3)) / 40
    position = 0
    for token in tokens:
        length = len(token.phonemes or "")
        start = max(0, min(len(phonemes), position - padding))
        finish = max(0, min(len(phonemes), position + length - padding))
        left, right = int(known[start]), int(known[finish])
        token.start_ts = token.end_ts = None
        if right > left:
            token.start_ts, token.end_ts = float(edges[left]), float(edges[right])
        else:
            token.phonemes = ""
        position += length + bool(token.whitespace)


def generate(g2p, session, vocab, voices, text, voice, speed):
    for result in g2p(text):
        phonemes = result.phonemes
        ids = [vocab[p] for p in phonemes if p in vocab]
        waveform, duration = session.run(None, {
            "input_ids": np.array([[0, *ids, 0]], dtype=np.int64),
            "style": voices[voice][len(phonemes) - 1],
            "speed": np.array([speed], dtype=np.float32),
        })
        # Use the graph's actual durations, never proportional word estimates.
        join_model_timestamps(result.tokens or [], phonemes, duration, vocab)
        yield SimpleNamespace(audio=torch.from_numpy(np.asarray(waveform).reshape(-1)), tokens=result.tokens)


def load_pipelines(voice_names, revision, prepare=False):
    def artifact(filename):
        return hf_hub_download("hexgrad/Kokoro-82M", filename, revision=revision, local_files_only=not prepare)

    model_path = Path(os.environ["HF_HOME"]) / "kokoro.onnx"
    if prepare:
        temporary = model_path.with_suffix(".part")
        with requests.get(MODEL_URL, stream=True, timeout=(15, 120)) as response:
            response.raise_for_status()
            with temporary.open("wb") as output:
                for chunk in response.iter_content(1024 * 1024):
                    output.write(chunk)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != MODEL_HASH:
            raise RuntimeError("ONNX model checksum mismatch")
        temporary.replace(model_path)
    if hashlib.sha256(model_path.read_bytes()).hexdigest() != MODEL_HASH:
        raise RuntimeError("ONNX model checksum mismatch")
    try:
        vocab = json.loads(Path(artifact("config.json")).read_text())["vocab"]
    except (OSError, ValueError, KeyError) as error:
        raise RuntimeError("Pinned phonemizer configuration is invalid") from error
    voice_files = {name: artifact(f"voices/{name}.pt") for name in voice_names}
    # Immutable pinned voice artifacts; weights_only forbids arbitrary pickle execution.
    voices = {path: torch.load(path, weights_only=True, map_location="cpu").numpy() for path in voice_files.values()}  # nosemgrep: trailofbits.python.pickles-in-pytorch.pickles-in-pytorch
    options = ort.SessionOptions()
    options.intra_op_num_threads = 3
    options.inter_op_num_threads = 1
    # Returning scratch buffers to the OS matters on an 8 GiB shared host.
    options.enable_cpu_mem_arena = False
    session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])
    if [output.name for output in session.get_outputs()] != ["waveform", "duration"]:
        raise RuntimeError("ONNX graph must expose native durations")
    metadata = session.get_modelmeta().custom_metadata_map
    try:
        model_vocab = json.loads(metadata["kokoro_config"])["vocab"]
    except (ValueError, KeyError) as error:
        raise RuntimeError("ONNX model configuration is invalid") from error
    if model_vocab != vocab:
        raise RuntimeError("Model and phonemizer vocabularies differ")
    pipelines = {
        lang: partial(generate, KPipeline(lang_code=lang, model=False, repo_id="hexgrad/Kokoro-82M"), session, vocab, voices)
        for lang in ("a", "b")
    }
    return pipelines, voice_files
