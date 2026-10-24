const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

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
const CHUNK_RADIUS = Number(process.env.CHUNK_RADIUS || 3);
const CONCURRENCY = Number(process.env.CONCURRENCY || 12);
const TELEPORT_MIN_DISTANCE = Number(process.env.TELEPORT_MIN_DISTANCE || 4);
const BUILD_DELAY_MS = Number(process.env.BUILD_DELAY_MS || 3000);
const SLAB_CANDIDATES = (process.env.SLAB_CANDIDATES || "minecraft:stone_slab,minecraft:stone_block_slab,minecraft:cobblestone_slab").split(",");
const STONE = process.env.STONE_BLOCK || "minecraft:stone";
const GLASS = process.env.GLASS_BLOCK || "minecraft:glass";
const MIN_FILL_Y = -64;
const MAX_FILL_Y = 319;
const MAX_FILL_HEIGHT = 128;
const KINDS = ["stone", "slab", "glass"];

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
    send(res, 200, "ok ws-v2");
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

const wss = new WebSocketServer({ server });
const sessions = new Set();

function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9_ ]/g, "").trim().slice(0, 24) || "Roblox";
}

function command(session, line) {
  return new Promise((resolve) => {
    if (session.ws.readyState !== 1) {
      resolve({ statusCode: -1, statusMessage: "closed" });
      return;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      session.responses.delete(id);
      resolve({ statusCode: -1, statusMessage: "timeout" });
    }, 8000);
    session.responses.set(id, (body) => {
      clearTimeout(timer);
      resolve(body || { statusCode: 0 });
    });
    session.ws.send(JSON.stringify({
      header: { version: 1, requestId: id, messageType: "commandRequest", messagePurpose: "commandRequest" },
      body: { version: 1, commandLine: line, origin: { type: "player" } }
    }));
  });
}

function buildCenter() {
  if (state.follow) return state.follow;
  if (state.players.length > 0) return state.players[0];
  return { x: 0, y: Y_OFFSET, z: 0 };
}

function pushBox(session, box, kind, probeKey) {
  for (let y = box[1]; y <= box[4]; y += MAX_FILL_HEIGHT) {
    const top = Math.min(y + MAX_FILL_HEIGHT - 1, box[4]);
    session.queue.push({ box: [box[0], y, box[2], box[3], top, box[5]], kind, probe: probeKey && y === box[1] ? probeKey : null });
  }
}

function enqueueChunk(session, cx, cz) {
  const key = cx + "," + cz;
  session.pending.add(key);
  const bx0 = cx * 16;
  const bz0 = cz * 16;
  const bx1 = bx0 + 15;
  const bz1 = bz0 + 15;
  pushBox(session, [bx0, MIN_FILL_Y, bz0, bx1, MAX_FILL_Y, bz1], "air", key);
  for (const op of state.ops) {
    const x0 = Math.max(op[0], bx0);
    const z0 = Math.max(op[2], bz0);
    const x1 = Math.min(op[3], bx1);
    const z1 = Math.min(op[5], bz1);
    if (x0 > x1 || z0 > z1) continue;
    pushBox(session, [x0, op[1], z0, x1, op[4], z1], KINDS[op[6]], null);
  }
  session.queue.push({ done: key, version: session.version });
}

function planChunks(session) {
  if (session.queue.length > 400) return;
  const center = buildCenter();
  const pcx = Math.floor(center.x / 16);
  const pcz = Math.floor(center.z / 16);
  const todo = [];
  for (let dx = -CHUNK_RADIUS; dx <= CHUNK_RADIUS; dx++) {
    for (let dz = -CHUNK_RADIUS; dz <= CHUNK_RADIUS; dz++) {
      const key = pcx + dx + "," + (pcz + dz);
      if (session.applied.get(key) === session.version || session.pending.has(key)) continue;
      todo.push({ cx: pcx + dx, cz: pcz + dz, d: dx * dx + dz * dz });
    }
  }
  todo.sort((a, b) => a.d - b.d);
  for (const chunk of todo) enqueueChunk(session, chunk.cx, chunk.cz);
}

function findSlab(session) {
  if (!session.slabPromise) {
    session.slabPromise = (async () => {
      const c = buildCenter();
      const x = Math.floor(c.x);
      const z = Math.floor(c.z);
      for (const candidate of SLAB_CANDIDATES) {
        const result = await command(session, "setblock " + x + " 310 " + z + " " + candidate);
        if (result.statusCode === 0) {
          await command(session, "setblock " + x + " 310 " + z + " minecraft:air");
          return candidate;
        }
      }
      return STONE;
    })();
  }
  return session.slabPromise;
}

async function runItem(session, item) {
  if (item.done) {
    session.pending.delete(item.done);
    if (session.failed.has(item.done)) {
      session.failed.delete(item.done);
    } else if (item.version === session.version) {
      session.applied.set(item.done, item.version);
    }
    return;
  }
  let id = "minecraft:air";
  if (item.kind === "stone") id = STONE;
  if (item.kind === "glass") id = GLASS;
  if (item.kind === "slab") id = await findSlab(session);
  const b = item.box;
  const result = await command(session, "fill " + b.join(" ") + " " + id);
  if (item.probe && result.statusCode !== 0 && /outside|unloaded|not loaded/i.test(String(result.statusMessage))) {
    session.failed.add(item.probe);
  }
}

async function pump(session) {
  if (session.pumping) return;
  session.pumping = true;
  try {
    while (session.queue.length > 0 && session.ws.readyState === 1) {
      const batch = session.queue.splice(0, CONCURRENCY);
      await Promise.all(batch.map((item) => runItem(session, item)));
    }
  } finally {
    session.pumping = false;
  }
}

function standCommands(session, online) {
  const wanted = new Map();
  if (online) {
    for (const p of state.players) wanted.set(p.id, p);
  }
  const lines = [];
  for (const [id, name] of [...session.stands.entries()]) {
    if (!wanted.has(id)) {
      lines.push({ line: 'kill @e[type=armor_stand,tag=rbx,name="' + name + '"]' });
      session.stands.delete(id);
    }
  }
  for (const [id, p] of wanted) {
    const name = safeName(p.name);
    if (!session.stands.has(id)) {
      session.stands.set(id, name);
      lines.push({ line: 'summon armor_stand "' + name + '" ' + p.x + " " + p.y + " " + p.z });
      lines.push({ line: 'tag @e[type=armor_stand,name="' + name + '",tag=!rbx] add rbx' });
    } else {
      lines.push({ line: 'tp @e[type=armor_stand,tag=rbx,name="' + name + '"] ' + p.x + " " + p.y + " " + p.z, standId: id });
    }
  }
  return lines;
}

async function tick(session) {
  if (session.ws.readyState !== 1 || state.lastSeen === 0) return;
  const online = Date.now() - state.lastSeen < OFFLINE_AFTER_MS;
  if (session.version !== state.wv) {
    session.version = state.wv;
    session.queue.length = 0;
    session.pending.clear();
    session.failed.clear();
  }
  if (online && state.follow) {
    const f = state.follow;
    const r = TELEPORT_MIN_DISTANCE;
    command(session, "execute as @a unless entity @s[x=" + f.x + ",y=" + f.y + ",z=" + f.z + ",r=" + r + "] run tp @s " + f.x + " " + f.y + " " + f.z);
  }
  const messages = chat.filter((m) => m.id > session.chatId);
  for (const m of messages) {
    const text = "\u00a7e[Roblox] \u00a7f" + m.name + "\u00a77: \u00a7f" + m.message;
    command(session, "tellraw @a " + JSON.stringify({ rawtext: [{ text }] }));
    session.chatId = m.id;
  }
  for (const entry of standCommands(session, online)) {
    command(session, entry.line).then((result) => {
      if (entry.standId && result.statusCode !== 0) session.stands.delete(entry.standId);
    });
  }
  if (Date.now() >= session.buildAfter) {
    planChunks(session);
    pump(session);
  }
}

server.on("upgrade", (req) => {
  console.log("Intento WebSocket: " + req.url + " ua=" + (req.headers["user-agent"] || "-"));
});

wss.on("error", (error) => {
  console.log("Error wss: " + error.message);
});

wss.on("connection", (ws) => {
  const session = {
    ws,
    responses: new Map(),
    queue: [],
    pending: new Set(),
    failed: new Set(),
    applied: new Map(),
    stands: new Map(),
    version: -1,
    chatId: chatSeq,
    slabPromise: null,
    pumping: false,
    buildAfter: Date.now() + BUILD_DELAY_MS
  };
  sessions.add(session);
  console.log("Minecraft conectado");
  command(session, "kill @e[type=armor_stand,tag=rbx]");
  command(session, 'tellraw @a {"rawtext":[{"text":"\u00a7a[Roblox Bridge] conectado"}]}');
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const id = msg && msg.header && msg.header.requestId;
      if (msg.header.messagePurpose === "commandResponse" && id && session.responses.has(id)) {
        const done = session.responses.get(id);
        session.responses.delete(id);
        done(msg.body);
      }
    } catch (error) {}
  });
  ws.on("close", (code, reason) => {
    sessions.delete(session);
    console.log("Minecraft desconectado code=" + code + " motivo=" + reason.toString());
  });
  ws.on("error", (error) => {
    console.log("Error ws: " + error.message);
  });
});

setInterval(() => {
  for (const session of sessions) {
    tick(session).catch(() => {});
  }
}, 1000);

server.listen(PORT, () => {
  console.log("Bridge ws-v2 escuchando en " + PORT);
});
