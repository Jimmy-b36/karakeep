/* Run from repository root: node scripts/verify-read-aloud-audio.cjs
 * Always bundles CURRENT source (minified), using workspace esbuild/Playwright.
 * No server/login/worker or cached probe bundle; system Chrome fallback.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");
const { build } = require("esbuild");
(async () => {
  const dir = await fs.mkdtemp(
    path.join(process.env.TMPDIR || os.tmpdir(), "read-aloud-pcm-"),
  );
  let browser, server;
  const deadline = setTimeout(() => {
    console.error(
      "FAIL: audio verification exceeded 30 seconds (possible silent worklet startup hang)",
    );
    void browser?.close();
  }, 30000);
  try {
    assert.equal(
      await fs.readFile(
        path.resolve(
          __dirname,
          "../apps/web/public/audio/signalsmith-stretch-1.3.2.js",
        ),
        "utf8",
      ),
      await fs.readFile(require.resolve("signalsmith-stretch"), "utf8"),
      "Standalone worklet must match the installed, patched dependency; regenerate after upgrades",
    );
    if (process.argv.includes("--production")) {
      const chunks = path.resolve(__dirname, "../apps/web/.next/static/chunks");
      let artifact;
      for (const file of await fs.readdir(chunks)) {
        if (!file.endsWith(".js")) continue;
        const text = await fs.readFile(path.join(chunks, file), "utf8");
        if (
          text.includes("Cancelled audio session") &&
          text.includes("signalsmith-stretch")
        ) {
          artifact = { file, text };
          break;
        }
      }
      assert(artifact, "Build the actual Next production app first");
      // Execute the emitted adapter/dependency verbatim, not an esbuild proxy.
      const start = artifact.text.indexOf("let G={}");
      const match = /class (\w+)\{createContext;createNode;/.exec(
        artifact.text,
      );
      assert(
        start >= 0 && match,
        "Production adapter layout changed; update extractor",
      );
      const end = artifact.text.indexOf(
        "function ",
        artifact.text.indexOf("dispose(){", match.index),
      );
      await fs.writeFile(
        path.join(dir, "audio.js"),
        `${artifact.text.slice(start, end)};globalThis.Speech={ScheduledSpeechAudio:${match[1]}};`,
      );
      console.log("Actual Next/Turbopack artifact:", artifact.file);
    } else
      await build({
        entryPoints: [
          path.resolve(__dirname, "../apps/web/lib/read-aloud-audio.ts"),
        ],
        outfile: path.join(dir, "audio.js"),
        bundle: true,
        minify: true,
        format: "iife",
        globalName: "Speech",
      });
    server = http
      .createServer(async (req, res) => {
        if (req.url === "/audio/signalsmith-stretch-1.3.2.js") {
          res.setHeader("Content-Type", "text/javascript");
          res.end(
            await fs.readFile(
              path.resolve(
                __dirname,
                "../apps/web/public/audio/signalsmith-stretch-1.3.2.js",
              ),
            ),
          );
          return;
        }
        res.setHeader(
          "Content-Type",
          req.url === "/audio.js" ? "text/javascript" : "text/html",
        );
        res.end(
          req.url === "/audio.js"
            ? await fs.readFile(path.join(dir, "audio.js"))
            : '<script src="/audio.js"></script><button id="start">Start</button>',
        );
      })
      .listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      browser = await chromium.launch({ channel: "chrome", headless: true });
    }
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error("Browser exception:", e.message);
    });
    page.on("console", (m) => {
      if (m.type() === "error") console.error("Browser console:", m.text());
    });
    page.setDefaultTimeout(15000);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const results = await page.evaluate(async () => {
      function sine(ctx, sr, from, to) {
        const b = ctx.createBuffer(1, to - from, sr),
          a = b.getChannelData(0);
        for (let i = 0; i < a.length; i++)
          a[i] = 0.5 * Math.sin((2 * Math.PI * 440 * (from + i)) / sr);
        return b;
      }
      async function render(
        sr,
        rate,
        split,
        inputRate = sr,
        appendWhileRunning = false,
      ) {
        const ctx = new OfflineAudioContext(
          1,
          Math.ceil((2 / rate + 0.8) * sr),
          sr,
        );
        // Offline contexts lack play()/close(); do not proxy them, since native
        // AudioWorkletNode checks the BaseAudioContext receiver's brand.
        Object.defineProperties(ctx, {
          resume: { value: async () => undefined },
          state: { value: "running" },
          close: { value: async () => undefined },
        });
        const audio = new Speech.ScheduledSpeechAudio(() => ctx);
        audio.playbackRate = rate;
        const ends = appendWhileRunning
          ? [inputRate]
          : split
            ? [Math.floor(inputRate * 0.373), inputRate, 2 * inputRate]
            : [2 * inputRate];
        let from = 0;
        for (const to of ends) {
          const b = sine(ctx, inputRate, from, to);
          if (from === 0) audio.setBuffer(b);
          else audio.enqueue(b, () => undefined);
          from = to;
        }
        const failures = [];
        audio.onerror = () => failures.push("worklet error");
        await audio.play();
        const suspended = appendWhileRunning ? ctx.suspend(0.25) : null;
        const rendering = ctx.startRendering();
        if (suspended) {
          await suspended;
          audio.enqueue(
            sine(ctx, inputRate, inputRate, 2 * inputRate),
            () => undefined,
          );
          // play() awaits queued uploads but does not restart a running clock.
          await audio.play();
          await OfflineAudioContext.prototype.resume.call(ctx);
        }
        const samples = (await rendering).getChannelData(0);
        audio.dispose();
        if (failures.length) throw new Error(failures.join(","));
        return samples;
      }
      const results = [];
      for (const sr of [24000, 44100, 48000])
        for (const rate of [0.75, 1, 1.5, 2]) {
          const data = await render(sr, rate, true),
            whole = await render(sr, rate, false),
            appended = await render(sr, rate, false, sr, true);
          let first = -1,
            last = -1,
            crossings = 0,
            quiet = 0,
            longestQuiet = 0,
            maxDifference = 0,
            nonfinite = 0;
          // Half-amplitude duration measures the independently rendered waveform,
          // not a nominally trimmed buffer. The quieter synthesis tail is retained.
          for (let i = 0; i < data.length; i++) {
            if (!Number.isFinite(data[i])) nonfinite++;
            if (Math.abs(data[i]) > 0.25) {
              if (first < 0) first = i;
              last = i;
            }
            maxDifference = Math.max(
              maxDifference,
              Math.abs(data[i] - whole[i]),
              Math.abs(appended[i] - whole[i]),
            );
          }
          const start = first + Math.round(0.15 * sr),
            end = last - Math.round(0.15 * sr);
          for (let i = start + 1; i < end; i++) {
            if (data[i - 1] <= 0 && data[i] > 0) crossings++;
            if (Math.abs(data[i]) < 0.001) quiet++;
            else quiet = 0;
            longestQuiet = Math.max(longestQuiet, quiet);
          }
          results.push({
            sr,
            rate,
            frequency: (crossings * sr) / (end - start),
            duration: (last - first + 1) / sr,
            longestQuiet: longestQuiet / sr,
            maxDifference,
            nonfinite,
          });
        }
      // Exercise the adapter's explicit input/hardware-rate conversion too.
      const resampled = await render(44100, 1.5, true, 24000);
      let crossings = 0;
      for (let i = 22051; i < 44100; i++)
        if (resampled[i - 1] <= 0 && resampled[i] > 0) crossings++;
      return { results, resampledFrequency: crossings * 2 };
    });
    console.table(results.results);
    for (const r of results.results) {
      assert.equal(r.nonfinite, 0);
      assert.ok(Math.abs(r.frequency - 440) < 5, `pitch: ${JSON.stringify(r)}`);
      assert.ok(
        Math.abs(r.duration - 2 / r.rate) < 0.015,
        `duration: ${JSON.stringify(r)}`,
      );
      assert.ok(
        r.longestQuiet < 0.002,
        `inserted silence: ${JSON.stringify(r)}`,
      );
      assert.ok(
        r.maxDifference < 0.00001,
        `chunk-dependent DSP: ${JSON.stringify(r)}`,
      );
    }
    assert.ok(
      Math.abs(results.resampledFrequency - 440) < 5,
      `resampling: ${results.resampledFrequency}`,
    );
    // Real-time, trusted click: no autoplay-bypass launch flags. Exercise append
    // DURING playback, rapid speed commands, pause, resume and session replacement.
    await page.evaluate(() => {
      document.querySelector("#start").onclick = () => {
        window.live = (async () => {
          const ctx = new AudioContext(),
            audio = new Speech.ScheduledSpeechAudio(() => ctx);
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const b = () => {
            const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
            const a = b.getChannelData(0);
            for (let i = 0; i < a.length; i++)
              a[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / ctx.sampleRate);
            return b;
          };
          const failures = [];
          audio.onerror = () => failures.push("worklet error");
          audio.unlock();
          audio.setBuffer(b());
          await audio.play();
          let boundaries = 0;
          audio.enqueue(b(), () => boundaries++);
          audio.enqueue(b(), () => boundaries++);
          await sleep(300);
          const before = audio.currentTime;
          audio.playbackRate = 0.75;
          audio.playbackRate = 1.5;
          audio.playbackRate = 2;
          await sleep(200);
          audio.pause();
          const paused = audio.currentTime;
          await sleep(150);
          const frozen = audio.currentTime;
          await audio.play();
          await sleep(600);
          const current = audio.currentTime;
          audio.removeAttribute("src");
          const old = boundaries;
          audio.setBuffer(b());
          await audio.play();
          await sleep(150);
          const restarted = audio.currentTime;
          const result = {
            state: ctx.state,
            before,
            paused,
            frozen,
            current,
            boundaries,
            old,
            restarted,
            failures,
          };
          audio.dispose();
          return result;
        })();
      };
    });
    await page.click("#start");
    const live = await page.evaluate(() => window.live);
    console.log("Real-time lifecycle:", live);
    assert.equal(live.state, "running");
    assert.ok(live.before > 0);
    assert.equal(live.paused, live.frozen);
    assert.ok(live.current >= 0 && live.current < 1);
    assert.ok(live.boundaries >= 1);
    assert.equal(live.boundaries, live.old);
    assert.ok(live.restarted >= 0 && live.restarted < 0.3);
    assert.deepEqual(live.failures, []);
    await page.evaluate(() => {
      document.querySelector("#start").onclick = () => {
        window.nativeTest = (async () => {
          const ctx = new AudioContext();
          const audio = new Speech.ScheduledSpeechAudio(
            () => ctx,
            async () => {
              throw new Error("Regression: worklet unavailable");
            },
          );
          audio.unlock();
          const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
          const samples = buffer.getChannelData(0);
          for (let i = 0; i < samples.length; i++)
            samples[i] =
              0.4 * Math.sin((2 * Math.PI * 440 * i) / ctx.sampleRate);
          audio.setBuffer(buffer);
          let boundaries = 0,
            ended = 0;
          audio.enqueue(buffer, () => boundaries++);
          audio.onended = () => ended++;
          await audio.play();
          // Inspect genuine HTMLMediaElement PCM, not merely its ticking clock.
          const media = audio.fallback;
          const source = ctx.createMediaElementSource(media);
          const analyser = ctx.createAnalyser();
          source.connect(analyser);
          analyser.connect(ctx.destination);
          await new Promise((r) => setTimeout(r, 250));
          const pcm = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(pcm);
          const rms = Math.sqrt(
            pcm.reduce((sum, x) => sum + x * x, 0) / pcm.length,
          );
          audio.pause();
          const paused = audio.currentTime;
          await new Promise((r) => setTimeout(r, 100));
          const frozen = audio.currentTime;
          audio.playbackRate = 2;
          await audio.play();
          await new Promise((r) => setTimeout(r, 1100));
          const result = {
            rms,
            paused,
            frozen,
            boundaries,
            ended,
            pitch: media.preservesPitch,
          };
          audio.removeAttribute("src");
          audio.setBuffer(buffer);
          await audio.play();
          audio.dispose();
          source.disconnect();
          analyser.disconnect();
          return result;
        })();
      };
    });
    await page.click("#start");
    const native = await page.evaluate(() => window.nativeTest);
    console.log("Native fallback PCM/lifecycle:", native);
    assert.ok(native.rms > 0.1, "Native fallback must output nonzero PCM");
    assert.equal(native.paused, native.frozen);
    assert.equal(native.boundaries, 1);
    assert.equal(native.ended, 1);
    assert.equal(native.pitch, true);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: real PCM pitch/duration, sample-identical chunk boundaries, resampling, trusted-click playback, speed/pause/resume/navigation",
    );
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    server?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
