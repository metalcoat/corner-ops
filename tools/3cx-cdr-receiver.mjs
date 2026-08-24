import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const FIELDS = (process.env.CDR_FIELDS || [
  "historyid", "callid", "duration", "time-start", "time-answered", "time-end",
  "reason-terminated", "from-no", "to-no", "from-dn", "to-dn", "dial-no",
  "reason-changed", "final-number", "final-dn", "chain", "from-type", "to-type",
  "final-type", "from-dispname", "to-dispname", "final-dispname", "missed-queue-calls",
].join(",")).split(",").map((value) => value.trim()).filter(Boolean);

const MODE = (process.env.CDR_MODE || "connect").toLowerCase();
const HOST = process.env.CDR_HOST || "127.0.0.1";
const PORT = Number(process.env.CDR_PORT || 5483);
const DELIMITER = (process.env.CDR_DELIMITER || ",").replace("\\t", "\t");
const CORNER_OPS_URL = String(process.env.CORNER_OPS_URL || "").replace(/\/$/, "");
const SECRET = process.env.CORNER_OPS_CDR_SECRET || "";
const VERCEL_BYPASS = process.env.VERCEL_PROTECTION_BYPASS || "";
const SPOOL = process.env.CDR_SPOOL_FILE || path.resolve("3cx-cdr-spool.jsonl");
const INVALID_SPOOL = `${SPOOL}.invalid`;
const RECONNECT_MS = Math.max(1000, Number(process.env.CDR_RECONNECT_MS || 5000));

if (!CORNER_OPS_URL || !/^https:\/\//i.test(CORNER_OPS_URL)) throw new Error("CORNER_OPS_URL must be an HTTPS Corner Ops address.");
if (!SECRET) throw new Error("CORNER_OPS_CDR_SECRET is required.");
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("CDR_PORT is invalid.");
if ([...DELIMITER].length !== 1) throw new Error("CDR_DELIMITER must resolve to exactly one character.");
if (!FIELDS.length) throw new Error("CDR_FIELDS must contain at least one field.");

function parseDelimitedLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (!quoted && char === DELIMITER) {
      values.push(value);
      value = "";
    } else value += char;
  }
  if (quoted) throw new Error("CDR line ended inside a quoted field.");
  values.push(value);
  if (values.length !== FIELDS.length) {
    throw new Error(`CDR field count mismatch: expected ${FIELDS.length}, received ${values.length}.`);
  }
  return Object.fromEntries(FIELDS.map((field, index) => [field, values[index]]));
}

async function postRecord(record) {
  const headers = { "content-type": "application/json", "x-corner-ops-cdr-secret": SECRET };
  if (VERCEL_BYPASS) headers["x-vercel-protection-bypass"] = VERCEL_BYPASS;
  const response = await fetch(`${CORNER_OPS_URL}/api/3cx/inbound`, {
    method: "POST",
    headers,
    body: JSON.stringify({ record }),
  });
  if (!response.ok) throw new Error(`Corner Ops returned ${response.status}: ${await response.text()}`);
}

function spool(record) {
  fs.appendFileSync(SPOOL, `${JSON.stringify(record)}\n`, "utf8");
}

function spoolInvalidLine(line, error) {
  fs.appendFileSync(INVALID_SPOOL, `${JSON.stringify({
    receivedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    line,
  })}\n`, "utf8");
}
let chain = Promise.resolve();
function acceptLine(raw) {
  const line = raw.replace(/\0/g, "").trim();
  if (!line) return;
  let record;
  try {
    record = parseDelimitedLine(line);
  } catch (error) {
    console.error(new Date().toISOString(), "Rejected malformed CDR line:", error instanceof Error ? error.message : String(error));
    spoolInvalidLine(line, error);
    return;
  }
  chain = chain.then(() => postRecord(record)).catch((error) => {
    console.error(new Date().toISOString(), "CDR forward failed:", error.message);
    spool(record);
  });
}

function attach(socket) {
  socket.setKeepAlive(true, 30_000);
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) acceptLine(line);
  });
  socket.on("close", () => { if (MODE === "connect") setTimeout(connect, RECONNECT_MS); });
  socket.on("error", (error) => console.error(new Date().toISOString(), "CDR socket error:", error.message));
}

function connect() {
  console.log(new Date().toISOString(), `Connecting to 3CX passive CDR socket ${HOST}:${PORT}`);
  const socket = net.createConnection({ host: HOST, port: PORT }, () => console.log(new Date().toISOString(), "Connected to 3CX CDR."));
  attach(socket);
}

async function retrySpool() {
  if (!fs.existsSync(SPOOL)) return;
  const lines = fs.readFileSync(SPOOL, "utf8").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return;
  const remaining = [];
  for (const line of lines) {
    try { await postRecord(JSON.parse(line)); }
    catch { remaining.push(line); }
  }
  if (remaining.length) fs.writeFileSync(SPOOL, `${remaining.join("\n")}\n`, "utf8");
  else fs.rmSync(SPOOL, { force: true });
}

setInterval(() => retrySpool().catch((error) => console.error("Spool retry failed:", error.message)), 60_000).unref();
retrySpool().catch(() => undefined);

if (MODE === "listen") {
  const server = net.createServer(attach);
  server.listen(PORT, HOST === "127.0.0.1" ? "0.0.0.0" : HOST, () => console.log(new Date().toISOString(), `Listening for 3CX active CDR socket on port ${PORT}`));
} else if (MODE === "connect") connect();
else throw new Error("CDR_MODE must be connect or listen.");
