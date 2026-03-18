// Simple desktop backup agent for your storage app.
// Usage:
// 1) Create backup.config.json next to this file (see example below).
// 2) From this folder run: node backup-agent.js
//
// Example backup.config.json:
// {
//   "serverUrl": "http://localhost:3000",
//   "email": "you@example.com",
//   "password": "your-password",
//   "machineName": "PC1",
//   "paths": [
//     "C:\\\\Users\\\\you\\\\Documents",
//     "C:\\\\Users\\\\you\\\\Pictures"
//   ]
// }

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import FormData from "form-data";
import http from "http";
import https from "https";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.join(__dirname, "backup.config.json");

async function readConfig() {
  try {
    const raw = await fsp.readFile(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("Failed to read backup.config.json:", e.message || e);
    process.exit(1);
  }
}

function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + (u.search || ""),
        method: options.method || "GET",
        headers: options.headers || {}
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks)
          });
        });
      }
    );
    req.on("error", (err) => reject(err));
    if (body) {
      if (body instanceof Buffer || typeof body === "string") {
        req.write(body);
      } else {
        body.pipe(req);
        return;
      }
    }
    req.end();
  });
}

async function login(config) {
  const url = new URL("/auth/login", config.serverUrl).toString();
  const payload = JSON.stringify({
    email: config.email,
    password: config.password
  });
  const res = await makeRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload)
    }
  }, payload);
  if (res.status !== 200) {
    console.error("Login failed:", res.body.toString("utf8"));
    process.exit(1);
  }
  const setCookie = res.headers["set-cookie"];
  if (!setCookie || !setCookie.length) {
    console.error("No session cookie returned from login.");
    process.exit(1);
  }
  // Use the first cookie header
  const cookieHeader = setCookie.map((c) => c.split(";")[0]).join("; ");
  return cookieHeader;
}

async function* walkDir(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function uploadFile(config, cookie, localFile, baseLocalPath) {
  const stat = await fsp.stat(localFile);
  if (!stat.isFile()) return;

  // Build relative path and destination path inside the app
  const relLocal = path.relative(baseLocalPath, localFile).replace(/\\/g, "/");
  const destDir = `${config.machineName}/${path.basename(baseLocalPath)}/${path.dirname(relLocal)}`.replace(/\\/g, "/");

  const url = new URL(`/api/upload-cloud?path=${encodeURIComponent(destDir)}`, config.serverUrl).toString();

  const form = new FormData();
  form.append("files", fs.createReadStream(localFile), path.basename(localFile));

  const headers = form.getHeaders({ Cookie: cookie });

  console.log(`Uploading ${localFile} -> ${destDir}/${path.basename(localFile)}`);

  const res = await makeRequest(
    url,
    {
      method: "POST",
      headers
    },
    form
  );

  if (res.status !== 200) {
    console.error("Upload failed:", localFile, res.status, res.body.toString("utf8"));
  }
}

async function main() {
  const config = await readConfig();
  if (!Array.isArray(config.paths) || !config.paths.length) {
    console.error("No paths configured in backup.config.json");
    process.exit(1);
  }
  if (!config.machineName) {
    config.machineName = "PC";
  }

  console.log("Logging in to storage server...");
  const cookie = await login(config);

  for (const p of config.paths) {
    const abs = path.resolve(p);
    console.log(`Scanning ${abs} ...`);
    for await (const file of walkDir(abs)) {
      await uploadFile(config, cookie, file, abs);
    }
  }

  console.log("Backup run completed.");
}

main().catch((e) => {
  console.error("Backup agent failed:", e);
  process.exit(1);
});
