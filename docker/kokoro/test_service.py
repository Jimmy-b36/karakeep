import base64
import unittest
from types import SimpleNamespace

import numpy as np

from service import VOICES, synthesize, voice_id


class SynthesisTests(unittest.TestCase):
    def test_voice_allowlist_covers_accents_and_genders(self):
        self.assertEqual(len(VOICES), 8)
        self.assertEqual({v[:2] for v in VOICES}, {"af", "am", "bf", "bm"})
        for name in VOICES:
            self.assertEqual(voice_id(f"kokoro:{name}"), name)
        for invalid in (None, [], "af_heart", "kokoro:../../etc/passwd", "kokoro:missing"):
            with self.assertRaises(ValueError):
                voice_id(invalid)

    def test_onnx_adapter_uses_model_durations(self):
        from inference import generate

        token = SimpleNamespace(text="Hi", phonemes="hi", whitespace="", start_ts=None, end_ts=None)

        def g2p(_text):
            yield SimpleNamespace(phonemes="hi", tokens=[token])

        class Session:
            def run(self, _outputs, inputs):
                np.testing.assert_array_equal(inputs["input_ids"], [[0, 1, 2, 0]])
                assert inputs["style"].shape == (1, 256)
                return np.zeros(8400, dtype=np.float32), np.array([3, 4, 4, 3], dtype=np.int64)

        parts = list(generate(g2p, Session(), {"h": 1, "i": 2}, {"voice": np.zeros((510, 1, 256))}, "Hi", "voice", 1))
        self.assertEqual(len(parts), 1)
        self.assertEqual((token.start_ts, token.end_ts), (0, 0.2))
        self.assertEqual(len(parts[0].audio.numpy()), 8400)

    def test_punctuation_and_unknown_phonemes_do_not_consume_extra_frames(self):
        from inference import join_model_timestamps

        tokens = [
            SimpleNamespace(text="(", phonemes="", whitespace=" ", start_ts=None, end_ts=None),
            SimpleNamespace(text="Hi", phonemes="hxi", whitespace=" ", start_ts=None, end_ts=None),
            SimpleNamespace(text="—", phonemes="", whitespace=" ", start_ts=None, end_ts=None),
            SimpleNamespace(text="Hi", phonemes="hi", whitespace="", start_ts=None, end_ts=None),
        ]
        join_model_timestamps(tokens, "hxi  hi", np.array([3, 4, 4, 1, 1, 4, 4, 3]), {"h": 1, "i": 2, " ": 3})
        self.assertEqual((tokens[1].start_ts, tokens[1].end_ts), (0, 0.2))
        self.assertEqual((tokens[3].start_ts, tokens[3].end_ts), (0.25, 0.45))

        def pipeline(_text, **_kwargs):
            yield SimpleNamespace(audio=SimpleNamespace(numpy=lambda: np.zeros(24000, dtype=np.float32)), tokens=tokens)

        result = synthesize(pipeline, "unused", "( Hi — Hi")
        self.assertEqual([(w["from"], w["to"]) for w in result["words"]], [(2, 4), (7, 9)])

    def test_rejects_model_duration_mismatches(self):
        from inference import join_model_timestamps

        for durations in (np.array([3, 4, 3]), np.array([3, -1, 4, 3])):
            token = SimpleNamespace(phonemes="hi", whitespace="", start_ts=None, end_ts=None)
            with self.assertRaises(ValueError):
                join_model_timestamps([token], "hi", durations, {"h": 1, "i": 2})

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
