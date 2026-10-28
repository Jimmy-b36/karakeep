FROM python:3.12.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends espeak-ng libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
COPY docker/kokoro/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -r /tmp/requirements.txt
RUN mkdir -p /opt/hf /cache && chown 10001:10001 /opt/hf /cache && chmod 700 /cache
ENV HF_HOME=/opt/hf HOME=/tmp PYTHONUNBUFFERED=1
USER 10001:10001
COPY docker/kokoro/service.py docker/kokoro/inference.py docker/kokoro/cache.py /opt/
RUN python /opt/service.py --prepare
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
COPY docker/kokoro/test_service.py docker/kokoro/test_cache.py /opt/
RUN python /opt/test_service.py && python /opt/test_cache.py
EXPOSE 4320
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4320/health', timeout=4)"
CMD ["python", "/opt/service.py"]
