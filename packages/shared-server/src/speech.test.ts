import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

const { config } = vi.hoisted(() => ({
  config: {
    speech: {
      url: undefined as string | undefined,
      token: undefined as string | undefined,
      allowPrivateHttp: false,
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
  synthesizeSpeech,
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
