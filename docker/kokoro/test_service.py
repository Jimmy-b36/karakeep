import base64
import io
import json
import unittest
import wave
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np

from service import MAX_TEXT_LENGTH, VOICES, main, synthesize, trim_speech, voice_id


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

        def g2p(_text, *, split_pattern):
            self.assertIsNone(split_pattern)
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

    def test_wrapped_lines_are_one_model_utterance_without_losing_original_offsets(self):
        from inference import generate, literal_pipeline

        pipeline = literal_pipeline("b")
        text = "Yes.\nExactly. This is one thought."
        expected = list(pipeline(text, split_pattern=None))
        self.assertEqual(len(expected), 1)
        vocab = {p: i for i, p in enumerate(set(expected[0].phonemes))}
        calls = []
        class Session:
            def run(self, _outputs, inputs):
                calls.append(inputs)
                frames = np.full(inputs["input_ids"].size, 4, dtype=np.int64)
                return np.zeros(int(frames.sum()) * 600, dtype=np.float32), frames
        def voice(_text, **_kwargs):
            return generate(pipeline, Session(), vocab, {"voice": np.zeros((510, 1, 256))}, text, "voice", 1)
        result = synthesize(voice, "unused", text)
        self.assertEqual(len(calls), 1)
        self.assertIn("Exactly", [text[w["from"]:w["to"]].strip() for w in result["words"]])
        self.assertTrue(all(0 <= w["start"] <= w["end"] <= result["duration"] for w in result["words"]))

    def test_oversized_or_truncated_phonemes_fail_before_model_inference(self):
        from inference import generate
        for phonemes, original in (("h" * 511, "h" * 511), ("h" * 510, "h" * 511)):
            def pipeline(_text, phonemes=phonemes, original=original, **_kwargs):
                yield SimpleNamespace(phonemes=phonemes, tokens=[SimpleNamespace(phonemes=original, whitespace="")])
            session = Mock()
            with self.assertRaisesRegex(ValueError, "phoneme limit"):
                list(generate(pipeline, session, {"h": 1}, {}, "text", "voice", 1))
            session.run.assert_not_called()

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

    def test_plain_text_is_not_interpreted_as_markdown_pronunciation(self):
        from inference import literal_pipeline

        for lang in ("a", "b"):
            pipeline = literal_pipeline(lang)
            for text in ("A [link](target).", "[textBox.addEventListener(input](handler)",
                         "[url(https://fonts.googleapis.com/css2?family=Montserrat](#x)"):
                tokens = [token for result in pipeline(text) for token in result.tokens or []]
                self.assertEqual("".join(token.text + token.whitespace for token in tokens).strip(), text)

    def test_apostrophes_dropped_inside_merged_tokens_keep_original_offsets(self):
        text = "😀 textBox.addEventListener('input', handler)"
        def pipeline(_text, **_kwargs):
            yield SimpleNamespace(audio=SimpleNamespace(numpy=lambda: np.zeros(24000, dtype=np.float32)), tokens=[
                SimpleNamespace(text="😀", start_ts=None, end_ts=None, phonemes=None),
                SimpleNamespace(text="textBox.addEventListener(input", start_ts=0, end_ts=0.5, phonemes="speech"),
                SimpleNamespace(text="'", start_ts=0.5, end_ts=0.6, phonemes="”"),
                SimpleNamespace(text="handler", start_ts=0.6, end_ts=0.9, phonemes="speech"),
            ])
        result = synthesize(pipeline, "unused", text)
        encoded = text.encode("utf-16-le")
        spans = [encoded[w["from"] * 2:w["to"] * 2].decode("utf-16-le") for w in result["words"]]
        self.assertEqual(spans, ["textBox.addEventListener('input", "handler"])

    def test_rejects_token_changes_other_than_apostrophes(self):
        def pipeline(_text, **_kwargs):
            yield SimpleNamespace(audio=SimpleNamespace(numpy=lambda: np.zeros(24000, dtype=np.float32)), tokens=[
                SimpleNamespace(text="Different", start_ts=0, end_ts=0.5, phonemes="speech"),
            ])
        with self.assertRaisesRegex(ValueError, "cannot be mapped"):
            synthesize(pipeline, "unused", "Original")

    def test_edge_padding_is_trimmed_with_matching_word_times_without_mutating_cache(self):
        rate = 24000
        audio = np.zeros(rate * 2, dtype=np.int16)
        audio[7200:24000] = 1000
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(rate)
            wav.writeframes(audio.tobytes())
        original = {"audio": base64.b64encode(output.getvalue()).decode("ascii"),
                    "words": [{"from": 0, "to": 2, "start": 0.2, "end": 1.0},
                              {"from": 3, "to": 5, "start": 1.0, "end": 1.5}], "duration": 2.0}
        for text, expected in (("Hi hi", 0.85), ("Hi hi.”", 1.0)):
            result = trim_speech(original, text)
            self.assertAlmostEqual(result["duration"], expected)
            self.assertEqual(result["words"][0], {"from": 0, "to": 2, "start": 0, "end": 0.75})
            self.assertEqual(result["words"][1]["end"], expected)
            with wave.open(io.BytesIO(base64.b64decode(result["audio"]))) as wav:
                samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
                self.assertEqual(wav.getnframes(), round(expected * rate))
                np.testing.assert_array_equal(samples[1200:18000], audio[7200:24000])
            self.assertEqual(trim_speech(result, text), result)
        self.assertEqual(original["duration"], 2)
        self.assertEqual(original["words"][0]["start"], 0.2)

    def test_trimming_preserves_even_the_quietest_quantized_phonemes(self):
        audio = np.zeros(48000, dtype=np.float32)
        audio[7200:24000] = 0.1
        audio[24000:36000] = 1 / 32767
        def pipeline(_text, **_kwargs):
            yield SimpleNamespace(audio=SimpleNamespace(numpy=lambda: audio), tokens=[
                SimpleNamespace(text="Hi", start_ts=0.2, end_ts=1.5, phonemes="hi"),
            ])
        raw = synthesize(pipeline, "unused", "Hi")
        result = trim_speech(raw, "Hi")
        with wave.open(io.BytesIO(base64.b64decode(result["audio"]))) as wav:
            samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
            np.testing.assert_array_equal(samples[18000:30000], np.ones(12000, dtype=np.int16))
        self.assertAlmostEqual(result["words"][0]["end"], 1.25)

    def test_cached_and_new_responses_trim_edges_and_literal_text_uses_new_cache_key(self):
        def pipeline(_text, **_kwargs):
            audio = np.zeros(48000, dtype=np.float32)
            audio[7200:24000] = 0.1
            yield SimpleNamespace(audio=SimpleNamespace(numpy=lambda: audio), tokens=[
                SimpleNamespace(text="Hi", start_ts=0.2, end_ts=1.0, phonemes="hi"),
            ])
        raw = synthesize(pipeline, "unused", "Hi")
        with patch("inference.load_pipelines", return_value=({"b": object()}, {"bf_emma": "voice"})), \
             patch("cache.SpeechCache") as cache_class, \
             patch("service.ThreadingHTTPServer") as server, \
             patch.dict("os.environ", {"KOKORO_TOKEN": "x" * 32}), \
             patch("service.synthesize", return_value=raw) as generate:
            main()
            handler_class = server.call_args.args[1]
            cache = cache_class.return_value
            cache.get.return_value = raw

            def request(text, background=False):
                handler = handler_class.__new__(handler_class)
                body = json.dumps({"text": text, "voice": "kokoro:bf_emma"}).encode()
                handler.headers = {"Authorization": "Bearer " + "x" * 32,
                                   "Content-Type": "application/json", "Content-Length": str(len(body))}
                if background:
                    handler.headers["X-Speech-Priority"] = "background"
                handler.path = "/synthesize"
                handler.rfile = io.BytesIO(body)
                replies = []
                handler.reply = lambda status, value, **kwargs: replies.append((status, value, kwargs))
                handler.do_POST()
                return replies[0]

            status, value, headers = request("Hi")
            self.assertEqual((status, headers["cache_hit"]), (200, True))
            self.assertLess(value["duration"], raw["duration"])
            self.assertEqual(cache.get.call_args.args, ("Hi", "bf_emma"))
            self.assertEqual(request("Hi", background=True)[0], 200)
            generate.assert_not_called()
            self.assertEqual(request("a" * MAX_TEXT_LENGTH)[0], 200)
            self.assertEqual(request("😀" * MAX_TEXT_LENGTH)[0], 200)
            self.assertEqual(request("a" * (MAX_TEXT_LENGTH + 1))[0], 400)
            self.assertEqual(request("😀" * (MAX_TEXT_LENGTH + 1))[0], 400)
            request("Hi\nthere")
            self.assertEqual(cache.get.call_args.args, ("Hi\nthere", "bf_emma:unwrapped-v1"))

            cache.get.return_value = None
            self.assertEqual(request("Hi", background=True)[0], 503)
            status, value, headers = request("Hi [link](target)")
            self.assertEqual((status, headers["cache_hit"]), (200, False))
            self.assertEqual(cache.put.call_args.args, ("Hi [link](target)", "bf_emma:literal-v1", raw))
            self.assertLess(value["duration"], raw["duration"])
            self.assertEqual(raw["duration"], 2.0)
            cache.get.side_effect = [None, raw]
            status, value, headers = request("Hi")
            self.assertEqual((status, headers["cache_hit"]), (200, True))
            self.assertLess(value["duration"], raw["duration"])
            generate.assert_called_once()

    def test_silent_audio_is_not_trimmed_to_an_empty_wav(self):
        def pipeline(_text, **_kwargs):
            yield SimpleNamespace(
                audio=SimpleNamespace(numpy=lambda: np.zeros(24000, dtype=np.float32)),
                tokens=[SimpleNamespace(text="Hi", start_ts=0, end_ts=0.2, phonemes="hi")],
            )
        original = synthesize(pipeline, "unused", "Hi")
        self.assertIs(trim_speech(original, "Hi"), original)

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
