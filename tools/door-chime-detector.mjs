#!/usr/bin/env node
// Entrance walk-ins: listens to the Corner Deli counter camera (Dahua IPC-HDW4433C-A, 192.168.8.209) and
// tells the app when a customer walks in through the front door. The camera does the line-crossing detection
// itself; this only relays its alarm events to POST /api/cron/door-chime, which records them for the store
// dashboard's time-to-first-interaction card (see docs/PROCESS-MAP.md).
//
//   node tools/door-chime-detector.mjs           listen and relay (runs until stopped)
//   node tools/door-chime-detector.mjs --probe   show the device type, channels and its detection rules
//   node tools/door-chime-detector.mjs --test    send one test event to the app (not counted on the dashboard)
//
// Camera settings: /opt/corner-ops/config/door-camera.env (never committed)
//   DOOR_CAMERA_USER, DOOR_CAMERA_PASS   a view-only camera account
//   DOOR_CAMERA_HOST=192.168.8.209      DOOR_CAMERA_PORT=80
//   DOOR_CAMERA_CHANNEL=1               recorder camera number for the door (1-based; blank = any)
//   DOOR_CAMERA_CODES=CrossLineDetection,CrossRegionDetection   which camera alerts count as a walk-in
//   DOOR_CAMERA_DIRECTION=              e.g. LeftToRight: only that tripwire direction counts as walking in
//   DOOR_CHIME_BUSINESS="Corner Deli"   DOOR_CHIME_CAMERA=entrance
//   DOOR_CHIME_APP_URL=http://127.0.0.1:3000
// CRON_SECRET comes from /opt/corner-ops/.env, like deploy/run-cron.sh.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";

const ROOT = process.env.CORNER_OPS_ROOT || "/opt/corner-ops";
// Matches DOOR_CHIME_COOLDOWN_SECONDS in src/lib/door-chime-policy.ts (the app enforces it too).
const COOLDOWN_MS = 45_000;

function readEnvFile(path) {
  const values = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return values;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return values;
}

const cameraEnv = { ...readEnvFile(process.env.DOOR_CAMERA_ENV || `${ROOT}/config/door-camera.env`), ...process.env };
const config = {
  host: cameraEnv.DOOR_CAMERA_HOST || "192.168.8.209",
  port: Number(cameraEnv.DOOR_CAMERA_PORT || 80),
  user: cameraEnv.DOOR_CAMERA_USER || "",
  pass: cameraEnv.DOOR_CAMERA_PASS || "",
  channel: cameraEnv.DOOR_CAMERA_CHANNEL ? Number(cameraEnv.DOOR_CAMERA_CHANNEL) : null,
  codes: (cameraEnv.DOOR_CAMERA_CODES || "CrossLineDetection,CrossRegionDetection")
    .split(",").map((code) => code.trim()).filter(Boolean),
  direction: cameraEnv.DOOR_CAMERA_DIRECTION || "",
  business: cameraEnv.DOOR_CHIME_BUSINESS || "Corner Deli",
  camera: cameraEnv.DOOR_CHIME_CAMERA || "entrance",
  appUrl: (cameraEnv.DOOR_CHIME_APP_URL || "http://127.0.0.1:3000").replace(/\/$/, ""),
  secret: process.env.CRON_SECRET || readEnvFile(`${ROOT}/.env`).CRON_SECRET || "",
};

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

// --- HTTP digest auth (Dahua devices accept nothing else) ---------------------------------------------
const md5 = (value) => createHash("md5").update(value).digest("hex");

function digestAuthorization(method, path, challenge, nc) {
  const params = {};
  for (const [, key, quoted, bare] of challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) params[key] = quoted ?? bare;
  const cnonce = randomBytes(8).toString("hex");
  const count = nc.toString(16).padStart(8, "0");
  const ha1 = md5(`${config.user}:${params.realm}:${config.pass}`);
  const ha2 = md5(`${method}:${path}`);
  const qop = params.qop ? "auth" : "";
  const response = qop
    ? md5(`${ha1}:${params.nonce}:${count}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${params.nonce}:${ha2}`);
  return [
    `Digest username="${config.user}"`, `realm="${params.realm}"`, `nonce="${params.nonce}"`, `uri="${path}"`,
    `response="${response}"`, params.opaque ? `opaque="${params.opaque}"` : "",
    qop ? `qop=${qop}, nc=${count}, cnonce="${cnonce}"` : "",
  ].filter(Boolean).join(", ");
}

/** GET with digest auth; resolves with the (still streaming) response. */
function cameraGet(path, { timeoutMs = 10_000 } = {}) {
  const send = (authorization) => new Promise((resolve, reject) => {
    const request = http.get({ host: config.host, port: config.port, path, headers: authorization ? { authorization } : {} }, resolve);
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`camera did not answer within ${timeoutMs / 1000}s`)));
    request.on("error", reject);
  });
  return send(null).then((first) => {
    if (first.statusCode !== 401) return first;
    first.resume();
    const challenge = String(first.headers["www-authenticate"] || "");
    if (!/^Digest/i.test(challenge)) throw new Error("camera asked for an unsupported login type");
    return send(digestAuthorization("GET", path, challenge, 1));
  });
}

async function cameraText(path) {
  const response = await cameraGet(path);
  let body = "";
  for await (const chunk of response) body += chunk;
  if (response.statusCode !== 200) throw new Error(`${path} → HTTP ${response.statusCode}${body ? `: ${body.trim().slice(0, 120)}` : ""}`);
  return body.trim();
}

// --- App -------------------------------------------------------------------------------------------
async function notifyApp(kind) {
  const response = await fetch(`${config.appUrl}/api/cron/door-chime`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.secret}`, "content-type": "application/json" },
    body: JSON.stringify({ business: config.business, camera: config.camera, kind }),
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`app answered HTTP ${response.status}: ${body.error || ""}`);
  return body;
}

// --- Event stream ----------------------------------------------------------------------------------
const KINDS = { CrossLineDetection: "line_crossing", CrossRegionDetection: "person", SmartMotionHuman: "person", VideoMotion: "motion" };

/** Parses one multipart body like `Code=CrossLineDetection;action=Start;index=0;data={...}`. */
export function parseEvent(text) {
  const match = text.match(/Code=([^;\s]+);action=([^;\s]+);index=(\d+)(?:;data=([\s\S]*))?/);
  if (!match) return null;
  let data = {};
  try {
    data = match[4] ? JSON.parse(match[4].trim()) : {};
  } catch {
    data = {};
  }
  return { code: match[1], action: match[2], index: Number(match[3]), data };
}

let lastChime = 0;
let connectedAt = 0;

async function handleEvent(event) {
  if (event.action !== "Start" && event.action !== "Pulse") return;
  if (!config.codes.includes(event.code)) return;
  if (config.channel !== null && event.index !== config.channel - 1) return;
  const direction = event.data.Direction || "";
  if (config.direction && direction && direction !== config.direction) {
    log(`ignored ${event.code} going ${direction} (someone leaving)`);
    return;
  }
  if (Date.now() - lastChime < COOLDOWN_MS) return;
  lastChime = Date.now();
  try {
    const result = await notifyApp(KINDS[event.code] || "person");
    log(`walk-in: ${event.code} on camera ${event.index + 1}${direction ? ` going ${direction}` : ""} → ${result.recorded ? "recorded" : "within cooldown"}`);
  } catch (error) {
    log(`walk-in seen but the app could not be told: ${error.message}`);
  }
}

async function listen() {
  const codes = config.codes.join(",");
  // Ask for every alert and filter here, so an alert type this firmware doesn't have can't affect the
  // subscription.
  const path = "/cgi-bin/eventManager.cgi?action=attach&codes=%5BAll%5D&heartbeat=10";
  const response = await cameraGet(path, { timeoutMs: 35_000 });
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`event stream refused: HTTP ${response.statusCode}${response.statusCode === 401 ? " (check the camera login)" : ""}`);
  }
  // This camera sends nothing (not even the requested heartbeat) while no one crosses the line, so a quiet
  // stream is normal: drop the idle timeout and let TCP keepalive notice a camera that has really gone away.
  response.socket.setTimeout(0);
  response.socket.setKeepAlive(true, 15_000);
  connectedAt = Date.now();
  const boundary = String(response.headers["content-type"] || "").match(/boundary=([^;\s]+)/)?.[1] || "myboundary";
  const separator = `--${boundary.replace(/^--/, "")}`;
  log(`listening to ${config.host} for ${codes}${config.channel ? ` on camera ${config.channel}` : ""}`);
  let buffer = "";
  response.setEncoding("utf8");
  for await (const chunk of response) {
    buffer += chunk;
    const parts = buffer.split(separator);
    buffer = parts.pop() || "";
    for (const part of parts) {
      // This firmware puts "Code=..." straight after Content-Length with no blank line, so look for it
      // anywhere in the part rather than after the headers.
      const event = parseEvent(part);
      if (event) await handleEvent(event);
    }
  }
  throw new Error("camera closed the event stream");
}

async function probe() {
  const lines = [];
  for (const [label, path] of [
    ["Device type", "/cgi-bin/magicBox.cgi?action=getDeviceType"],
    ["Software", "/cgi-bin/magicBox.cgi?action=getSoftwareVersion"],
    ["Channels", "/cgi-bin/devVideoInput.cgi?action=getCollect"],
    ["Event types", "/cgi-bin/eventManager.cgi?action=getExposureEvents"],
    ["Detection rules", "/cgi-bin/configManager.cgi?action=getConfig&name=VideoAnalyseRule"],
    ["Smart motion", "/cgi-bin/configManager.cgi?action=getConfig&name=SmartMotionDetect"],
  ]) {
    try {
      const text = await cameraText(path);
      const shown = label === "Detection rules"
        ? text.split("\n").filter((line) => /\.(Name|Type|Enable|Config\.Direction)=/.test(line)).join("\n") || "(none)"
        : text.slice(0, 1500);
      lines.push(`== ${label}\n${shown}`);
    } catch (error) {
      lines.push(`== ${label}\n(unavailable: ${error.message})`);
    }
  }
  console.log(lines.join("\n\n"));
}

async function main() {
  const mode = process.argv[2] || "";
  if (mode === "--test") {
    if (!config.secret) throw new Error(`CRON_SECRET is not set in ${ROOT}/.env`);
    console.log(await notifyApp("test"));
    return;
  }
  if (!config.user || !config.pass) throw new Error(`Set DOOR_CAMERA_USER and DOOR_CAMERA_PASS in ${ROOT}/config/door-camera.env`);
  if (mode === "--probe") return probe();
  if (!config.secret) throw new Error(`CRON_SECRET is not set in ${ROOT}/.env`);
  let delay = 2_000;
  for (;;) {
    const started = Date.now();
    try {
      await listen();
    } catch (error) {
      log(`${error.message}; reconnecting in ${delay / 1000}s`);
    }
    // Back off only while the camera can't be reached; a stream that was up reconnects at once.
    if (connectedAt >= started) delay = 2_000;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 60_000);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
