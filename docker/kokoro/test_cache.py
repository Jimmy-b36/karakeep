import os
import tempfile
import unittest
from pathlib import Path

from cache import SpeechCache


class CacheTests(unittest.TestCase):
    def test_recovers_orphaned_writes_after_a_crash(self):
        with tempfile.TemporaryDirectory() as directory:
            orphan = Path(directory) / ".speech-interrupted"
            orphan.write_bytes(b"x" * 500)
            cache = SpeechCache(directory, "model", max_bytes=120)
            self.assertFalse(orphan.exists())
            cache.put("text", "voice", {"audio": "valid"})
            self.assertEqual(cache.get("text", "voice"), {"audio": "valid"})

    def test_persists_and_separates_voice_content_and_model(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = SpeechCache(directory, "model-v1")
            result = {"audio": "wav", "words": [], "duration": 1}
            cache.put("Hello 😀", "bf_emma", result)
            self.assertEqual(SpeechCache(directory, "model-v1").get("Hello 😀", "bf_emma"), result)
            self.assertIsNone(cache.get("Changed", "bf_emma"))
            self.assertIsNone(cache.get("Hello 😀", "af_heart"))
            self.assertIsNone(SpeechCache(directory, "model-v2").get("Hello 😀", "bf_emma"))
            self.assertFalse(list(Path(directory).glob(".speech-*")))
            self.assertEqual(cache.path("Hello 😀", "bf_emma").stat().st_mode & 0o077, 0)

    def test_corrupt_file_is_a_cache_miss(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = SpeechCache(directory, "v1")
            cache.path("text", "voice").write_bytes(b"not gzip")
            self.assertIsNone(cache.get("text", "voice"))

    def test_evicts_oldest_chunks_within_disk_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = SpeechCache(directory, "v1", max_bytes=120)
            cache.put("old", "voice", {"audio": "first"})
            old = cache.path("old", "voice")
            os.utime(old, (1, 1))
            cache.put("new", "voice", {"audio": "second"})
            cache.put("third", "voice", {"audio": "third"})
            cache.put("fourth", "voice", {"audio": "fourth"})
            files = list(Path(directory).glob("*.json.gz"))
            self.assertLessEqual(sum(path.stat().st_size for path in files), 120)
            self.assertIsNone(cache.get("old", "voice"))
            self.assertEqual(cache.get("fourth", "voice"), {"audio": "fourth"})


if __name__ == "__main__":
    unittest.main()
