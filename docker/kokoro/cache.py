"""Private content-addressed, bounded disk cache for already-generated speech."""
import gzip
import hashlib
import json
import os
import tempfile
from pathlib import Path


class SpeechCache:
    def __init__(self, directory, namespace, max_bytes=2 * 1024**3):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        # This single-writer service owns the directory; recover interrupted atomic writes.
        for orphan in self.directory.glob(".speech-*"):
            orphan.unlink(missing_ok=True)
        self.namespace = namespace
        self.max_bytes = max_bytes

    def path(self, text, voice):
        key = json.dumps([self.namespace, voice, text], ensure_ascii=True, separators=(",", ":"))
        return self.directory / (hashlib.sha256(key.encode()).hexdigest() + ".json.gz")

    def get(self, text, voice):
        path = self.path(text, voice)
        try:
            with gzip.open(path, "rt", encoding="utf-8") as source:
                result = json.load(source)
            os.utime(path, None)
            return result
        except (OSError, ValueError, EOFError):
            return None

    def put(self, text, voice, result):
        data = gzip.compress(json.dumps(result, separators=(",", ":")).encode(), compresslevel=1)
        if len(data) > self.max_bytes:
            return
        entries = []
        for path in self.directory.glob("*.json.gz"):
            try:
                stat = path.stat()
                entries.append((stat.st_mtime_ns, path, stat.st_size))
            except FileNotFoundError:
                continue
        used = sum(size for _, _, size in entries)
        for _, path, size in sorted(entries):
            if used + len(data) <= self.max_bytes:
                break
            path.unlink(missing_ok=True)
            used -= size
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.directory, prefix=".speech-", delete=False) as output:
                temporary = Path(output.name)
                output.write(data)
            temporary.replace(self.path(text, voice))
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
