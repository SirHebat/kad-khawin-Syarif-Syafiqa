/**
 * Local static + RSVP API server for the wedding invitation.
 * Loads .env, serves the HTML/assets, and handles POST /api/rsvp.
 *
 * Usage: npm run dev
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleRsvpPost, handleRsvpGet } from "./api/rsvp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = __dirname;
const ROOT = path.join(__dirname, "public");
const PORT = Number(process.env.PORT) || 3000;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(PROJECT_ROOT, ".env"));
loadEnvFile(path.join(PROJECT_ROOT, ".env.local"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent((urlPath || "/").split("?")[0]);
  const cleaned = decoded.replace(/^\/+/, "");
  const candidate = path.normalize(path.join(root, cleaned || ""));
  if (!candidate.startsWith(root)) return null;
  return candidate;
}

async function serveStatic(req, res) {
  let urlPath = (req.url || "/").split("?")[0];
  if (urlPath === "/") {
    urlPath = "/index.html";
  }

  const filePath = safeJoin(ROOT, urlPath);
  if (!filePath) {
    return send(res, 403, "Forbidden");
  }

  let target = filePath;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = path.join(target, "index.html");
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return send(res, 404, "Not found");
  }

  const ext = path.extname(target).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const data = fs.readFileSync(target);
  return send(res, 200, data, {
    "Content-Type": type,
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (urlPath === "/api/rsvp") {
    if (req.method === "OPTIONS") {
      return send(res, 204, "", {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
    }
    if (req.method === "GET") {
      return handleRsvpGet(res);
    }
    if (req.method !== "POST") {
      return send(
        res,
        405,
        JSON.stringify({ ok: false, message: "Method not allowed." }),
        { "Content-Type": "application/json; charset=utf-8" }
      );
    }
    try {
      const body = await readBody(req);
      return handleRsvpPost(body, res);
    } catch (err) {
      return send(
        res,
        400,
        JSON.stringify({
          ok: false,
          message: err.message || "Permintaan tidak sah.",
        }),
        { "Content-Type": "application/json; charset=utf-8" }
      );
    }
  }

  if (req.method === "GET" || req.method === "HEAD") {
    return serveStatic(req, res);
  }

  return send(res, 405, "Method not allowed");
});

server.listen(PORT, () => {
  console.log(`Wedding invite server → http://localhost:${PORT}`);
  console.log(`RSVP API              → GET/POST http://localhost:${PORT}/api/rsvp`);
});
