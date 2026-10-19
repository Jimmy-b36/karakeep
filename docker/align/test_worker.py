"""Standard-library HTTP tests. No ML packages, model downloads or Siri execution."""
import base64
import http.client
import socket
import json
import threading
import unittest
from unittest.mock import patch

from worker import AlignmentServer, Handler

TOKEN = "test-align-token-0123456789-abcdefghijklmnopqrstuvwxyz"


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.server = AlignmentServer(("127.0.0.1", 0), Handler, TOKEN)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def post(self, token=None, body=b'{"text":"Hello","wav":"AA=="}'):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        headers = {"Content-Type": "application/json"}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        conn.request("POST", "/align", body, headers)
        response = conn.getresponse()
        result = response.status, response.read()
        conn.close()
        return result

    def test_auth_before_decoding(self):
        with patch("worker.decode_wav") as decode:
            self.assertEqual(self.post()[0], 401)
            self.assertEqual(self.post("wrong")[0], 401)
            decode.assert_not_called()

    def test_authenticated_request_and_busy_rejection(self):
        entered, release = threading.Event(), threading.Event()
        def align(*args):
            entered.set()
            release.wait(2)
            return {"duration": 1, "words": [{"word": "Hello", "start": 0, "end": 1}]}
        with patch("worker.decode_wav") as decode, patch("worker.ensure_model"), patch("worker.align_text", side_effect=align):
            decode.return_value.numel.return_value = 16000
            results = []
            client = threading.Thread(target=lambda: results.append(self.post(TOKEN)))
            client.start()
            try:
                self.assertTrue(entered.wait(2))
                self.assertEqual(self.post(TOKEN)[0], 503)
                self.assertEqual(decode.call_count, 1)
            finally:
                release.set()
                client.join()
            self.assertEqual(results[0][0], 200)
            self.assertEqual(json.loads(results[0][1])["words"][0]["word"], "Hello")

    def test_invalid_payload_and_base64(self):
        with patch("worker.decode_wav") as decode:
            self.assertEqual(self.post(TOKEN, b'[]')[0], 400)
            self.assertEqual(self.post(TOKEN, b'{"text":"Hello","wav":"!!!!"}')[0], 400)
            decode.assert_not_called()

    def test_oversized_wav_rejected_before_decoding(self):
        body = json.dumps({"text": "Hello", "wav": base64.b64encode(b'x' * (8 * 1024 * 1024 + 1)).decode()}).encode()
        with patch("worker.decode_wav") as decode:
            self.assertEqual(self.post(TOKEN, body)[0], 413)
            decode.assert_not_called()

    def test_incomplete_headers_expire_and_release_admission(self):
        with patch("worker.REQUEST_DEADLINE", 0.05):
            with socket.create_connection(("127.0.0.1", self.server.server_port), timeout=2) as conn:
                conn.sendall(b"POST /align HTTP/1.1\r\nHost: localhost\r\n")
                self.assertEqual(conn.recv(4096), b'')
            self.assertTrue(self.server.slot.acquire(timeout=2))
            self.server.slot.release()

    def test_requires_strong_token(self):
        with self.assertRaises(ValueError):
            AlignmentServer(("127.0.0.1", 0), Handler, "")


if __name__ == "__main__":
    unittest.main()
