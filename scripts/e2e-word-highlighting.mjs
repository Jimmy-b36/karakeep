// Runs only inside an isolated synthetic test network, never against production.
import { lookup } from "node:dns/promises";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const address = (await lookup("chrome")).address;
const browser = `http://${address}:9222`;
const prepare = process.argv.includes("--prepare");
let target;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    if (prepare) {
      const response = await fetch(`${browser}/json/new?${encodeURIComponent("http://web:3000/signin")}`, { method: "PUT" });
      assert(response.ok);
      target = await response.json();
    } else {
      target = (await (await fetch(`${browser}/json/list`)).json()).find((page) => page.type === "page" && page.url.startsWith("http://web:3000"));
      assert(target);
    }
    break;
  } catch {
    await delay(1000);
  }
}
assert(target, "Browser did not become ready");
const wsURL = new URL(target.webSocketDebuggerUrl);
wsURL.hostname = address;
const socket = new WebSocket(wsURL);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let serial = 0;
const pending = new Map();
socket.addEventListener("message", ({ data }) => {
  const response = JSON.parse(data);
  const entry = pending.get(response.id);
  if (!entry) return;
  pending.delete(response.id);
  if (response.error) entry.reject(new Error(JSON.stringify(response.error)));
  else entry.resolve(response.result);
});
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text + ": " + response.exceptionDetails.exception?.description);
  return response.result.value;
}
async function until(expression, message) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate(expression)) return;
    await delay(250);
  }
  throw new Error(message);
}

try {
  await command("Page.enable");
  if (prepare) {
    await until('location.origin === "http://web:3000" && document.readyState === "complete"', "App page did not load");
    const status = await evaluate(`(async () => {
      const r = await fetch('/api/auth/sign-up/email', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:'Synthetic Reader',email:'word-e2e@example.test',password:'Synthetic-e2e-password-12345'})});
      if (!r.ok) throw new Error('Synthetic signup failed: '+r.status+' '+await r.text());
      return r.status;
    })()`);
    console.log("Synthetic browser signup HTTP", status);
  } else {
    await command("Page.navigate", { url: "http://web:3000/reader/word-e2e" });
    await until('!!document.querySelector(\'button[aria-label="Listen"]\')', "Reader Listen control not found");
    await evaluate('document.querySelector(\'button[aria-label="Listen"]\').click()');
    await until('Array.from(document.querySelectorAll("button")).some(b => b.textContent.trim() === "Play" && !b.disabled)', "Playable Kokoro voice not available");
    assert(await evaluate('document.body.textContent.includes("Kokoro Heart")'), "Timed voice must be selected");
    await evaluate('Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "Play" && !b.disabled).click()');
    const words = [];
    for (let attempt = 0; attempt < 800; attempt++) {
      const word = await evaluate('Array.from(document.querySelectorAll("[data-speech-highlight]")).map(e=>e.textContent).join("")');
      if (word && words.at(-1) !== word) words.push(word);
      if (words.length >= 4) break;
      await delay(100);
    }
    assert(words.length >= 4, `Expected visible word progression, got ${JSON.stringify(words)}`);
    assert(words.every((word) => word.trim().split(/\s+/).length === 1), "Must highlight words, not paragraphs");
    const screenshot = await command("Page.captureScreenshot", { format: "png" });
    await writeFile("/tmp/word-highlighting.png", Buffer.from(screenshot.data, "base64"));
    await evaluate('Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "Stop").click()');
    await until('!document.querySelector("[data-speech-highlight]")', "Stop did not clear the word highlight");
    assert.equal(await evaluate('document.querySelectorAll(\'[role="presentation"] p\').length'), 2);
    await writeFile("/tmp/word-highlighting.json", JSON.stringify({ words, stopCleared: true, paragraphsIntact: true }, null, 2));
    console.log("Real browser visible word progression:", words.join(" → "));
  }
} finally {
  socket.close();
}
