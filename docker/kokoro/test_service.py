import base64
from types import SimpleNamespace
import unittest
import numpy as np
from service import synthesize


class SynthesisTests(unittest.TestCase):
    def test_original_offsets_survive_unicode_and_repeated_words(self):
        def pipeline(text, **_kwargs):
            yield SimpleNamespace(
                audio=SimpleNamespace(numpy=lambda: np.zeros(24000, dtype=np.float32)),
                tokens=[
                    SimpleNamespace(text="Hi", start_ts=0.0, end_ts=0.2, phonemes="hi"),
                    SimpleNamespace(text="😀", start_ts=None, end_ts=None, phonemes=None),
                    SimpleNamespace(text="Hi", start_ts=0.6, end_ts=0.9, phonemes="hi"),
                ],
            )
        result = synthesize(pipeline, "unused", "Hi 😀 Hi")
        self.assertEqual([(w["from"], w["to"]) for w in result["words"]], [(0, 2), (6, 8)])
        self.assertEqual(base64.b64decode(result["audio"])[:4], b"RIFF")

    def test_does_not_invent_timestamps_for_unaligned_spoken_text(self):
        def pipeline(text, **_kwargs):
            yield SimpleNamespace(
                audio=SimpleNamespace(numpy=lambda: np.zeros(24000, dtype=np.float32)),
                tokens=[SimpleNamespace(text="Hello", start_ts=None, end_ts=None, phonemes="hello")],
            )
        with self.assertRaises(ValueError):
            synthesize(pipeline, "unused", "Hello")


if __name__ == "__main__":
    unittest.main()
