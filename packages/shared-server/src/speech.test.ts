import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

const { config } = vi.hoisted(() => ({
  config: {
    speech: {
      url: undefined as string | undefined,
      token: undefined as string | undefined,
      allowPrivateHttp: false,
      kokoroUrl: undefined as string | undefined,
      kokoroToken: undefined as string | undefined,
      alignUrl: undefined as string | undefined,
      alignToken: undefined as string | undefined,
    },
  },
}));

vi.mock("@karakeep/shared/config", () => ({ default: config }));

import {
  getSpeechVoices,
  resolveSpeechEndpoint,
  SpeechBusyError,
  SpeechInvalidInputError,
  SpeechNotConfiguredError,
  SpeechUpstreamError,
  synthesizeAlignedSpeech,
  synthesizeSpeech,
  synthesizeTimedSpeech,
} from "./speech";

interface StubRequest {
  url: string | undefined;
  method: string | undefined;
  authorization: string | undefined;
  body: unknown;
}

async function startStub(
  responder: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{
  port: number;
  requests: StubRequest[];
  close: () => Promise<void>;
}> {
  const requests: StubRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      requests.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      });
      responder(req, res);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function wav(): Buffer {
  return Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WAVE"),
    Buffer.alloc(64),
  ]);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("synthesizeTimedSpeech", () => {
  it("defers background jobs during worker restarts rather than exhausting retries", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("fetch failed"));
    config.speech.kokoroUrl = "http://127.0.0.1:4320";
    config.speech.kokoroToken = "synthetic-test-credential";
    try {
      await expect(
        synthesizeTimedSpeech("Hello", "kokoro:bf_emma", { background: true }),
      ).rejects.toMatchObject({
        name: "SpeechBusyError",
        retryAfterSeconds: 5,
      });
      await expect(
        synthesizeTimedSpeech("Hello", "kokoro:bf_emma"),
      ).rejects.toBeInstanceOf(SpeechUpstreamError);
      const controller = new AbortController();
      controller.abort();
      await expect(
        synthesizeTimedSpeech("Hello", "kokoro:bf_emma", {
          background: true,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      fetchSpy.mockRestore();
      config.speech.kokoroUrl = undefined;
      config.speech.kokoroToken = undefined;
    }
  });

  it("marks preparation as background work and forwards cancellation and retry delays", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 503,
        headers: { "Retry-After": "30" },
      }),
    );
    const controller = new AbortController();
    config.speech.kokoroUrl = "http://127.0.0.1:4320";
    config.speech.kokoroToken = "synthetic-test-credential";
    try {
      await expect(
        synthesizeTimedSpeech("Hello", "kokoro:bf_emma", {
          background: true,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({
        name: "SpeechBusyError",
        retryAfterSeconds: 30,
      });
      const options = fetchSpy.mock.calls[0]![1]!;
      expect(options.headers).toMatchObject({
        "X-Speech-Priority": "background",
      });
      controller.abort();
      expect(options.signal?.aborted).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      config.speech.kokoroUrl = undefined;
      config.speech.kokoroToken = undefined;
    }
  });

  it("forwards only the Kokoro token and rejects invalid word ranges", async () => {
    let invalid = false;
    const stub = await startStub((_req, res) =>
      sendJson(res, 200, {
        audio: wav().toString("base64"),
        duration: 1,
        words: [{ from: 0, to: invalid ? 100 : 5, start: 0, end: 0.8 }],
      }),
    );
    config.speech.kokoroUrl = `http://127.0.0.1:${stub.port}`;
    config.speech.kokoroToken = "kokoro-private-token";
    try {
      const result = await synthesizeTimedSpeech("Hello", "kokoro:af_heart");
      expect(result.words[0]?.to).toBe(5);
      expect(stub.requests[0]?.authorization).toBe(
        "Bearer kokoro-private-token",
      );
      invalid = true;
      await expect(
        synthesizeTimedSpeech("Hello", "kokoro:af_heart"),
      ).rejects.toBeInstanceOf(SpeechUpstreamError);
    } finally {
      config.speech.kokoroUrl = undefined;
      config.speech.kokoroToken = undefined;
      await stub.close();
    }
  });
});

describe("synthesizeAlignedSpeech", () => {
  it("adds mapped word offsets when the aligner is configured", async () => {
    const stub = await startStub((req, res) => {
      if (req.url === "/synthesize") {
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(wav());
        return;
      }
      sendJson(res, 200, {
        duration: 2,
        words: [
          { word: "Hello", start: 0, end: 0.4 },
          { word: "world.", start: 0.5, end: 1 },
        ],
      });
    });
    config.speech.url = `http://127.0.0.1:${stub.port}`;
    config.speech.token = "speech-token";
    config.speech.alignUrl = `http://127.0.0.1:${stub.port}`;
    config.speech.alignToken = "align-token";
    try {
      const result = await synthesizeAlignedSpeech("Hello world.", "voice-1");
      expect(result.timed?.duration).toBe(2);
      expect(result.timed?.words.map((word) => [word.from, word.to])).toEqual([
        [0, 5],
        [6, 12],
      ]);
      expect(stub.requests.map((request) => request.url)).toEqual([
        "/synthesize",
        "/align",
      ]);
      expect(stub.requests[1]?.authorization).toBe("Bearer align-token");
    } finally {
      config.speech.alignUrl = undefined;
      config.speech.alignToken = undefined;
      await stub.close();
    }
  });

  it("returns untimed audio when the aligner is absent or rejects the words", async () => {
    const stub = await startStub((_req, res) => {
      if (_req.url === "/synthesize") {
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(wav());
        return;
      }
      sendJson(res, 200, {
        duration: 2,
        words: [{ word: "missing", start: 0, end: 1 }],
      });
    });
    config.speech.url = `http://127.0.0.1:${stub.port}`;
    config.speech.token = "speech-token";
    try {
      const absent = await synthesizeAlignedSpeech("Hello world.", "voice-1");
      expect(absent.timed).toBeNull();
      config.speech.alignUrl = `http://127.0.0.1:${stub.port}`;
      config.speech.alignToken = "align-token";
      const unmatched = await synthesizeAlignedSpeech(
        "Hello world.",
        "voice-1",
      );
      expect(unmatched.timed).toBeNull();
      expect(unmatched.audio.subarray(0, 4).toString("ascii")).toBe("RIFF");
    } finally {
      config.speech.alignUrl = undefined;
      config.speech.alignToken = undefined;
      await stub.close();
    }
  });
});

describe("resolveSpeechEndpoint", () => {
  it("rejects missing URL or token", () => {
    expect(() =>
      resolveSpeechEndpoint(undefined, "token", false, "/voices"),
    ).toThrow(SpeechNotConfiguredError);
    expect(() =>
      resolveSpeechEndpoint("https://example.com", undefined, false, "/voices"),
    ).toThrow(SpeechNotConfiguredError);
  });

  it("rejects URLs with userinfo, search, or hash", () => {
    expect(() =>
      resolveSpeechEndpoint(
        "https://user:pass@example.com",
        "token",
        false,
        "/voices",
      ),
    ).toThrow(SpeechNotConfiguredError);
    expect(() =>
      resolveSpeechEndpoint(
        "https://example.com?x=1",
        "token",
        false,
        "/voices",
      ),
    ).toThrow(SpeechNotConfiguredError);
    expect(() =>
      resolveSpeechEndpoint(
        "https://example.com#frag",
        "token",
        false,
        "/voices",
      ),
    ).toThrow(SpeechNotConfiguredError);
  });

  it("allows HTTPS and loopback HTTP but not arbitrary private HTTP", () => {
    expect(
      resolveSpeechEndpoint("https://example.com", "token", false, "/voices")
        .url.href,
    ).toBe("https://example.com/voices");
    expect(
      resolveSpeechEndpoint("http://127.0.0.1:4318", "token", false, "/voices")
        .url.href,
    ).toBe("http://127.0.0.1:4318/voices");
    expect(
      resolveSpeechEndpoint("http://localhost:4318", "token", false, "/voices")
        .url.href,
    ).toBe("http://localhost:4318/voices");
    expect(() =>
      resolveSpeechEndpoint(
        "http://192.168.64.1:4318",
        "token",
        false,
        "/voices",
      ),
    ).toThrow(SpeechNotConfiguredError);
    expect(
      resolveSpeechEndpoint(
        "http://192.168.64.1:4318",
        "token",
        true,
        "/voices",
      ).url.href,
    ).toBe("http://192.168.64.1:4318/voices");
  });
});

describe("getSpeechVoices", () => {
  it("forwards the bearer token and validates the voice catalog", async () => {
    const stub = await startStub((_req, res) => {
      sendJson(res, 200, [
        { id: "voice-1", name: "Voice One", language: "en-US" },
      ]);
    });
    config.speech.url = `http://127.0.0.1:${stub.port}`;
    config.speech.token = "focused-speech-token";
    config.speech.allowPrivateHttp = false;

    try {
      const voices = await getSpeechVoices();
      expect(voices).toEqual([
        { id: "voice-1", name: "Voice One", language: "en-US" },
      ]);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0].authorization).toBe(
        "Bearer focused-speech-token",
      );
      expect(stub.requests[0].url).toBe("/voices");
    } finally {
      await stub.close();
    }
  });

  it("rejects invalid voice catalogs", async () => {
    const stub = await startStub((_req, res) => {
      sendJson(res, 200, [{ id: 1 }]);
    });
    config.speech.url = `http://127.0.0.1:${stub.port}`;
    config.speech.token = "token";
    config.speech.allowPrivateHttp = false;

    try {
      await expect(getSpeechVoices()).rejects.toThrow(SpeechUpstreamError);
    } finally {
      await stub.close();
    }
  });

  it("maps worker 503 to busy with Retry-After", async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(503, { "Retry-After": "2" });
      res.end();
    });
    config.speech.url = `http://127.0.0.1:${stub.port}`;
    config.speech.token = "token";
    config.speech.allowPrivateHttp = false;

    try {
      const error = await getSpeechVoices().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SpeechBusyError);
      expect((error as SpeechBusyError).retryAfterSeconds).toBe(2);
    } finally {
      await stub.close();
    }
  });

  it("maps other worker failures to upstream errors", async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    config.speech.url = `http://127.0.0.1:${stub.port}`;
    config.speech.token = "token";
    config.speech.allowPrivateHttp = false;

    try {
      await expect(getSpeechVoices()).rejects.toThrow(SpeechUpstreamError);
    } finally {
      await stub.close();
    }
  });
});

describe("synthesizeSpeech", () => {
  it("validates input before contacting the worker", async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(wav());
    });
    config.speech.url = `http://127.0.0.1:${stub.port}`;
    config.speech.token = "token";
    config.speech.allowPrivateHttp = false;

    try {
      await expect(synthesizeSpeech("", "voice")).rejects.toThrow(
        SpeechInvalidInputError,
      );
      await expect(synthesizeSpeech("   ", "voice")).rejects.toThrow(
        SpeechInvalidInputError,
      );
      await expect(
        synthesizeSpeech("x".repeat(10_001), "voice"),
      ).rejects.toThrow(SpeechInvalidInputError);
      await expect(synthesizeSpeech("hello", "")).rejects.toThrow(
        SpeechInvalidInputError,
      );
      await expect(synthesizeSpeech("hello", "v".repeat(301))).rejects.toThrow(
        SpeechInvalidInputError,
      );
      expect(stub.requests).toHaveLength(0);
    } finally {
      await stub.close();
    }
  });

  it("forwards the bearer token and validates the returned WAV", async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(wav());
    });
    config.speech.url = `http://127.0.0.1:${stub.port}`;
    config.speech.token = "focused-speech-token";
    config.speech.allowPrivateHttp = false;

    try {
      const audio = await synthesizeSpeech("hello", "voice-1");
      expect(audio.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0].authorization).toBe(
        "Bearer focused-speech-token",
      );
      expect(stub.requests[0].body).toEqual({
        text: "hello",
        voice: "voice-1",
      });
    } finally {
      await stub.close();
    }
  });

  it("does not follow redirects", async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(302, { Location: "/other" });
      res.end();
    });
    config.speech.url = `http://127.0.0.1:${stub.port}`;
    config.speech.token = "token";
    config.speech.allowPrivateHttp = false;

    try {
      await expect(synthesizeSpeech("hello", "voice-1")).rejects.toThrow(
        SpeechUpstreamError,
      );
      expect(stub.requests).toHaveLength(1);
    } finally {
      await stub.close();
    }
  });

  it("rejects invalid audio", async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(Buffer.from("not-a-wav"));
    });
    config.speech.url = `http://127.0.0.1:${stub.port}`;
    config.speech.token = "token";
    config.speech.allowPrivateHttp = false;

    try {
      await expect(synthesizeSpeech("hello", "voice-1")).rejects.toThrow(
        SpeechUpstreamError,
      );
    } finally {
      await stub.close();
    }
  });

  it("caps the audio response at 32 MiB", async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(Buffer.alloc(32 * 1024 * 1024 + 1));
    });
    config.speech.url = `http://127.0.0.1:${stub.port}`;
    config.speech.token = "token";
    config.speech.allowPrivateHttp = false;

    try {
      await expect(synthesizeSpeech("hello", "voice-1")).rejects.toThrow(
        SpeechUpstreamError,
      );
    } finally {
      await stub.close();
    }
  });

  it("normalizes interrupted response bodies to upstream errors", async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.write("RIFFxxxxWAVEyyyy");
      res.destroy();
    });
    config.speech.url = `http://127.0.0.1:${stub.port}`;
    config.speech.token = "token";
    config.speech.allowPrivateHttp = false;

    try {
      await expect(synthesizeSpeech("hello", "voice-1")).rejects.toThrow(
        SpeechUpstreamError,
      );
    } finally {
      await stub.close();
    }
  });

  it("maps worker 400 to invalid input and 503 to busy", async () => {
    const badRequest = await startStub((_req, res) => {
      res.writeHead(400);
      res.end();
    });
    config.speech.url = `http://127.0.0.1:${badRequest.port}`;
    config.speech.token = "token";
    config.speech.allowPrivateHttp = false;
    try {
      await expect(synthesizeSpeech("hello", "bad-voice")).rejects.toThrow(
        SpeechInvalidInputError,
      );
    } finally {
      await badRequest.close();
    }

    const busy = await startStub((_req, res) => {
      res.writeHead(503, { "Retry-After": "1" });
      res.end();
    });
    config.speech.url = `http://127.0.0.1:${busy.port}`;
    try {
      const error = await synthesizeSpeech("hello", "voice-1").catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SpeechBusyError);
    } finally {
      await busy.close();
    }
  });
});
