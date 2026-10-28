"""Contract tests with a real HTTP server, not mocked HTTP client calls."""
import importlib.util
import json
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import unittest

spec = importlib.util.spec_from_file_location("deploy", Path(__file__).with_name("deploy_read_aloud.py"))
deploy = importlib.util.module_from_spec(spec)
if spec.loader and Path(spec.origin).exists():
    spec.loader.exec_module(deploy)

SHA = "a" * 40
OLD = "sha-" + "b" * 40
IMAGE = "ghcr.io/jimmy-b36/karakeep-read-aloud@sha256:" + "c" * 64

class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.image = "local/previous:working"
        self.version = OLD
        self.head = SHA
        self.fail_new = False
        self.writes = []
        self.compose = 'services:\n  web:\n    image: local/previous:working\n    pull_policy: always\n'
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                if self.path.startswith('/repos/'):
                    result = {'sha': owner.head}
                elif self.path.endswith('/api/version'):
                    result = {'version': owner.version}
                elif self.path.endswith('/api/health'):
                    result = {'status': 'ok'}
                elif self.path.endswith('/services/' + deploy.SERVICE):
                    result = {'docker_compose_raw': owner.compose}
                else:
                    result = {'image': owner.image}
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())
            def do_PATCH(self):
                payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.writes.append(('PATCH', self.path, payload))
                owner.image = payload['image']
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{}')
            def do_POST(self):
                owner.writes.append(('POST', self.path))
                if owner.image != IMAGE:
                    owner.version = OLD
                elif not owner.fail_new:
                    owner.version = 'sha-' + SHA
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"message":"Deploy request queued"}')
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)
    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
    def client(self):
        self.assertTrue(hasattr(deploy, 'Deployer'), 'Deployment implementation is missing')
        return deploy.Deployer('coolify-secret', 'github-secret', api=self.url,
                               public=self.url, github=self.url, timeout=0.05, interval=0.01)
    def test_success_requires_configured_image_and_exact_running_sha(self):
        self.assertTrue(self.client().deploy(SHA, IMAGE))
        self.assertEqual(self.image, IMAGE)
        self.assertEqual(self.version, 'sha-' + SHA)
        self.assertEqual(self.writes[0][2], {'image': IMAGE})
        self.assertTrue(self.writes[1][1].endswith('/start?latest=true&force=true'))

    def test_never_pull_policy_fails_before_mutation(self):
        self.compose = self.compose.replace('always', 'never')
        with self.assertRaisesRegex(deploy.DeploymentError, 'pull_policy'):
            self.client().deploy(SHA, IMAGE)
        self.assertEqual(self.writes, [])

    def test_stale_healthy_old_version_is_failure_and_rolls_back(self):
        self.fail_new = True
        with self.assertRaisesRegex(deploy.DeploymentError, 'recovered and healthy'):
            self.client().deploy(SHA, IMAGE)
        self.assertEqual(self.image, 'local/previous:working')
        self.assertEqual(self.version, OLD)
        self.assertEqual([item[0] for item in self.writes], ['PATCH', 'POST', 'PATCH', 'POST'])
        self.assertTrue(self.writes[3][1].endswith('/start?latest=false&force=true'))

    def test_failed_rollback_is_reported_not_claimed_recovered(self):
        self.fail_new = True
        client = self.client()
        # Previous configured image and public version intentionally disagree:
        # recovery must verify the captured version, not just health/config.
        self.version = 'sha-' + 'e' * 40
        with self.assertRaisesRegex(deploy.DeploymentError, 'recovery NOT verified'):
            client.deploy(SHA, IMAGE)

    def test_stale_main_run_does_not_mutate(self):
        self.head = 'd' * 40
        self.assertFalse(self.client().deploy(SHA, IMAGE))
        self.assertEqual(self.writes, [])

if __name__ == '__main__':
    unittest.main()
