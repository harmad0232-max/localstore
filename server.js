import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import fsp from "fs/promises";
import mime from "mime-types";
import archiver from "archiver";
import unzipper from "unzipper";
import { createProvider } from "./storage/provider.js";
import session from "express-session";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import os from "os";
import Stripe from "stripe";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const requestedPort = process.env.PORT ? Number(process.env.PORT) : null;
const port = Number.isFinite(requestedPort) ? requestedPort : 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax" }
  })
);

app.use(passport.initialize());
app.use(passport.session());

const MAX_FILES = 10000; // Increased limit
const MAX_TOTAL_BYTES = 100 * 1024 * 1024 * 1024; // 100 GB
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${path.basename(file.originalname)}`)
  }),
  limits: { files: MAX_FILES, fileSize: MAX_TOTAL_BYTES }
});

const restoreUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${path.basename(file.originalname)}`)
  }),
  limits: { fileSize: MAX_TOTAL_BYTES }
});

const restoreTempBackups = new Map();
const RESTORE_TEMP_TTL_MS = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [token, rec] of restoreTempBackups.entries()) {
    if (!rec || now - rec.createdAt > RESTORE_TEMP_TTL_MS) {
      restoreTempBackups.delete(token);
      if (rec?.filePath) fs.unlink(rec.filePath, () => {});
    }
  }
}, 60 * 1000).unref?.();

function sanitizeZipRel(p) {
  const raw = String(p || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = raw.split("/").filter(Boolean);
  const safe = [];
  for (const part of parts) {
    if (part === "." || part === "..") continue;
    safe.push(part);
  }
  return safe.join("/");
}

function normalizeRestoreSelection(sel) {
  const clean = sanitizeZipRel(sel);
  if (!clean) return "";
  return String(sel || "").endsWith("/") ? `${clean.replace(/\/+$/, "")}/` : clean;
}

function norm(p) {
  if (!p) return "";
  const clean = path.normalize(p).replace(/^(\.\.(\/|\\|$))+/g, "");
  return clean.replace(/^(\.|\/|\\)+/, "");
}

async function ensureDirTree(provider, dir) {
  if (!provider || typeof provider.ensureDir !== "function") return;
  const rel = String(dir || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!rel) return;
  const parts = rel.split("/").filter(Boolean);
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    await provider.ensureDir(acc);
  }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

ensureDir(path.join(__dirname, "data"));
ensureDir(path.join(__dirname, "data", "users"));
ensureDir(path.join(__dirname, "public"));

const usersPath = path.join(__dirname, "data", "users.json");
const sharesPath = path.join(__dirname, "data", "shares.json");

async function readUsers() {
  try {
    const raw = await fsp.readFile(usersPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
}

async function writeUsers(users) {
  await fsp.writeFile(usersPath, JSON.stringify(users, null, 2), "utf8");
}

async function getUserRecordById(userId) {
  const users = await readUsers();
  return users.find((u) => u.id === userId) || null;
}

function readDefaultQuotaBytes() {
  const gb = process.env.DEFAULT_USER_QUOTA_GB ? Number(process.env.DEFAULT_USER_QUOTA_GB) : 10;
  const safeGb = Number.isFinite(gb) && gb > 0 ? gb : 10;
  return Math.floor(safeGb * 1024 * 1024 * 1024);
}

function getUserQuotaBytes(user) {
  const q = Number(user?.quotaBytes);
  if (Number.isFinite(q) && q > 0) return Math.floor(q);
  return readDefaultQuotaBytes();
}

async function computeUserUsageBytes(provider, baseDir = "") {
  const maxNodes = 20000;
  let nodes = 0;
  let total = 0;
  const stack = [baseDir || ""];
  while (stack.length) {
    const dir = stack.pop();
    if (dir == null) break;
    const items = await provider.list(dir);
    for (const it of items || []) {
      nodes++;
      if (nodes > maxNodes) return total;
      const p = dir ? `${dir}/${it.name}` : it.name;
      if (it.type === "dir") {
        stack.push(p);
      } else if (it.type === "file") {
        total += Number(it.size || 0);
      }
    }
  }
  return total;
}

function isAdminRequest(req) {
  const configured = String(process.env.ADMIN_TOKEN || "").trim();
  if (!configured) return false;
  const token = String(req.headers["x-admin-token"] || "").trim();
  return token && token === configured;
}

async function readShares() {
  try {
    const raw = await fsp.readFile(sharesPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
}

async function writeShares(shares) {
  await fsp.writeFile(sharesPath, JSON.stringify(shares, null, 2), "utf8");
}

async function collectEntries(provider, baseDir = "") {
  const result = [];
  const stack = [baseDir || ""];
  const maxNodes = 50000;
  let nodes = 0;
  
  while (stack.length > 0) {
    const dir = stack.pop();
    const items = await provider.list(dir).catch(() => []);
    for (const it of items) {
      nodes++;
      if (nodes > maxNodes) break;
      const relPath = dir ? `${dir}/${it.name}` : it.name;
      if (it.type === "dir") {
        stack.push(relPath);
      } else {
        result.push(relPath);
      }
    }
    if (nodes > maxNodes) break;
  }
  return result;
}

function sanitizeUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, provider: u.provider, avatarUrl: u.avatarUrl || null };
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const users = await readUsers();
    const u = users.find((x) => x.id === id);
    done(null, u ? sanitizeUser(u) : false);
  } catch (e) {
    done(e);
  }
});

passport.use(
  new LocalStrategy({ usernameField: "email", passwordField: "password" }, async (email, password, done) => {
    try {
      const users = await readUsers();
      const u = users.find((x) => x.provider === "local" && x.email?.toLowerCase() === String(email).toLowerCase());
      if (!u) return done(null, false, { message: "Invalid credentials" });
      const ok = await bcrypt.compare(String(password || ""), u.passwordHash || "");
      if (!ok) return done(null, false, { message: "Invalid credentials" });
      done(null, sanitizeUser(u));
    } catch (e) {
      done(e);
    }
  })
);

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleCallbackUrl = process.env.GOOGLE_CALLBACK_URL || `http://localhost:${port}/auth/google/callback`;
const googleEnabled = Boolean(googleClientId && googleClientSecret);
const awsBucket = process.env.AWS_S3_BUCKET;
const awsRegion = process.env.AWS_REGION;
const awsPrefix = process.env.AWS_S3_PREFIX;
const awsEnabled = Boolean(awsBucket && awsRegion);

const SUBSCRIPTION_PLANS = [
  { id: "plan_20gb", name: "20 GB", quotaGb: 20, priceMonthlyCents: 199 },
  { id: "plan_30gb", name: "30 GB", quotaGb: 30, priceMonthlyCents: 299 },
  { id: "plan_50gb", name: "50 GB", quotaGb: 50, priceMonthlyCents: 499 }
];

function isValidStripeSecretKey(k) {
  const s = String(k || "").trim();
  return (s.startsWith("sk_test_") || s.startsWith("sk_live_")) && s.length > 20;
}

const stripeSecretKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
const stripePublishableKey = String(process.env.STRIPE_PUBLISHABLE_KEY || "").trim();
const stripe = isValidStripeSecretKey(stripeSecretKey) ? new Stripe(stripeSecretKey) : null;
const stripeCurrency = String(process.env.STRIPE_CURRENCY || "usd").toLowerCase();
const requirePaymentForPlans = String(process.env.REQUIRE_PAYMENT_FOR_PLANS || "") === "1";
const googlePayMerchantId = String(process.env.GOOGLE_PAY_MERCHANT_ID || "").trim();
const googlePayEnvironment = String(process.env.GOOGLE_PAY_ENVIRONMENT || "TEST").toUpperCase();
const stripeProcessedPath = path.join(__dirname, "data", "stripe_sessions.json");

async function readProcessedStripeSessions() {
  try {
    const raw = await fsp.readFile(stripeProcessedPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
}

async function writeProcessedStripeSessions(items) {
  await fsp.writeFile(stripeProcessedPath, JSON.stringify(items, null, 2), "utf8");
}

if (googleEnabled) {
  passport.use(
    new GoogleStrategy(
      { clientID: googleClientId, clientSecret: googleClientSecret, callbackURL: googleCallbackUrl },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value || null;
          const googleId = profile.id;
          const name = profile.displayName || profile.name?.givenName || "";
          const avatarUrl = profile.photos?.[0]?.value || null;
          const users = await readUsers();
          let u = users.find((x) => x.provider === "google" && x.googleId === googleId);
          if (!u) {
            u = {
              id: crypto.randomUUID(),
              provider: "google",
              googleId,
              email,
              name,
              avatarUrl
            };
            users.push(u);
          } else {
            if (email && u.email !== email) {
              u.email = email;
            }
            u.name = name || u.name;
            if (avatarUrl) u.avatarUrl = avatarUrl;
          }
          await writeUsers(users);
          done(null, sanitizeUser(u));
        } catch (e) {
          done(e);
        }
      }
    )
  );
}

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  res.status(401).json({ ok: false, error: "unauthorized" });
}

function getStorageMode(req) {
  const mode = req.session?.storageMode;
  return mode === "cloud" ? "cloud" : "local";
}

function getProviderForRequest(req) {
  const mode = getStorageMode(req);
  if (mode === "cloud") {
    if (!awsEnabled) throw new Error("AWS S3 is not configured");
    const base = String(awsPrefix || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    const userPrefix = base ? `${base}/users/${req.user.id}` : `users/${req.user.id}`;
    return createProvider("aws", { bucket: awsBucket, region: awsRegion, prefix: userPrefix });
  }
  const userRoot = path.join(__dirname, "data", "users", req.user.id);
  ensureDir(userRoot);
  return createProvider("local", { root: userRoot });
}

function getLocalProviderForUser(userId) {
  const userRoot = path.join(__dirname, "data", "users", userId);
  ensureDir(userRoot);
  return createProvider("local", { root: userRoot });
}

function getCloudProviderForUser(userId) {
  if (!awsEnabled) throw new Error("AWS S3 is not configured");
  const base = String(awsPrefix || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const userPrefix = base ? `${base}/users/${userId}` : `users/${userId}`;
  return createProvider("aws", { bucket: awsBucket, region: awsRegion, prefix: userPrefix });
}

app.get("/api/auth/providers", (_req, res) => {
  res.json({
    ok: true,
    providers: {
      local: true,
      google: googleEnabled
    },
    google: {
      enabled: googleEnabled,
      callbackUrl: googleCallbackUrl,
      requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
      optionalEnv: ["GOOGLE_CALLBACK_URL", "PORT"]
    }
  });
});

app.get("/api/storage/providers", (_req, res) => {
  res.json({
    ok: true,
    providers: {
      local: true,
      aws: awsEnabled
    }
  });
});

app.get("/api/users", requireAuth, async (_req, res) => {
  try {
    const users = await readUsers();
    const safe = users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      provider: u.provider,
      avatarUrl: u.avatarUrl || null
    }));
    res.json({ ok: true, users: safe });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/quota", requireAuth, async (req, res) => {
  try {
    const user = await getUserRecordById(req.user.id);
    if (!user) {
      res.status(404).json({ ok: false, error: "user not found" });
      return;
    }
    const provider = getProviderForRequest(req);
    const usedBytes = await computeUserUsageBytes(provider, "");
    const quotaBytes = getUserQuotaBytes(user);
    res.json({ ok: true, userId: user.id, usedBytes, quotaBytes });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/plans", requireAuth, async (req, res) => {
  try {
    const user = await getUserRecordById(req.user.id);
    if (!user) {
      res.status(404).json({ ok: false, error: "user not found" });
      return;
    }
    const currentPlanId = user.planId || null;
    const quotaBytes = getUserQuotaBytes(user);
    res.json({
      ok: true,
      plans: SUBSCRIPTION_PLANS,
      current: { planId: currentPlanId, quotaBytes }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/plans/purchase", requireAuth, async (req, res) => {
  try {
    if (requirePaymentForPlans && !isAdminRequest(req)) {
      if (!stripe) {
        res
          .status(501)
          .json({ ok: false, error: "Stripe is not configured. Set STRIPE_SECRET_KEY=sk_test_... (or sk_live_...) in .env and restart." });
        return;
      }
      res.status(402).json({ ok: false, error: "payment required" });
      return;
    }
    const planId = String(req.body?.planId || "").trim();
    const plan = SUBSCRIPTION_PLANS.find((p) => p.id === planId) || null;
    if (!plan) {
      res.status(400).json({ ok: false, error: "invalid plan" });
      return;
    }
    const users = await readUsers();
    const u = users.find((x) => x.id === req.user.id);
    if (!u) {
      res.status(404).json({ ok: false, error: "user not found" });
      return;
    }
    u.planId = plan.id;
    u.planQuotaBytes = Math.floor(plan.quotaGb * 1024 * 1024 * 1024);
    u.quotaBytes = u.planQuotaBytes;
    u.planUpdatedAt = Date.now();
    await writeUsers(users);
    res.json({ ok: true, planId: u.planId, quotaBytes: u.quotaBytes });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/payments/stripe/create-checkout-session", requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      res
        .status(501)
        .json({ ok: false, error: "Stripe is not configured. Set STRIPE_SECRET_KEY=sk_test_... (or sk_live_...) in .env and restart." });
      return;
    }
    const planId = String(req.body?.planId || "").trim();
    const plan = SUBSCRIPTION_PLANS.find((p) => p.id === planId) || null;
    if (!plan) {
      res.status(400).json({ ok: false, error: "invalid plan" });
      return;
    }
    const host = req.get("host");
    const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
    const base = `${proto}://${host}`;
    const successUrl = `${base}/?stripeSuccess=1&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${base}/?stripeCancel=1`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      automatic_payment_methods: { enabled: true },
      line_items: [
        {
          price_data: {
            currency: stripeCurrency,
            unit_amount: plan.priceMonthlyCents,
            recurring: { interval: "month" },
            product_data: { name: `Storage plan ${plan.name}` }
          },
          quantity: 1
        }
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: req.user.id,
      metadata: { userId: req.user.id, planId: plan.id }
    });
    res.json({ ok: true, url: session.url });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/payments/gpay/process", requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      res.status(501).json({ ok: false, error: "Stripe is not configured." });
      return;
    }
    const { token, planId } = req.body;
    if (!token || !planId) {
      res.status(400).json({ ok: false, error: "token and planId are required" });
      return;
    }
    const plan = SUBSCRIPTION_PLANS.find((p) => p.id === planId);
    if (!plan) {
      res.status(400).json({ ok: false, error: "invalid plan" });
      return;
    }

    // Create a PaymentIntent with the Google Pay token (which is a Stripe token starting with 'tok_')
    const paymentIntent = await stripe.paymentIntents.create({
      amount: plan.priceMonthlyCents,
      currency: stripeCurrency,
      payment_method_data: {
        type: "card",
        card: { token }
      },
      confirm: true,
      off_session: false,
      return_url: `${req.protocol}://${req.get("host")}/`,
      metadata: { userId: req.user.id, planId: plan.id }
    });

    if (paymentIntent.status === "succeeded") {
      const users = await readUsers();
      const u = users.find((x) => x.id === req.user.id);
      if (!u) {
        res.status(404).json({ ok: false, error: "user not found" });
        return;
      }
      u.planId = plan.id;
      u.planQuotaBytes = Math.floor(plan.quotaGb * 1024 * 1024 * 1024);
      u.quotaBytes = u.planQuotaBytes;
      u.planUpdatedAt = Date.now();
      await writeUsers(users);
      res.json({ ok: true, planId: u.planId, quotaBytes: u.quotaBytes });
    } else {
      res.status(400).json({ ok: false, error: `Payment status: ${paymentIntent.status}` });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/payments/stripe/status", requireAuth, (req, res) => {
  res.json({
    ok: true,
    configured: Boolean(stripe),
    keyLooksValid: isValidStripeSecretKey(stripeSecretKey),
    publishableKey: stripePublishableKey,
    googlePayMerchantId,
    googlePayEnvironment,
    requirePaymentForPlans,
    currency: stripeCurrency
  });
});

app.post("/api/payments/stripe/confirm", requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      res
        .status(501)
        .json({ ok: false, error: "Stripe is not configured. Set STRIPE_SECRET_KEY=sk_test_... (or sk_live_...) in .env and restart." });
      return;
    }
    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId) {
      res.status(400).json({ ok: false, error: "sessionId is required" });
      return;
    }
    const processed = await readProcessedStripeSessions();
    if (processed.includes(sessionId)) {
      res.json({ ok: true, alreadyApplied: true });
      return;
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });
    const metaUserId = session?.metadata?.userId || session?.client_reference_id || null;
    if (!metaUserId || metaUserId !== req.user.id) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    const planId = String(session?.metadata?.planId || "").trim();
    const plan = SUBSCRIPTION_PLANS.find((p) => p.id === planId) || null;
    if (!plan) {
      res.status(400).json({ ok: false, error: "invalid plan" });
      return;
    }

    const sub = session.subscription;
    const subStatus = sub && typeof sub === "object" ? String(sub.status || "") : "";
    const sessionStatus = String(session.status || "");
    const paid = String(session.payment_status || "") === "paid";
    const activeSub = subStatus === "active" || subStatus === "trialing";
    if (!(paid || (sessionStatus === "complete" && activeSub))) {
      res.status(400).json({ ok: false, error: "payment not completed" });
      return;
    }

    const users = await readUsers();
    const u = users.find((x) => x.id === req.user.id);
    if (!u) {
      res.status(404).json({ ok: false, error: "user not found" });
      return;
    }
    u.planId = plan.id;
    u.planQuotaBytes = Math.floor(plan.quotaGb * 1024 * 1024 * 1024);
    u.quotaBytes = u.planQuotaBytes;
    u.planUpdatedAt = Date.now();
    u.stripeCustomerId = session.customer || u.stripeCustomerId || null;
    u.stripeSubscriptionId = (sub && typeof sub === "object" && sub.id) ? sub.id : u.stripeSubscriptionId || null;
    await writeUsers(users);

    processed.push(sessionId);
    await writeProcessedStripeSessions(processed.slice(-5000));

    res.json({ ok: true, planId: u.planId, quotaBytes: u.quotaBytes });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/admin/users", requireAuth, async (req, res) => {
  try {
    if (!isAdminRequest(req)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    const users = await readUsers();
    const defaultQuotaBytes = readDefaultQuotaBytes();
    const safe = users.map((u) => {
      const hasCustomQuota = Number.isFinite(Number(u.quotaBytes)) && Number(u.quotaBytes) > 0;
      const quotaBytes = getUserQuotaBytes(u);
      return {
        id: u.id,
        email: u.email || null,
        name: u.name || null,
        provider: u.provider,
        planId: u.planId || null,
        quotaBytes,
        hasCustomQuota
      };
    });
    res.json({ ok: true, defaultQuotaBytes, users: safe });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/admin/quota", requireAuth, async (req, res) => {
  try {
    if (!isAdminRequest(req)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    const userId = String(req.body?.userId || "").trim();
    const quotaGb = Number(req.body?.quotaGb);
    if (!userId || !Number.isFinite(quotaGb) || quotaGb <= 0) {
      res.status(400).json({ ok: false, error: "userId and quotaGb are required" });
      return;
    }
    const users = await readUsers();
    const u = users.find((x) => x.id === userId);
    if (!u) {
      res.status(404).json({ ok: false, error: "user not found" });
      return;
    }
    u.quotaBytes = Math.floor(quotaGb * 1024 * 1024 * 1024);
    await writeUsers(users);
    res.json({ ok: true, userId, quotaBytes: u.quotaBytes });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/backup", requireAuth, async (req, res) => {
  try {
    const provider = getProviderForRequest(req);
    const entries = await collectEntries(provider, "");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="backup-${req.user.id}.zip"`
    );
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("backup error", err);
      try {
        res.status(500).end(String(err));
      } catch {
        // ignore
      }
    });
    archive.pipe(res);
    for (const p of entries) {
      const buf = await provider.read(p);
      archive.append(buf, { name: p });
    }
    await archive.finalize();
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});

app.get("/api/cloud/backups", requireAuth, async (req, res) => {
  try {
    const provider = getCloudProviderForUser(req.user.id);
    const items = await provider.list("").catch(() => []); // List from root
    const backups = (items || [])
      .filter((it) => it && it.type === "dir" && it.name)
      .map((it) => ({ name: it.name, path: it.name }))
      .sort((a, b) => b.name.localeCompare(a.name));
    res.json({ ok: true, backups });
  } catch (e) {
    const msg = String(e.message || e);
    if (msg === "AWS S3 is not configured") {
      res.status(501).json({ ok: false, error: msg });
      return;
    }
    res.status(500).json({ ok: false, error: msg });
  }
});

app.post("/api/cloud/presign", requireAuth, async (req, res) => {
  try {
    if (!awsEnabled) throw new Error("AWS S3 is not configured");
    const { files, path: dir } = req.body;
    if (!Array.isArray(files)) {
      res.status(400).json({ ok: false, error: "files array is required" });
      return;
    }
    const provider = getCloudProviderForUser(req.user.id);
    const results = [];
    for (const f of files) {
      const fileName = String(f.name || "").trim();
      const contentType = String(f.type || "application/octet-stream");
      if (!fileName) continue;
      
      const relPath = dir ? `${norm(dir)}/${fileName}` : fileName;
      const { url, method } = await provider.getPresignedPutUrl(relPath, contentType);
      results.push({ name: fileName, url, method });
    }
    res.json({ ok: true, urls: results });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/cloud/backup/download", requireAuth, async (req, res) => {
  try {
    const raw = norm(req.query.path || "");
    const rel = raw.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!rel) {
      res.status(400).send("path is required");
      return;
    }
    const provider = getCloudProviderForUser(req.user.id);
    const entries = await collectEntries(provider, rel);
    const baseName = path.posix.basename(rel.replace(/\/+$/, ""));

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${baseName}.zip"`);
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("backup folder error", err);
      try {
        res.status(500).end(String(err));
      } catch {}
    });
    archive.pipe(res);

    const prefix = rel.replace(/\/+$/, "") + "/";
    for (const p of entries) {
      const buf = await provider.read(p);
      const inner = p.startsWith(prefix) ? p.slice(prefix.length) : path.posix.basename(p);
      const zipName = `${baseName}/${inner}`.replace(/^\/+/, "");
      archive.append(buf, { name: zipName });
    }
    await archive.finalize();
  } catch (e) {
    const msg = String(e.message || e);
    if (msg === "AWS S3 is not configured") {
      res.status(501).send(msg);
      return;
    }
    res.status(500).send(msg);
  }
});

app.post(
  "/api/restore",
  requireAuth,
  restoreUpload.single("file"),
  async (req, res) => {
    try {
      if (!req.file || !req.file.path) {
        res.status(400).json({ ok: false, error: "No backup file uploaded" });
        return;
      }
      const provider = getProviderForRequest(req);
      const stream = fs
        .createReadStream(req.file.path)
        .pipe(unzipper.Parse({ forceStream: true }));
      for await (const entry of stream) {
        const rel = String(entry.path || "").replace(/^\/+/, "");
        if (!rel) {
          entry.autodrain();
          continue;
        }
        if (entry.type === "Directory") {
          await provider.ensureDir(rel);
          entry.autodrain();
        } else {
          const chunks = [];
          for await (const chunk of entry) chunks.push(chunk);
          const buf = Buffer.concat(chunks);
          await provider.put(rel, buf);
        }
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    } finally {
      if (req.file?.path) {
        fs.unlink(req.file.path, () => {});
      }
    }
  }
);

app.post(
  "/api/restore/preview",
  requireAuth,
  restoreUpload.single("file"),
  async (req, res) => {
    try {
      if (!req.file || !req.file.path) {
        res.status(400).json({ ok: false, error: "No backup file uploaded" });
        return;
      }
      const token = crypto.randomUUID();
      restoreTempBackups.set(token, {
        userId: req.user.id,
        filePath: req.file.path,
        createdAt: Date.now(),
        originalName: req.file.originalname || "backup.zip"
      });

      const top = new Set();
      let totalFiles = 0;
      const stream = fs.createReadStream(req.file.path).pipe(unzipper.Parse({ forceStream: true }));
      for await (const entry of stream) {
        const rel = sanitizeZipRel(entry.path || "");
        if (!rel) {
          entry.autodrain();
          continue;
        }
        if (entry.type === "Directory") {
          const first = rel.split("/")[0];
          if (first) top.add(`${first}/`);
          entry.autodrain();
          continue;
        }
        totalFiles++;
        const parts = rel.split("/");
        if (parts.length > 1) {
          top.add(`${parts[0]}/`);
        } else {
          top.add(parts[0]);
        }
        entry.autodrain();
      }

      const items = Array.from(top)
        .sort((a, b) => a.localeCompare(b))
        .map((p) => ({
          type: p.endsWith("/") ? "dir" : "file",
          path: p,
          name: p.endsWith("/") ? p.slice(0, -1) : p
        }));

      res.json({ ok: true, token, items, totalFiles });
    } catch (e) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }
);

app.post("/api/restore/select", requireAuth, async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    const selectionsRaw = Array.isArray(req.body?.selections) ? req.body.selections : [];
    if (!token) {
      res.status(400).json({ ok: false, error: "token is required" });
      return;
    }
    const rec = restoreTempBackups.get(token);
    if (!rec || !rec.filePath) {
      res.status(404).json({ ok: false, error: "preview not found or expired" });
      return;
    }
    if (rec.userId !== req.user.id) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    const selections = selectionsRaw.map(normalizeRestoreSelection).filter(Boolean);
    if (!selections.length) {
      res.status(400).json({ ok: false, error: "select at least one item to restore" });
      return;
    }

    const provider = getProviderForRequest(req);
    const shouldRestore = (rel) => {
      for (const s of selections) {
        if (s.endsWith("/")) {
          if (rel === s.slice(0, -1)) return true;
          if (rel.startsWith(s)) return true;
        } else if (rel === s) {
          return true;
        }
      }
      return false;
    };

    const stream = fs.createReadStream(rec.filePath).pipe(unzipper.Parse({ forceStream: true }));
    for await (const entry of stream) {
      const rel = sanitizeZipRel(entry.path || "");
      if (!rel) {
        entry.autodrain();
        continue;
      }
      if (!shouldRestore(rel)) {
        entry.autodrain();
        continue;
      }
      if (entry.type === "Directory") {
        await provider.ensureDir(rel);
        entry.autodrain();
        continue;
      }
      const chunks = [];
      for await (const chunk of entry) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      await provider.put(rel, buf);
    }

    restoreTempBackups.delete(token);
    fs.unlink(rec.filePath, () => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/storage/mode", requireAuth, (req, res) => {
  res.json({ ok: true, mode: getStorageMode(req) });
});

app.post("/api/storage/mode", requireAuth, (req, res) => {
  const mode = String(req.body?.mode || "");
  if (mode !== "local" && mode !== "cloud") {
    res.status(400).json({ ok: false, error: "mode must be local or cloud" });
    return;
  }
  if (mode === "cloud" && !awsEnabled) {
    res.status(501).json({ ok: false, error: "AWS S3 is not configured" });
    return;
  }
  req.session.storageMode = mode;
  res.json({ ok: true, mode });
});

app.get("/api/me", (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    res.json({ ok: true, user: req.user });
  } else {
    res.json({ ok: false });
  }
});

app.post("/auth/register", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const name = String(req.body.name || "").trim();
    if (!email || !password) {
      res.status(400).json({ ok: false, error: "email and password required" });
      return;
    }
    const users = await readUsers();
    const exists = users.some((u) => u.provider === "local" && u.email === email);
    if (exists) {
      res.status(409).json({ ok: false, error: "email already registered" });
      return;
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const u = { id: crypto.randomUUID(), provider: "local", email, name, passwordHash };
    users.push(u);
    await writeUsers(users);
    req.login(sanitizeUser(u), (err) => {
      if (err) {
        res.status(500).json({ ok: false, error: String(err.message || err) });
        return;
      }
      res.json({ ok: true, user: sanitizeUser(u) });
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/auth/login", (req, res, next) => {
  passport.authenticate("local", (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      res.status(401).json({ ok: false, error: info?.message || "unauthorized" });
      return;
    }
    req.login(user, (err2) => {
      if (err2) return next(err2);
      res.json({ ok: true, user });
    });
  })(req, res, next);
});

app.post("/auth/logout", (req, res) => {
  const finish = () => {
    if (req.session) req.session.destroy(() => {});
    res.json({ ok: true });
  };
  if (req.logout) {
    req.logout(() => finish());
  } else {
    finish();
  }
});

app.get("/auth/google", (req, res, next) => {
  if (!googleEnabled) return res.redirect("/?authError=google_not_configured");
  passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});

app.get("/auth/google/callback", (req, res, next) => {
  if (!googleEnabled) return res.redirect("/?authError=google_not_configured");
  passport.authenticate("google", { failureRedirect: "/" })(req, res, () => {
    res.redirect("/");
  });
});

app.get("/api/list", requireAuth, async (req, res) => {
  try {
    const provider = getProviderForRequest(req);
    const rel = norm(req.query.path || "");
    const items = await provider.list(rel);
    res.json({ ok: true, items, path: rel });
  } catch (e) {
    const msg = String(e.message || e);
    if (msg === "AWS S3 is not configured") {
      res.status(501).json({ ok: false, error: msg });
      return;
    }
    res.status(500).json({ ok: false, error: msg });
  }
});

app.post("/api/mkdir", requireAuth, async (req, res) => {
  try {
    const provider = getProviderForRequest(req);
    const rel = norm(req.body.path || "");
    await provider.ensureDir(rel);
    res.json({ ok: true });
  } catch (e) {
    const msg = String(e.message || e);
    if (msg === "AWS S3 is not configured") {
      res.status(501).json({ ok: false, error: msg });
      return;
    }
    res.status(500).json({ ok: false, error: msg });
  }
});

app.post("/api/delete", requireAuth, async (req, res) => {
  try {
    const provider = getProviderForRequest(req);
    const rel = norm(req.body.path || "");
    await provider.remove(rel);
    res.json({ ok: true });
  } catch (e) {
    const msg = String(e.message || e);
    if (msg === "AWS S3 is not configured") {
      res.status(501).json({ ok: false, error: msg });
      return;
    }
    res.status(500).json({ ok: false, error: msg });
  }
});

app.post("/api/move", requireAuth, async (req, res) => {
  try {
    const provider = getProviderForRequest(req);
    const from = norm(req.body.from || "");
    const to = norm(req.body.to || "");
    await provider.move(from, to);
    res.json({ ok: true });
  } catch (e) {
    const msg = String(e.message || e);
    if (msg === "AWS S3 is not configured") {
      res.status(501).json({ ok: false, error: msg });
      return;
    }
    res.status(500).json({ ok: false, error: msg });
  }
});

app.post("/api/share", requireAuth, async (req, res) => {
  try {
    const mode = getStorageMode(req);
    if (mode !== "cloud") {
      res.status(400).json({ ok: false, error: "Sharing is only supported in cloud storage mode." });
      return;
    }
    if (!awsEnabled) {
      res.status(501).json({ ok: false, error: "AWS S3 is not configured" });
      return;
    }

    const email = String(req.body.email || "").trim().toLowerCase();
    const access = String(req.body.access || "read").toLowerCase() === "write" ? "write" : "read";
    const dir = norm(req.body.path || "");

    if (!email || !dir) {
      res.status(400).json({ ok: false, error: "email and path are required" });
      return;
    }

    // Optionally verify that the folder exists for the owner in cloud storage.
    const provider = getProviderForRequest(req);
    await provider.list(dir).catch(() => {
      // If listing fails, we still allow creating the share, but the folder may not yet exist.
    });

    const shares = await readShares();
    const users = await readUsers();
    const target = users.find(
      (u) => u.email && u.email.toLowerCase() === email.toLowerCase()
    );
    const share = {
      id: crypto.randomUUID(),
      ownerId: req.user.id,
      path: dir,
      email,
      targetUserId: target ? target.id : null,
      access
    };
    shares.push(share);
    await writeShares(shares);

    res.json({ ok: true, share });
  } catch (e) {
    const msg = String(e.message || e);
    res.status(500).json({ ok: false, error: msg });
  }
});

app.get("/api/shares", requireAuth, async (req, res) => {
  try {
    const shares = await readShares();
    const myEmail = String(req.user.email || "").trim().toLowerCase();
    const owned = shares.filter((s) => s.ownerId === req.user.id);
    const received = shares.filter((s) => {
      if (s.targetUserId && s.targetUserId === req.user.id) return true;
      if (s.email && myEmail && String(s.email).trim().toLowerCase() === myEmail) return true;
      return false;
    });
    res.json({ ok: true, owned, received });
  } catch (e) {
    const msg = String(e.message || e);
    res.status(500).json({ ok: false, error: msg });
  }
});

app.get("/api/shared/list", requireAuth, async (req, res) => {
  try {
    const mode = getStorageMode(req);
    if (mode !== "cloud") {
      res.status(400).json({ ok: false, error: "Shared folders can only be listed in cloud storage mode." });
      return;
    }
    const shareId = String(req.query.shareId || "").trim();
    if (!shareId) {
      res.status(400).json({ ok: false, error: "shareId is required" });
      return;
    }
    const shares = await readShares();
    const share = shares.find((s) => s.id === shareId);
    if (!share) {
      res.status(404).json({ ok: false, error: "Share not found" });
      return;
    }
    const myEmail = String(req.user.email || "").trim().toLowerCase();
    if (share.ownerId !== req.user.id && String(share.email || "").trim().toLowerCase() !== myEmail) {
      res.status(403).json({ ok: false, error: "You do not have access to this shared folder." });
      return;
    }

    const provider = getCloudProviderForUser(share.ownerId);
    const extra = norm(req.query.path || "");
    const base = String(share.path || "").replace(/\\/g, "/");
    const rel = extra ? `${base.replace(/\/+$/, "")}/${extra}` : base;

    let items;
    try {
      items = await provider.list(rel);
    } catch {
      items = null;
    }

    // If listing fails or returns nothing, try treating the shared path as a single file.
    if (!items || items.length === 0) {
      const exists = await provider.exists(rel);
      if (!exists) {
        res.status(404).json({ ok: false, error: "Shared item not found" });
        return;
      }
      const name = path.basename(rel);
      items = [{ name, type: "file", size: 0, mtime: 0 }];
    }

    res.json({ ok: true, items, path: rel, basePath: share.path, share });
  } catch (e) {
    const msg = String(e.message || e);
    if (msg === "AWS S3 is not configured") {
      res.status(501).json({ ok: false, error: msg });
      return;
    }
    res.status(500).json({ ok: false, error: msg });
  }
});

app.post("/api/shared/delete", requireAuth, async (req, res) => {
  try {
    const mode = getStorageMode(req);
    if (mode !== "cloud") {
      res.status(400).json({ ok: false, error: "Shared delete is only available in cloud storage mode." });
      return;
    }
    const shareId = String(req.body.shareId || "").trim();
    if (!shareId) {
      res.status(400).json({ ok: false, error: "shareId is required" });
      return;
    }
    const shares = await readShares();
    const share = shares.find((s) => s.id === shareId);
    if (!share) {
      res.status(404).json({ ok: false, error: "Share not found" });
      return;
    }
    const myEmail = String(req.user.email || "").trim().toLowerCase();
    const isOwner = share.ownerId === req.user.id;
    const isRecipientEmail = String(share.email || "").trim().toLowerCase() === myEmail;
    const isRecipientId = share.targetUserId && share.targetUserId === req.user.id;
    const isRecipient = isRecipientEmail || isRecipientId;
    if (!isOwner && !isRecipient) {
      res.status(403).json({ ok: false, error: "You do not have access to this shared folder." });
      return;
    }
    const provider = getCloudProviderForUser(share.ownerId);
    const extra = norm(req.body.path || "");
    const base = String(share.path || "").replace(/\\/g, "/");
    const rel = extra ? `${base.replace(/\/+$/, "")}/${extra}` : base;
    await provider.remove(rel);
    res.json({ ok: true });
  } catch (e) {
    const msg = String(e.message || e);
    if (msg === "AWS S3 is not configured") {
      res.status(501).json({ ok: false, error: msg });
      return;
    }
    res.status(500).json({ ok: false, error: msg });
  }
});

app.get("/api/shared/download", requireAuth, async (req, res) => {
  try {
    const mode = getStorageMode(req);
    if (mode !== "cloud") {
      res.status(400).send("Shared files can only be downloaded in cloud storage mode.");
      return;
    }
    const shareId = String(req.query.shareId || "").trim();
    if (!shareId) {
      res.status(400).send("shareId is required");
      return;
    }
    const shares = await readShares();
    const share = shares.find((s) => s.id === shareId);
    if (!share) {
      res.status(404).send("Share not found");
      return;
    }
    const myEmail = String(req.user.email || "").trim().toLowerCase();
    if (share.ownerId !== req.user.id && String(share.email || "").trim().toLowerCase() !== myEmail) {
      res.status(403).send("You do not have access to this shared folder.");
      return;
    }

    const provider = getCloudProviderForUser(share.ownerId);
    const extra = norm(req.query.path || "");
    const base = String(share.path || "").replace(/\\/g, "/");
    const rel = extra ? `${base.replace(/\/+$/, "")}/${extra}` : base;

    const exists = await provider.exists(rel);
    if (!exists) {
      res.status(404).send("Not found");
      return;
    }
    const buf = await provider.read(rel);
    const ct = mime.lookup(rel) || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    const baseName = path.basename(rel);
    const inline = req.query.inline === "1";
    res.setHeader("Content-Disposition", inline ? "inline" : `attachment; filename="${baseName}"`);
    res.send(buf);
  } catch (e) {
    const msg = String(e.message || e);
    if (msg === "AWS S3 is not configured") {
      res.status(501).send(msg);
      return;
    }
    res.status(500).send(msg);
  }
});

app.post(
  "/api/upload",
  requireAuth,
  upload.fields([
    { name: "files", maxCount: MAX_FILES },
    { name: "file", maxCount: 1 }
  ]),
  async (req, res) => {
  try {
    const provider = getProviderForRequest(req);
    const dir = norm(req.query.path || "");
    await ensureDirTree(provider, dir);
    const files = [];
    if (Array.isArray(req.files)) files.push(...req.files);
    else if (req.files && typeof req.files === "object") {
      if (Array.isArray(req.files.files)) files.push(...req.files.files);
      if (Array.isArray(req.files.file)) files.push(...req.files.file);
    }
    if (files.length === 0) {
      res.status(400).json({ ok: false, error: "no files provided" });
      return;
    }
    if (files.length > MAX_FILES) {
      res.status(400).json({ ok: false, error: `too many files (max ${MAX_FILES})` });
      return;
    }
    const total = files.reduce((acc, f) => acc + (f.size || 0), 0);
    if (total > MAX_TOTAL_BYTES) {
      res.status(400).json({ ok: false, error: "total upload size exceeds 5 GB" });
      return;
    }
    const user = await getUserRecordById(req.user.id);
    if (user) {
      const usedBytes = await computeUserUsageBytes(provider, "");
      const quotaBytes = getUserQuotaBytes(user);
      if (usedBytes + total > quotaBytes) {
        res.status(413).json({ ok: false, error: "quota exceeded", usedBytes, quotaBytes, incomingBytes: total });
        return;
      }
    }
    const saved = [];
    for (const f of files) {
      const filename = path.posix.basename(String(f.originalname || "file"));
      const dest = path.posix.join(dir.replace(/\\/g, "/"), filename);
      try {
        if (typeof provider.putFile === "function" && f.path) {
          await provider.putFile(dest, f.path);
        } else if (f.path) {
          const buf = await fsp.readFile(f.path);
          await provider.put(dest, buf);
        } else if (f.buffer) {
          await provider.put(dest, f.buffer);
        } else {
          throw new Error("invalid file data");
        }
        saved.push(dest);
      } finally {
        if (f.path) {
          await fsp.unlink(f.path).catch(() => {});
        }
      }
    }
    res.json({ ok: true, paths: saved });
  } catch (e) {
    const msg = String(e.message || e);
    if (msg === "AWS S3 is not configured") {
      res.status(501).json({ ok: false, error: msg });
      return;
    }
    res.status(500).json({ ok: false, error: msg });
  }
  }
);

app.post(
  "/api/upload-cloud",
  requireAuth,
  upload.fields([
    { name: "files", maxCount: MAX_FILES },
    { name: "file", maxCount: 1 }
  ]),
  async (req, res) => {
  try {
    const provider = getCloudProviderForUser(req.user.id);
    const dir = norm(req.query.path || "");
    await ensureDirTree(provider, dir);
    const files = [];
    if (Array.isArray(req.files)) files.push(...req.files);
    else if (req.files && typeof req.files === "object") {
      if (Array.isArray(req.files.files)) files.push(...req.files.files);
      if (Array.isArray(req.files.file)) files.push(...req.files.file);
    }
    if (files.length === 0) {
      res.status(400).json({ ok: false, error: "no files provided" });
      return;
    }
    if (files.length > MAX_FILES) {
      res.status(400).json({ ok: false, error: `too many files (max ${MAX_FILES})` });
      return;
    }
    const total = files.reduce((acc, f) => acc + (f.size || 0), 0);
    if (total > MAX_TOTAL_BYTES) {
      res.status(400).json({ ok: false, error: "total upload size exceeds 5 GB" });
      return;
    }
    const user = await getUserRecordById(req.user.id);
    if (user) {
      const usedBytes = await computeUserUsageBytes(provider, "");
      const quotaBytes = getUserQuotaBytes(user);
      if (usedBytes + total > quotaBytes) {
        res.status(413).json({ ok: false, error: "quota exceeded", usedBytes, quotaBytes, incomingBytes: total });
        return;
      }
    }
    const saved = [];
    for (const f of files) {
      const filename = path.posix.basename(String(f.originalname || "file"));
      const dest = path.posix.join(dir.replace(/\\/g, "/"), filename);
      try {
        if (typeof provider.putFile === "function" && f.path) {
          await provider.putFile(dest, f.path);
        } else if (f.path) {
          const buf = await fsp.readFile(f.path);
          await provider.put(dest, buf);
        } else if (f.buffer) {
          await provider.put(dest, f.buffer);
        } else {
          throw new Error("invalid file data");
        }
        saved.push(dest);
      } finally {
        if (f.path) {
          await fsp.unlink(f.path).catch(() => {});
        }
      }
    }
    res.json({ ok: true, paths: saved });
  } catch (e) {
    const msg = String(e.message || e);
    if (msg === "AWS S3 is not configured") {
      res.status(501).json({ ok: false, error: msg });
      return;
    }
    res.status(500).json({ ok: false, error: msg });
  }
  }
);

app.get("/api/download", requireAuth, async (req, res) => {
  try {
    const provider = getProviderForRequest(req);
    const rel = norm(req.query.path || "");
    const exists = await provider.exists(rel);
    if (!exists) {
      res.status(404).send("Not found");
      return;
    }
    const buf = await provider.read(rel);
    const ct = mime.lookup(rel) || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    const base = path.basename(rel);
    const inline = req.query.inline === "1";
    res.setHeader("Content-Disposition", inline ? "inline" : `attachment; filename="${base}"`);
    res.send(buf);
  } catch (e) {
    const msg = String(e.message || e);
    if (msg === "AWS S3 is not configured") {
      res.status(501).send(msg);
      return;
    }
    res.status(500).send(msg);
  }
});

app.use((err, _req, res, next) => {
  if (err && err.name === "MulterError") {
    res.status(400).json({ ok: false, error: err.message, code: err.code });
    return;
  }
  next(err);
});

function startServer(p, retriesLeft) {
  const server = app.listen(p, () => {
    console.log(`Storage app listening on http://localhost:${p}`);
    console.log(`Google login: ${googleEnabled ? "enabled" : "disabled (add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env)"}`);
  });
  server.on("error", (err) => {
    if (err?.code === "EADDRINUSE" && !process.env.PORT && retriesLeft > 0) {
      const next = p + 1;
      console.error(`Port ${p} is already in use. Trying ${next}...`);
      startServer(next, retriesLeft - 1);
      return;
    }
    if (err?.code === "EADDRINUSE") {
      console.error(`Port ${p} is already in use. Set PORT to a free port and retry.`);
      process.exit(1);
      return;
    }
    console.error(err);
    process.exit(1);
  });
}

startServer(port, 10);
