#!/usr/bin/env node
/**
 * JPC 発表タイマー 同期サーバー
 *  - 依存パッケージなし（Node.js 18+ のみ）
 *  - 同じURLを開いた全員が、ホストの操作どおりのカウントダウンを見られる
 *  - 仕組み: Server-Sent Events（/api/events）で状態を配信、/api/state で取得・更新
 *
 * 使い方:
 *   node server.js            # → http://localhost:8080
 *   PORT=3000 node server.js
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = parseInt(process.env.PORT || "8080", 10);
const ROOT = __dirname;

/* ---------------- 状態管理（ルーム単位） --------------- */
const rooms = new Map();   // room -> {rev, state, at}
const clients = new Map(); // room -> Set(res)

function getRoom(room) {
  if (!rooms.has(room)) rooms.set(room, { rev: 0, state: null, updatedAt: 0 });
  return rooms.get(room);
}
function getClients(room) {
  if (!clients.has(room)) clients.set(room, new Set());
  return clients.get(room);
}

function send(res, obj) {
  res.write("data: " + JSON.stringify(obj) + "\n\n");
}

function broadcast(room) {
  const r = getRoom(room);
  const payload = { rev: r.rev, ...r.state };
  for (const res of getClients(room)) {
    try { send(res, payload); } catch (e) { /* ignore */ }
  }
}

/* ---------------- HTTP --------------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8"
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error("too large")); req.destroy(); return; }
      buf += c;
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, "http://" + (req.headers.host || "localhost")); }
  catch (e) { res.writeHead(400); res.end("bad request"); return; }

  const room = (url.searchParams.get("room") || "main").slice(0, 40).replace(/[^\w-]/g, "") || "main";

  /* ---- API: 現在の状態（参加時に取得） ---- */
  if (url.pathname === "/api/state") {
    const r = getRoom(room);
    if (req.method === "POST") {
      let body;
      try { body = JSON.parse(await readBody(req) || "{}"); }
      catch (e) { res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"invalid json"}'); return; }

      // 許可するキーだけ取り込む
      const st = {
        stage: String(body.stage || "talk"),
        running: !!body.running,
        endAt: Number(body.endAt) || 0,
        remain: Number(body.remain) || 0,
        warned: !!body.warned,
        limitHit: !!body.limitHit,
        advanceAt: Number(body.advanceAt) || 0,
        talk: Number(body.talk) || 120,
        over: Number(body.over) || 0,
        qa: Number(body.qa) || 120,
        chime: body.chime !== false,
        name: String(body.name || "").slice(0, 60)
      };
      r.rev += 1;
      r.state = st;
      r.updatedAt = Date.now();
      broadcast(room);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, rev: r.rev, now: Date.now() }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      now: Date.now(),
      rev: r.rev,
      state: r.state ? { rev: r.rev, ...r.state } : null
    }));
    return;
  }

  /* ---- API: 状態の購読（SSE） ---- */
  if (url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("retry: 2000\n\n");

    const r = getRoom(room);
    if (r.state) send(res, { rev: r.rev, ...r.state });

    const set = getClients(room);
    set.add(res);

    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 20000);

    const cleanup = () => { clearInterval(ping); set.delete(res); };
    req.on("close", cleanup);
    req.on("error", cleanup);
    return;
  }

  /* ---- 静的ファイル ---- */
  let p = decodeURIComponent(url.pathname);
  if (p === "/" || p === "") p = "/index.html";
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("404 not found"); return; }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const k of Object.keys(nets)) {
    for (const ni of nets[k] || []) {
      if (ni.family === "IPv4" && !ni.internal) ips.push(ni.address);
    }
  }
  console.log("");
  console.log("  JPC 発表タイマー 同期サーバー起動");
  console.log("  ────────────────────────────────────────");
  console.log("   操作（ホスト） : http://localhost:" + PORT);
  for (const ip of ips) {
    console.log("   操作（会場LAN） : http://" + ip + ":" + PORT);
    console.log("   観覧（会場LAN） : http://" + ip + ":" + PORT + "/?view=1");
  }
  console.log("");
  console.log("  観覧用は ?view=1 を付けるとボタンが消え、カウントダウンだけになります。");
  console.log("  終了は Ctrl+C");
  console.log("");
});
