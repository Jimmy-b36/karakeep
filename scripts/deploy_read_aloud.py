#!/usr/bin/env python3
"""Deploy only Karakeep's web service application; never restart the service.

API contract: https://coolify.io/docs/api/endpoints/service-applications/
post-start-service-application-by-service-and-app-uuid
PATCH accepts image; POST start takes latest/force as query parameters.
A queued response is NOT evidence of deployment. Public version is authoritative.
"""
import json
import os
import re
import sys
import time

import yaml
from urllib.request import Request, urlopen

SERVICE = 'dtu9seioeg1ietwmhekucyb0'
APP = 'itdetwydfwbwbjahlvxd8mc7'
REPOSITORY = 'Jimmy-b36/karakeep'


class DeploymentError(Exception):
    """Sanitized operational error (never includes response bodies/headers)."""


class Deployer:
    def __init__(self, token, github_token, *, api='https://coolify.jaffs.org/api/v1',
                 public='https://karakeep.jaffs.org', github='https://api.github.com',
                 timeout=600, interval=10):
        self.api, self.public, self.github = api, public, github
        self.token, self.github_token = token, github_token
        self.timeout, self.interval = timeout, interval
        self.path = f'/services/{SERVICE}/applications/{APP}'

    def request(self, base, path, method='GET', payload=None, token=None):
        headers = {'Accept': 'application/json', 'Cache-Control': 'no-cache',
                   'User-Agent': 'karakeep-deploy'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        data = None
        if payload is not None:
            data = json.dumps(payload).encode()
            headers['Content-Type'] = 'application/json'
        try:
            with urlopen(Request(base + path, data=data, headers=headers, method=method), timeout=20) as response:
                body = response.read()
                return json.loads(body) if body else {}
        except Exception:
            raise DeploymentError('HTTP request failed (details suppressed)') from None

    def coolify(self, path, method='GET', payload=None):
        return self.request(self.api, path, method, payload, self.token)

    def fresh(self, sha):
        return self.request(self.github, f'/repos/{REPOSITORY}/commits/main',
                            token=self.github_token).get('sha') == sha

    def version(self):
        return self.request(self.public, '/api/version').get('version')

    def verify(self, image, version):
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                configured = self.coolify(self.path).get('image')
                running = self.version()
                self.request(self.public, '/api/health')
                if configured == image and running == version:
                    return
            except DeploymentError:
                pass
            if time.monotonic() >= deadline:
                raise DeploymentError('Timed out verifying configured image, exact public version and health')
            time.sleep(self.interval)

    def start(self, image, *, latest=True):
        self.coolify(self.path, 'PATCH', {'image': image})
        if self.coolify(self.path).get('image') != image:
            raise DeploymentError('Configured image read-back mismatch')
        self.coolify(self.path + f'/start?latest={str(latest).lower()}&force=true', 'POST')

    def deploy(self, sha, image):
        if not self.fresh(sha):
            print('Skipping stale run: main has advanced.')
            return False
        try:
            service = self.coolify(f'/services/{SERVICE}')
            compose = yaml.safe_load(service['docker_compose_raw'])
            web = compose['services']['web']
            if web.get('pull_policy') == 'never':
                raise DeploymentError('web pull_policy is never; set it to always in Coolify before deploying')
        except DeploymentError:
            raise
        except Exception:
            raise DeploymentError('Cannot verify web Compose pull_policy; refusing deployment') from None
        previous = self.coolify(self.path).get('image')
        previous_version = self.version()
        self.request(self.public, '/api/health')
        if not previous or not previous_version or previous_version == 'unknown':
            raise DeploymentError('Cannot establish a healthy rollback baseline')
        # Check again immediately before the first mutation (GitHub concurrency
        # alone does not guarantee FIFO ordering of pending runs).
        if not self.fresh(sha):
            print('Skipping stale run: main has advanced.')
            return False
        try:
            self.start(image)
            self.verify(image, 'sha-' + sha)
        except Exception:
            try:
                self.start(previous, latest=False)
                self.verify(previous, previous_version)
            except Exception:
                raise DeploymentError('Deployment failed; rollback recovery NOT verified; manual intervention required') from None
            raise DeploymentError('Deployment failed; previous image and public version recovered and healthy') from None
        print('Verified deployed image, exact commit version and public health.')
        return True


def main():
    sha = os.environ.get('GITHUB_SHA', '')
    image = os.environ.get('DEPLOY_IMAGE', '')
    if not re.fullmatch(r'[0-9a-f]{40}', sha) or not re.fullmatch(
            r'ghcr\.io/jimmy-b36/karakeep-read-aloud@sha256:[0-9a-f]{64}', image):
        raise DeploymentError('Invalid commit SHA or immutable image digest')
    token = os.environ.get('COOLIFY_TOKEN')
    github_token = os.environ.get('GH_TOKEN')
    if not token or not github_token:
        raise DeploymentError('Required deployment credentials are missing')
    Deployer(token, github_token).deploy(sha, image)


if __name__ == '__main__':
    try:
        main()
    except DeploymentError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
