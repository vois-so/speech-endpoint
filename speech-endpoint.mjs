#!/usr/bin/env node
// speech-endpoint: a local server that answers OpenAI-style speech requests with Vois Studio voices.
// MIT License. https://github.com/vois-so/speech-endpoint
//
// POST /v1/audio/speech   {model, input, voice, response_format, speed, instructions, language}
// GET  /v1/models         the engines, as OpenAI-style models
// GET  /v1/audio/voices   the voices that vois-cli lists
// GET  /health            {status: "ok"}
//
// It listens only on this computer (127.0.0.1 and ::1), needs a token, and checks the Host header.
// It needs Node.js 18 or later and Vois Studio. It has no npm dependencies.

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
export const DEFAULT_PORT = 8790;
const MAX_BODY = 64 * 1024;
const MAX_INPUT = 4096;
const ENGINES = ["fast", "expressive", "multilingual", "omni", "sonic", "craft"];
const OPENAI_MODELS = ["tts-1", "tts-1-hd", "gpt-4o-mini-tts"];
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "host.docker.internal"]);

export const DEFAULT_CONFIG = Object.freeze({
  port: DEFAULT_PORT,
  engine: "sonic",
  language: "English",
  voices: {
    alloy: "sonic_cedar",
    echo: "sonic_harbor",
    fable: "sonic_slate",
    onyx: "sonic_ridge",
    nova: "sonic_ember",
    shimmer: "sonic_meadow",
    ash: "sonic_juniper",
    ballad: "sonic_willow",
    coral: "sonic_coral",
    sage: "sonic_sage",
    verse: "sonic_willow",
  },
  // A default voice for each engine other than Sonic, for example {"omni": "<voice id>"}.
  // When a request names an OpenAI voice (alloy, nova, ...) and the engine is not Sonic,
  // this voice is used; with no entry, vois-cli uses the default voice of the engine.
  engineVoices: {},
  extraHosts: [],
});

const CONTENT_TYPES = {
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/pcm",
};

const FFMPEG_ARGS = {
  mp3: ["-f", "mp3", "-b:a", "128k"],
  opus: ["-c:a", "libopus", "-b:a", "64k", "-f", "ogg"],
  aac: ["-c:a", "aac", "-b:a", "128k", "-f", "adts"],
  flac: ["-f", "flac"],
};

// vois-cli exit code -> [HTTP status, error code, message]
const EXIT_MAP = {
  2: [503, "app_not_running", "Vois Studio is not open. Open Vois Studio, or run: vois-cli service start"],
  3: [400, "invalid_request", "vois-cli did not accept the request."],
  4: [404, "voice_not_found", "Vois Studio does not have this voice. GET /v1/audio/voices lists the voices."],
  5: [500, "generation_failed", "Vois Studio could not make the audio."],
  6: [500, "export_failed", "Vois Studio could not write the audio."],
  7: [402, "plan_required", "Audio files from vois-cli need a paid Vois Studio plan or export credits. See https://vois.so/pricing"],
  8: [429, "quota_exceeded", "The quota of your Vois Studio plan is used."],
  9: [503, "timeout", "Vois Studio did not answer in time."],
  10: [503, "busy", "The Sonic queue is full. Try again."],
  11: [503, "insufficient_memory", "The computer does not have sufficient free memory for this engine."],
  12: [503, "download_failed", "The engine download failed. Open Vois Studio and download the engine."],
  13: [503, "engine_not_available", "This engine is not available to download yet."],
  64: [400, "invalid_request", "vois-cli did not accept the request. If the language is not clear, send a language."],
};

// ---------------------------------------------------------------- config

export function configDir(env = process.env, platform = process.platform) {
  if (env.SPEECH_ENDPOINT_HOME) return env.SPEECH_ENDPOINT_HOME;
  if (platform === "win32") {
    return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "speech-endpoint");
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "speech-endpoint");
}

export function loadConfig(dir = configDir()) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  } catch {
    raw = {};
  }
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    voices: { ...DEFAULT_CONFIG.voices, ...(raw.voices || {}) },
    engineVoices: { ...(raw.engineVoices || {}) },
    extraHosts: Array.isArray(raw.extraHosts) ? raw.extraHosts : [],
  };
}

export function loadToken(dir = configDir(), { renew = false } = {}) {
  const file = join(dir, "token");
  if (!renew && existsSync(file)) {
    const t = readFileSync(file, "utf8").trim();
    if (t.length >= 32) return t;
  }
  mkdirSync(dir, { recursive: true });
  const token = `vois-${randomBytes(24).toString("hex")}`;
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows ignores the mode.
  }
  return token;
}

// ---------------------------------------------------------------- request mapping

export function mapModel(model, config) {
  const m = String(model || "").toLowerCase().replace(/^vois[-_]/, "");
  if (!m || OPENAI_MODELS.includes(m)) return config.engine;
  if (ENGINES.includes(m)) return m;
  return null;
}

// The usual sound of each OpenAI voice name, to pick a similar library voice.
const ALIAS_GENDER = {
  alloy: "any", echo: "male", fable: "male", onyx: "male", nova: "female", shimmer: "female",
  ash: "male", ballad: "male", coral: "female", sage: "female", verse: "male",
};

/**
 * An OpenAI voice name is an alias: a Sonic voice for Sonic, the engineVoices entry for
 * other engines, or "" when a library voice must be picked (see pickLibraryVoice).
 */
export function mapVoice(voice, config, engine = config.engine) {
  const v = String(voice || "").trim();
  const alias = config.voices[v.toLowerCase()];
  if (!alias) return v;
  if (engine === "sonic") return alias;
  return (config.engineVoices || {})[engine] || "";
}

/** Picks the same library voice each time for an alias: right engine, similar sound. */
export function pickLibraryVoice(voices, engine, alias) {
  const name = String(alias || "").toLowerCase();
  const gender = ALIAS_GENDER[name] || "any";
  const fits = (v) => Array.isArray(v?.supported_engines) && v.supported_engines.includes(engine) && v.source !== "cloned" && v.source !== "designed";
  const all = voices.filter(fits).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const same = gender === "any" ? all : all.filter((v) => String(v.gender || "").toLowerCase() === gender);
  const list = same.length ? same : all;
  if (!list.length) return "";
  const peers = Object.keys(ALIAS_GENDER).filter((a) => ALIAS_GENDER[a] === gender);
  return list[Math.max(0, peers.indexOf(name)) % list.length].id;
}

export function clampSpeed(speed) {
  const s = Number(speed);
  if (!Number.isFinite(s)) return 1;
  return Math.min(2, Math.max(0.5, s));
}

export function generateArgs({ engine, voice, speed, language, instructions }) {
  const args = ["tts", "generate", "--engine", engine, "--text", "-", "--output", "-", "--format", "json"];
  if (voice) args.push("--voice", voice);
  if (speed !== 1) args.push("--speed", String(speed));
  if (language) args.push("--language", language);
  if (instructions && (engine === "omni" || engine === "craft")) args.push("--instruct", instructions);
  return args;
}

/** Validates the JSON body. Returns {job} or {error: [status, code, message]}. */
export function parseSpeechRequest(body, config) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: [400, "invalid_request", "The body must be a JSON object."] };
  }
  const input = typeof body.input === "string" ? body.input.trim() : "";
  if (!input) return { error: [400, "invalid_request", "\"input\" must be a text that is not empty."] };
  if (input.length > MAX_INPUT) {
    return { error: [400, "invalid_request", `"input" must have ${MAX_INPUT} characters or fewer.`] };
  }
  if (typeof body.voice !== "string" || !body.voice.trim()) {
    return { error: [400, "invalid_request", "\"voice\" is necessary."] };
  }
  const engine = mapModel(body.model, config);
  if (!engine) {
    return { error: [400, "model_not_found", `Unknown model. Use ${ENGINES.join(", ")} or ${OPENAI_MODELS.join(", ")}.`] };
  }
  const format = String(body.response_format || "mp3").toLowerCase();
  if (!CONTENT_TYPES[format]) {
    return { error: [400, "invalid_request", `"response_format" must be one of ${Object.keys(CONTENT_TYPES).join(", ")}.`] };
  }
  const language = typeof body.language === "string" && body.language.trim() ? body.language.trim() : config.language;
  const instructions = typeof body.instructions === "string" ? body.instructions.trim().slice(0, 2000) : "";
  return {
    job: { input, engine, voice: mapVoice(body.voice, config, engine), alias: body.voice.trim().toLowerCase(), speed: clampSpeed(body.speed ?? 1), language, instructions, format },
  };
}

// ---------------------------------------------------------------- audio

/** Finds the PCM data of a WAV file. Returns {sampleRate, channels, bits, format, data}. */
export function parseWav(buf) {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("vois-cli did not return a WAV file.");
  }
  let fmt = null;
  let i = 12;
  while (i + 8 <= buf.length) {
    const id = buf.toString("ascii", i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const start = i + 8;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(start),
        channels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        bits: buf.readUInt16LE(start + 14),
      };
    } else if (id === "data" && fmt) {
      return { ...fmt, data: buf.subarray(start, Math.min(buf.length, start + size)) };
    }
    i = start + size + (size & 1);
  }
  throw new Error("The WAV file has no audio data.");
}

/** OpenAI "pcm": 24 kHz, 16-bit signed, little-endian, mono. */
export function wavToPcm16(buf) {
  const w = parseWav(buf);
  if (w.channels !== 1 || w.sampleRate !== 24000) {
    throw new Error(`Unexpected WAV: ${w.channels} channels at ${w.sampleRate} Hz.`);
  }
  if (w.format === 1 && w.bits === 16) return Buffer.from(w.data);
  if (w.format === 3 && w.bits === 32) {
    const out = Buffer.alloc((w.data.length / 4) * 2);
    for (let k = 0; k < w.data.length / 4; k++) {
      const s = Math.max(-1, Math.min(1, w.data.readFloatLE(k * 4)));
      out.writeInt16LE(Math.round(s * 32767), k * 2);
    }
    return out;
  }
  throw new Error(`Unexpected WAV sample format ${w.format}/${w.bits}.`);
}

function run(cmd, args, input, { env = process.env, timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const out = [];
    let err = "";
    let done = false;
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err, error });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish("TIMEOUT");
    }, timeoutMs);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => {
      err = (err + d).slice(-8000);
    });
    child.on("error", (e) => finish(e.code === "ENOENT" ? "ENOENT" : 1, e));
    child.on("close", (code) => finish(code ?? 1));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function findCli(env = process.env, platform = process.platform) {
  const list = [];
  if (env.VOIS_CLI) list.push(env.VOIS_CLI);
  if (platform === "darwin") {
    list.push("/Applications/Vois.app/Contents/MacOS/vois-cli");
    list.push(join(homedir(), "Applications", "Vois.app", "Contents", "MacOS", "vois-cli"));
  } else if (platform === "win32") {
    list.push(join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Vois", "vois-cli.exe"));
  }
  return list.find((p) => p && existsSync(p)) || null;
}

/** Reads the JSON error of vois-cli from stderr. Returns {message, reason}. */
export function cliError(stderr) {
  const text = String(stderr || "").trim();
  const tries = [text];
  const start = text.lastIndexOf("\n{");
  if (start >= 0) tries.push(text.slice(start + 1));
  for (const t of tries) {
    try {
      const j = JSON.parse(t);
      const e = j?.error || j;
      return { message: String(e?.message || ""), reason: String(e?.data?.reason || "") };
    } catch {
      // not JSON
    }
  }
  return { message: "", reason: "" };
}

const REASON_MAP = {
  incompatible_voice: [400, "voice_not_compatible", "This voice does not operate with this engine."],
  language_uncertain: [400, "language_uncertain", "Vois Studio could not find the language. Send a language, for example \"language\": \"English\"."],
  near_silent: [400, "near_silent", "The audio was almost silent. Send a longer text, or select a different voice."],
  package_unavailable: [503, "engine_not_available", "This engine is not available to download yet."],
};

class HttpError extends Error {
  constructor(status, code, message, retry) {
    super(message);
    this.status = status;
    this.code = code;
    this.retry = retry;
  }
}

export async function synthesize(job, { env = process.env } = {}) {
  const cli = findCli(env);
  if (!cli) {
    throw new HttpError(503, "vois_cli_not_found", "vois-cli was not found. Install Vois Studio, or set VOIS_CLI to the path of vois-cli.");
  }
  if (!job.voice && job.engine !== "sonic") {
    job = { ...job, voice: pickLibraryVoice(await cachedVoices(env), job.engine, job.alias) };
  }
  const res = await run(cli, generateArgs(job), `${job.input}\n`, { env });
  if (res.code !== 0) {
    const { message: detail, reason } = cliError(res.stderr);
    const [status, code, message] = REASON_MAP[reason] || EXIT_MAP[res.code] || [500, "vois_cli_error", "vois-cli stopped with an error."];
    const text = detail && status !== 402 && !REASON_MAP[reason] ? `${message} ${detail}` : message;
    throw new HttpError(status, code, text, status === 503 ? 5 : undefined);
  }
  const wav = res.stdout;
  if (job.format === "wav") return wav;
  if (job.format === "pcm") return wavToPcm16(wav);
  const ffmpeg = env.FFMPEG || "ffmpeg";
  const conv = await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", ...FFMPEG_ARGS[job.format], "pipe:1"], wav, { env, timeoutMs: 60000 });
  if (conv.code === "ENOENT") {
    throw new HttpError(501, "ffmpeg_not_found", `"${job.format}" needs ffmpeg. Install ffmpeg, or ask for "wav" or "pcm".`);
  }
  if (conv.code !== 0 || conv.stdout.length === 0) {
    throw new HttpError(500, "conversion_failed", `ffmpeg could not make ${job.format}.`);
  }
  return conv.stdout;
}

// ---------------------------------------------------------------- server

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

function sendError(res, status, code, message, retry) {
  sendJson(res, status, { error: { message, type: "invalid_request_error", code } }, retry ? { "retry-after": String(retry) } : {});
}

export function hostAllowed(hostHeader, port, extraHosts = []) {
  if (!hostHeader) return false;
  const m = String(hostHeader).toLowerCase().match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return false;
  if (m[2] && Number(m[2]) !== port) return false;
  return ALLOWED_HOSTS.has(m[1]) || extraHosts.map((h) => String(h).toLowerCase()).includes(m[1]);
}

function tokenMatches(header, token) {
  const m = /^Bearer\s+(.+)$/i.exec(header || "");
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "body_too_large", "The body is too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

let voiceCache = { at: 0, voices: [] };
async function cachedVoices(env) {
  if (Date.now() - voiceCache.at > 10 * 60 * 1000 || !voiceCache.voices.length) {
    const v = await listVoices(env);
    voiceCache = { at: Date.now(), voices: Array.isArray(v) ? v : v.voices || [] };
  }
  return voiceCache.voices;
}

async function listVoices(env) {
  const cli = findCli(env);
  if (!cli) throw new HttpError(503, "vois_cli_not_found", "vois-cli was not found.");
  const res = await run(cli, ["voice", "list", "--source", "all", "--format", "json"], "", { env, timeoutMs: 30000 });
  if (res.code !== 0) {
    const [status, code, message] = EXIT_MAP[res.code] || [500, "vois_cli_error", "vois-cli stopped with an error."];
    throw new HttpError(status, code, message);
  }
  return JSON.parse(res.stdout.toString("utf8"));
}

export function createHandler({ token, config, env = process.env, port = config.port }) {
  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  return async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host, port, config.extraHosts)) {
        return sendError(res, 403, "host_not_allowed", "This server accepts only requests to localhost.");
      }
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { status: "ok", version: VERSION });
      if (!tokenMatches(req.headers.authorization, token)) {
        return sendError(res, 401, "invalid_api_key", "Send the token as: Authorization: Bearer <token>. Run: speech-endpoint token");
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        const data = [...ENGINES, ...OPENAI_MODELS].map((id) => ({ id, object: "model", owned_by: "vois-studio" }));
        return sendJson(res, 200, { object: "list", data });
      }
      if (req.method === "GET" && url.pathname === "/v1/audio/voices") {
        return sendJson(res, 200, { voices: await listVoices(env), aliases: config.voices });
      }
      if (req.method === "POST" && url.pathname === "/v1/audio/speech") {
        if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) {
          return sendError(res, 415, "unsupported_media_type", "Send the body as application/json.");
        }
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          if (e instanceof HttpError) throw e;
          return sendError(res, 400, "invalid_json", "The body is not valid JSON.");
        }
        const parsed = parseSpeechRequest(body, config);
        if (parsed.error) return sendError(res, ...parsed.error);
        const audio = await serial(() => synthesize(parsed.job, { env }));
        res.writeHead(200, { "content-type": CONTENT_TYPES[parsed.job.format], "content-length": audio.length });
        return res.end(audio);
      }
      return sendError(res, 404, "not_found", "Unknown path. Use POST /v1/audio/speech.");
    } catch (e) {
      if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message, e.retry);
      return sendError(res, 500, "server_error", "The server had an error.");
    }
  };
}

/** Starts the server on 127.0.0.1 and, when the computer has it, on ::1. */
export async function start({ port, token, config, env = process.env, log = console.log } = {}) {
  const handler = createHandler({ token, config, env, port });
  const servers = [];
  const listen = (host) =>
    new Promise((resolve, reject) => {
      const s = createServer(handler);
      s.requestTimeout = 330000;
      s.once("error", reject);
      s.listen(port, host, () => {
        servers.push(s);
        resolve(s);
      });
    });
  await listen("127.0.0.1");
  try {
    await listen("::1");
  } catch {
    // No IPv6 loopback on this computer.
  }
  log(`speech-endpoint ${VERSION}: http://127.0.0.1:${port}/v1 (default engine ${config.engine}, language ${config.language})`);
  const close = () =>
    Promise.all(
      servers.map(
        (s) =>
          new Promise((r) => {
            s.close(r);
            s.closeAllConnections?.();
          }),
      ),
    );
  return { servers, close };
}

// ---------------------------------------------------------------- command line

const USAGE = `speech-endpoint ${VERSION}: Vois Studio voices for apps that use the OpenAI speech API.

Usage:
  speech-endpoint start [--port ${DEFAULT_PORT}]   Start the server on this computer.
  speech-endpoint token [--new]            Show the token. --new makes a new token.
  speech-endpoint voices                   List the Vois Studio voices.
  speech-endpoint config                   Show the settings file and the settings.

Base URL: http://127.0.0.1:${DEFAULT_PORT}/v1   API key: the token.`;

async function main(argv) {
  const dir = configDir();
  const config = loadConfig(dir);
  const [cmd, ...rest] = argv;
  if (cmd === "start") {
    const i = rest.indexOf("--port");
    const port = i >= 0 ? Number(rest[i + 1]) : Number(config.port) || DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error("speech-endpoint: use a port from 1 to 65535.");
      return 2;
    }
    const token = loadToken(dir);
    await start({ port, token, config });
    console.log(`API key: run "speech-endpoint token". Stop the server with Ctrl-C.`);
    return null;
  }
  if (cmd === "token") {
    console.log(loadToken(dir, { renew: rest.includes("--new") }));
    return 0;
  }
  if (cmd === "voices") {
    const voices = await listVoices(process.env);
    console.log(JSON.stringify(voices, null, 2));
    return 0;
  }
  if (cmd === "config") {
    console.log(`Settings file: ${join(dir, "config.json")}`);
    console.log(JSON.stringify(config, null, 2));
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return 0;
  }
  console.log(USAGE);
  return cmd && cmd !== "help" && cmd !== "--help" ? 2 : 0;
}

let direct = false;
try {
  direct = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  direct = false;
}
if (direct) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== null) process.exitCode = code;
    },
    (e) => {
      console.error(`speech-endpoint: ${e.message}`);
      process.exitCode = 1;
    },
  );
}
