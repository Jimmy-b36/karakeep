# Standalone read-aloud worklet

`signalsmith-stretch-1.3.2.js` is copied unchanged from the installed, pnpm-patched
`signalsmith-stretch/SignalsmithStretch.js` distribution. Its embedded WASM needs
no network dependency. Keep it outside Next/Turbopack: Emscripten's serialized
factory cannot reference imports introduced by a bundler (notably `process`).
The adapter sets the library's supported `moduleUrl` to this same-origin asset.

After a dependency or patch update, regenerate from the repository root:

```sh
cp node_modules/signalsmith-stretch/SignalsmithStretch.js apps/web/public/audio/signalsmith-stretch-1.3.2.js
pnpm build --filter=@karakeep/web
node scripts/verify-read-aloud-audio.cjs --production
```

Update the versioned filename and adapter URL when upgrading. The verification
script checks exact parity with the installed patched dependency, then executes
the emitted production adapter and standalone worklet in Chrome. No test route
is added to the application.

## Upstream license

Source: https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/main/LICENSE.txt

MIT License

Copyright (c) 2022 Geraint Luff / Signalsmith Audio Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
