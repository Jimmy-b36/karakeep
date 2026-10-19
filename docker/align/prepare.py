"""Build-time preparation for the alignment-only worker (see VENDOR.md).

1. Neutralize whisperx/__init__.py so `import whisperx.alignment` no longer pulls the
   transcription/diarization entrypoints whose dependencies are absent by design.
2. Make alignment.py's `transformers` import lazy (only the non-torchaudio HuggingFace
   path needs it; this worker uses the torchaudio model).
3. Pre-download the pinned torchaudio wav2vec2 alignment model so the running worker
   needs no network.
"""
import importlib.util
import pathlib

spec = importlib.util.find_spec("whisperx")
assert spec is not None, "whisperx is not installed"
root = pathlib.Path(spec.submodule_search_locations[0])

(root / "__init__.py").write_text("# neutralized: alignment-only worker (see VENDOR.md)\n")

align_path = root / "alignment.py"
align_src = align_path.read_text()
align_src = align_src.replace(
    "from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor\n",
    "# transformers import moved into the HuggingFace branch (alignment-only worker)\n",
    1,
)
align_src = align_src.replace(
    "    else:\n        try:\n            processor = Wav2Vec2Processor.from_pretrained(model_name)",
    "    else:\n        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor\n        try:\n            processor = Wav2Vec2Processor.from_pretrained(model_name)",
    1,
)
assert align_src.count("from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor") == 1, (
    "alignment.py patch did not apply cleanly"
)
align_path.write_text(align_src)

import torchaudio  # noqa: E402

bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
bundle.get_model(dl_kwargs={"model_dir": "/opt/align-model"})
print("whisperx alignment module prepared and model cached")
