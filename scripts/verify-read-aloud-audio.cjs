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
  try {
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
    page.on("pageerror", (e) => errors.push(e.message));
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
    assert.deepEqual(errors, []);
    console.log(
      "PASS: real PCM pitch/duration, sample-identical chunk boundaries, resampling, trusted-click playback, speed/pause/resume/navigation",
    );
  } finally {
    await browser?.close();
    server?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
