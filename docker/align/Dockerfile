# Isolated WhisperX forced-alignment worker (see VENDOR.md for the audit trail).
# The worker's Python lives in worker.py / fixture.py / prepare.py and is COPY'd in,
# so the host never needs a Python ML toolchain.
FROM python:3.11-slim

WORKDIR /opt/align

# OpenMP runtime required by the CPU torch/torchaudio wheels on this base image.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

# 1. Pinned runtime dependencies (linux/arm64 CPU-only wheels from PyPI).
COPY docker/align/requirements.txt /opt/align/requirements.txt
RUN pip install --no-cache-dir -r /opt/align/requirements.txt

# 2. WhisperX alignment module only. --no-deps skips transcription (faster-whisper)
#    and diarization (pyannote.audio), which this worker never uses.
RUN pip install --no-cache-dir --no-deps whisperx==3.1.1

# 3. Two documented deviations from the pinned wheel (see VENDOR.md) plus a pre-download
#    of the pinned torchaudio wav2vec2 alignment model (no runtime network).
COPY docker/align/prepare.py /opt/align/prepare.py
RUN python /opt/align/prepare.py

# 4. The worker, its standard-library HTTP tests, and the latency fixture.
COPY docker/align/worker.py docker/align/fixture.py docker/align/test_worker.py /opt/align/
RUN cd /opt/align && python test_worker.py && rm test_worker.py

ENV TORCH_HOME=/opt/torch-home MODEL_DIR=/opt/align-model PORT=4319 HOME=/tmp PYTHONUNBUFFERED=1
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin align
USER 10001:10001
EXPOSE 4319
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4319/health', timeout=4)"
CMD ["python", "worker.py"]
