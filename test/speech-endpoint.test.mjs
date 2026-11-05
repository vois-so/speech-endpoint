import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  DEFAULT_CONFIG,
  clampSpeed,
  cliError,
  mapVoice,
  pickLibraryVoice,
  generateArgs,
  hostAllowed,
  mapModel,
  parseSpeechRequest,
  parseWav,
  start,
  wavToPcm16,
} from "../speech-endpoint.mjs";

const TOKEN = "vois-test-token-0123456789abcdef0123456789";
const dir = mkdtempSync(join(tmpdir(), "speech-endpoint-"));
const argsFile = join(dir, "args.json");
const fake = join(dir, "fake-vois-cli");

// A fake vois-cli: writes a 16-bit 24 kHz mono WAV of 0.1 s to stdout,
// or stops with the code in FAKE_EXIT.
writeFileSync(
  fake,
  `#!/usr/bin/env node
const fs = require("fs");
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args: process.argv.slice(2), input }));
  const code = Number(process.env.FAKE_EXIT || 0);
  if (code) {
    process.stderr.write(JSON.stringify({ error: { message: "fake failure" } }) + "\\n");
    process.exit(code);
  }
  if (process.argv.includes("voice")) {
    process.stdout.write(JSON.stringify([{ id: "sonic_cedar" }]));
    return;
  }
  const samples = 2400, data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  process.stdout.write(Buffer.concat([h, data]));
});
`,
);
chmodSync(fake, 0o755);

let server;
let port;
const env = { ...process.env, VOIS_CLI: fake };

function call(method, path, { body, headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: host ?? `127.0.0.1:${port}`,
          ...(data !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };

before(async () => {
  port = 20000 + Math.floor(Math.random() * 20000);
  server = await start({ port, token: TOKEN, config: { ...DEFAULT_CONFIG, port }, env, log: () => {} });
});

after(async () => {
  await server.close();
});

test("mapping of models, voices, speed and arguments", () => {
  assert.equal(mapModel("tts-1", DEFAULT_CONFIG), "sonic");
  assert.equal(mapModel("vois-omni", DEFAULT_CONFIG), "omni");
  assert.equal(mapModel("craft", DEFAULT_CONFIG), "craft");
  assert.equal(mapModel("whisper-1", DEFAULT_CONFIG), null);
  assert.equal(mapVoice("nova", DEFAULT_CONFIG, "sonic"), "sonic_ember");
  assert.equal(mapVoice("nova", DEFAULT_CONFIG, "fast"), "");
  assert.equal(mapVoice("nova", { ...DEFAULT_CONFIG, engineVoices: { omni: "lib/v1" } }, "omni"), "lib/v1");
  assert.equal(mapVoice("library/morgan", DEFAULT_CONFIG, "omni"), "library/morgan");
  assert.deepEqual(cliError('{\n  "error": {\n    "data": { "reason": "incompatible_voice" },\n    "message": "x"\n  }\n}'), { message: "x", reason: "incompatible_voice" });
  const lib = [
    { id: "b/m1", gender: "male", supported_engines: ["fast", "omni"] },
    { id: "a/f1", gender: "female", supported_engines: ["fast"] },
    { id: "c/f2", gender: "female", supported_engines: ["fast", "omni"] },
    { id: "d/clone", gender: "female", source: "cloned", supported_engines: ["fast"] },
  ];
  assert.equal(pickLibraryVoice(lib, "fast", "nova"), "a/f1");
  assert.equal(pickLibraryVoice(lib, "fast", "shimmer"), "c/f2");
  assert.equal(pickLibraryVoice(lib, "omni", "onyx"), "b/m1");
  assert.equal(pickLibraryVoice(lib, "craft", "nova"), "");
  assert.equal(clampSpeed(4), 2);
  assert.equal(clampSpeed(0.25), 0.5);
  assert.equal(clampSpeed("x"), 1);
  assert.deepEqual(generateArgs({ engine: "fast", voice: "v1", speed: 1, language: "English", instructions: "calm" }), [
    "tts", "generate", "--engine", "fast", "--text", "-", "--output", "-", "--format", "json", "--voice", "v1", "--language", "English",
  ]);
  assert.ok(generateArgs({ engine: "omni", voice: "v", speed: 1.2, language: "", instructions: "calm" }).includes("--instruct"));
});

test("request validation", () => {
  assert.equal(parseSpeechRequest({ voice: "alloy" }, DEFAULT_CONFIG).error[0], 400);
  assert.equal(parseSpeechRequest({ input: "Hi", voice: "alloy", model: "x" }, DEFAULT_CONFIG).error[1], "model_not_found");
  assert.equal(parseSpeechRequest({ input: "a".repeat(5000), voice: "alloy" }, DEFAULT_CONFIG).error[0], 400);
  const ok = parseSpeechRequest({ input: " Hi ", voice: "nova", response_format: "wav" }, DEFAULT_CONFIG).job;
  assert.deepEqual(ok, { input: "Hi", engine: "sonic", voice: "sonic_ember", alias: "nova", speed: 1, language: "English", instructions: "", format: "wav" });
});

test("host check accepts only local names on the right port", () => {
  assert.ok(hostAllowed("127.0.0.1:8790", 8790));
  assert.ok(hostAllowed("localhost:8790", 8790));
  assert.ok(hostAllowed("[::1]:8790", 8790));
  assert.ok(hostAllowed("host.docker.internal:8790", 8790));
  assert.ok(!hostAllowed("evil.example:8790", 8790));
  assert.ok(!hostAllowed("localhost:9999", 8790));
  assert.ok(!hostAllowed(undefined, 8790));
});

test("health needs no token, the API does", async () => {
  assert.equal((await call("GET", "/health")).status, 200);
  assert.equal((await call("GET", "/v1/models")).status, 401);
  assert.equal((await call("GET", "/v1/models", { headers: { authorization: "Bearer wrong" } })).status, 401);
  const models = await call("GET", "/v1/models", { headers: auth });
  assert.equal(models.status, 200);
  assert.ok(JSON.parse(models.body).data.some((m) => m.id === "omni"));
});

test("a different Host header is refused (DNS rebinding)", async () => {
  const r = await call("POST", "/v1/audio/speech", { headers: auth, host: "attacker.example", body: { input: "x", voice: "alloy" } });
  assert.equal(r.status, 403);
});

test("a body that is not JSON is refused", async () => {
  const r = await call("POST", "/v1/audio/speech", {
    headers: { ...auth, "content-type": "text/plain" },
    body: "input=hi",
  });
  assert.equal(r.status, 415);
});

test("wav and pcm come back from vois-cli", async () => {
  const wav = await call("POST", "/v1/audio/speech", { headers: auth, body: { input: "Hello there.", voice: "alloy", response_format: "wav" } });
  assert.equal(wav.status, 200);
  assert.equal(wav.headers["content-type"], "audio/wav");
  assert.equal(parseWav(wav.body).sampleRate, 24000);
  const sent = JSON.parse(readFileSync(argsFile, "utf8"));
  assert.equal(sent.input, "Hello there.\n");
  assert.deepEqual(sent.args.slice(0, 4), ["tts", "generate", "--engine", "sonic"]);
  assert.ok(sent.args.includes("sonic_cedar"));

  const pcm = await call("POST", "/v1/audio/speech", { headers: auth, body: { input: "Hi.", voice: "alloy", response_format: "pcm" } });
  assert.equal(pcm.status, 200);
  assert.equal(pcm.body.length, 4800);
  assert.deepEqual(pcm.body, wavToPcm16(wav.body));
});

test("mp3 needs ffmpeg", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 }, async () => {
  const r = await call("POST", "/v1/audio/speech", { headers: auth, body: { input: "Hi.", voice: "alloy" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "audio/mpeg");
  assert.ok(r.body.length > 100);
});

test("vois-cli exit codes become HTTP errors", async () => {
  const cases = [
    [7, 402, "plan_required"],
    [2, 503, "app_not_running"],
    [4, 404, "voice_not_found"],
    [64, 400, "invalid_request"],
  ];
  for (const [exit, status, code] of cases) {
    const p2 = port + 1;
    const s2 = await start({ port: p2, token: TOKEN, config: { ...DEFAULT_CONFIG, port: p2 }, env: { ...env, FAKE_EXIT: String(exit) }, log: () => {} });
    let got;
    try {
      const r = await fetch(`http://127.0.0.1:${p2}/v1/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ input: "Hi.", voice: "alloy", response_format: "wav" }),
      });
      got = { status: r.status, text: await r.text() };
    } finally {
      await s2.close();
    }
    assert.equal(got.status, status, `exit ${exit}: ${got.text.slice(0, 200)}`);
    assert.equal(JSON.parse(got.text).error.code, code);
  }
});
