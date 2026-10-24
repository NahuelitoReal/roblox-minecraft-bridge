const http = require("http");

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.TOKEN || "";
const Y_OFFSET = Number(process.env.Y_OFFSET || 64);
const SCALE = Number(process.env.SCALE || 1);
const SLAB_MAX_HEIGHT = Number(process.env.SLAB_MAX_HEIGHT || 1.5);
const GLASS_MIN_TRANSPARENCY = Number(process.env.GLASS_MIN_TRANSPARENCY || 0.25);
const FEET_OFFSET = Number(process.env.FEET_OFFSET || 3);
const OFFLINE_AFTER_MS = Number(process.env.OFFLINE_AFTER_MS || 15000);
const MIN_Y = -64;
const MAX_Y = 319;
const MAX_BODY = 8 * 1024 * 1024;
const CHAT_KEEP = 200;

const IGNORED = new Set(["Terrain", "Camera", "Handle", "HumanoidRootPart", "Head", "Torso", "UpperTorso", "LowerTorso"]);
const LIMB = /^(Left|Right) ?(Upper|Lower)?(Arm|Leg|Hand|Foot)$/;

const state = {
  lastSeen: 0,
  players: [],
  follow: null,
  ops: [],
  signature: "",
  wv: 0
};

let chat = [];
let chatSeq = 0;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function convertPart(part) {
  if (!part || !part.position || !part.size) return null;
  if (IGNORED.has(part.name) || LIMB.test(String(part.name))) return null;
  const sx = part.size.x * SCALE;
  const sy = part.size.y * SCALE;
  const sz = part.size.z * SCALE;
  if (!(sx > 0 && sy > 0 && sz > 0)) return null;
  const cx = part.position.x * SCALE;
  const cy = part.position.y * SCALE + Y_OFFSET;
  const cz = part.position.z * SCALE;
  const x0 = Math.round(cx - sx / 2);
  const x1 = Math.max(x0, Math.round(cx + sx / 2) - 1);
  const z0 = Math.round(cz - sz / 2);
  const z1 = Math.max(z0, Math.round(cz + sz / 2) - 1);
  let y0 = Math.round(cy - sy / 2);
  let y1 = Math.max(y0, Math.round(cy + sy / 2) - 1);
  let kind = 0;
  if (Number(part.transparency || 0) >= GLASS_MIN_TRANSPARENCY) {
    kind = 2;
  } else if (sy < SLAB_MAX_HEIGHT) {
    kind = 1;
    y1 = y0;
  }
  y0 = Math.max(MIN_Y, y0);
  y1 = Math.min(MAX_Y, y1);
  if (y0 > y1) return null;
  return [x0, y0, z0, x1, y1, z1, kind];
}

function convertPlayer(p) {
  if (!p || !p.position) return null;
  return {
    id: String(p.userId),
    username: String(p.name || ""),
    name: String(p.displayName || p.name || "Roblox"),
    x: round2(p.position.x * SCALE),
    y: round2(p.position.y * SCALE - FEET_OFFSET + Y_OFFSET),
    z: round2(p.position.z * SCALE)
  };
}

function handleSnapshot(body) {
  state.lastSeen = Date.now();
  const follow = String(body.follow || "");
  const all = (Array.isArray(body.players) ? body.players : []).map(convertPlayer).filter(Boolean);
  const followed = all.find((p) => p.username === follow || p.name === follow) || null;
  state.players = all.filter((p) => p !== followed).map((p) => ({ id: p.id, name: p.name, x: p.x, y: p.y, z: p.z }));
  state.follow = followed ? { x: followed.x, y: followed.y, z: followed.z } : null;
  const ops = (Array.isArray(body.parts) ? body.parts : []).map(convertPart).filter(Boolean).sort((a, b) => a[6] - b[6]);
  const signature = JSON.stringify(ops);
  if (signature !== state.signature) {
    state.signature = signature;
    state.ops = ops;
    state.wv = Math.max(Date.now(), state.wv + 1);
  }
}

function handleChat(body) {
  const message = String(body.message || "").slice(0, 256);
  if (!message) return;
  chatSeq += 1;
  chat.push({ id: chatSeq, name: String(body.displayName || body.name || "Roblox").slice(0, 40), message });
  if (chat.length > CHAT_KEEP) chat = chat.slice(-CHAT_KEEP);
}

function buildState(query) {
  const wv = Number(query.get("wv"));
  const since = Number(query.get("chat"));
  const online = state.lastSeen > 0 && Date.now() - state.lastSeen < OFFLINE_AFTER_MS;
  const messages = since < 0 ? [] : chat.filter((m) => m.id > since);
  return {
    online,
    wv: state.wv,
    ops: state.lastSeen > 0 && wv !== state.wv ? state.ops : null,
    players: online ? state.players : [],
    follow: online ? state.follow : null,
    chat: messages,
    chatId: chatSeq
  };
}

function send(res, status, payload) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": typeof payload === "string" ? "text/plain" : "application/json" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health" || url.pathname === "/") {
    send(res, 200, "ok");
    return;
  }
  if (TOKEN && req.headers["x-token"] !== TOKEN) {
    send(res, 401, "unauthorized");
    return;
  }
  try {
    if (req.method === "GET" && url.pathname === "/state") {
      send(res, 200, buildState(url.searchParams));
      return;
    }
    if (req.method === "POST" && url.pathname === "/snapshot") {
      handleSnapshot(await readBody(req));
      send(res, 200, { ok: true, parts: state.ops.length, players: state.players.length });
      return;
    }
    if (req.method === "POST" && url.pathname === "/chat") {
      handleChat(await readBody(req));
      send(res, 200, { ok: true });
      return;
    }
    send(res, 404, "not found");
  } catch (error) {
    send(res, 400, "bad request");
  }
});

server.listen(PORT, () => {
  console.log("Bridge escuchando en " + PORT);
});
