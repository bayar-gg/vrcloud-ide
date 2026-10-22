"use strict";

/**
 * Grok / xAI account login for the AI agent (no API key).
 *
 * Uses xAI's official OAuth 2.0 device-code grant at auth.x.ai — the same
 * public client and endpoints as `grok login --device-auth` (RFC 8628).
 * Discovery: https://auth.x.ai/.well-known/openid-configuration
 *
 * After the operator approves the login in any browser, the access + refresh
 * tokens are encrypted (AES-256-GCM, key from AUTH_SECRET) and written under
 * the app data dir with mode 0600. Nothing is sent to the browser except
 * status (connected / email / pending user code).
 *
 * Env (non-secret):
 *   GROK_OAUTH_CLIENT_ID  override if xAI rotates the public Grok CLI client
 *   GROK_OAUTH_SCOPE      override scopes
 *   GROK_API_BASE         inference base (default https://api.x.ai/v1)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ISSUER = "https://auth.x.ai";
const DISCOVERY_URL = ISSUER + "/.well-known/openid-configuration";
const DEFAULT_DEVICE_URL = ISSUER + "/oauth2/device/code";
const DEFAULT_TOKEN_URL = ISSUER + "/oauth2/token";
const DEFAULT_REVOKE_URL = ISSUER + "/oauth2/revoke";
const DEFAULT_USERINFO_URL = ISSUER + "/oauth2/userinfo";
// Public Grok CLI OAuth client (no secret; PKCE / device-code). Same id the
// official CLI uses for `grok login --device-auth`.
const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const DEFAULT_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_API_BASE = "https://api.x.ai/v1";
const FORM_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  accept: "application/json",
  "user-agent": "VRCloud-IDE/grok-oauth",
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function formBody(obj) {
  return Object.keys(obj).filter((k) => obj[k] != null && obj[k] !== "")
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(obj[k]))).join("&");
}

function jwtExp(token) {
  const t = String(token || "");
  const parts = t.split(".");
  if (parts.length < 2) return 0;
  try {
    const json = Buffer.from(parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4), "base64url").toString("utf8");
    const exp = JSON.parse(json).exp;
    return typeof exp === "number" ? exp * 1000 : 0;
  } catch (e) { return 0; }
}

function jwtClaim(token, name) {
  const t = String(token || "");
  const parts = t.split(".");
  if (parts.length < 2) return "";
  try {
    const json = Buffer.from(parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4), "base64url").toString("utf8");
    const v = JSON.parse(json)[name];
    return v == null ? "" : String(v);
  } catch (e) { return ""; }
}

function maskEmail(email) {
  const s = String(email || "").trim();
  const at = s.indexOf("@");
  if (at < 1) return s ? "connected" : "";
  const user = s.slice(0, at), host = s.slice(at + 1);
  if (user.length <= 2) return user[0] + "\u2026@" + host;
  return user[0] + "\u2026" + user[user.length - 1] + "@" + host;
}

class GrokAuth {
  constructor(options) {
    options = options || {};
    this.file = options.file || "";
    this.secret = String(options.secret || process.env.AUTH_SECRET || "");
    this.clientId = String(options.clientId || process.env.GROK_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID).trim();
    this.scope = String(options.scope || process.env.GROK_OAUTH_SCOPE || DEFAULT_SCOPE).trim();
    this.apiBase = String(options.apiBase || process.env.GROK_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
    this.fetch = options.fetch || globalThis.fetch.bind(globalThis);
    this.now = options.now || (() => Date.now());
    this.cliAuthFile = options.cliAuthFile || path.join(os.homedir(), ".grok", "auth.json");
    this.autoPoll = options.autoPoll !== false;
    this.session = null; // { accessToken, refreshToken, expiresAt, email, sub, tokenType, scope }
    this.pending = null; // public + deviceCode (deviceCode never sent to the client)
    this.pollTimer = null;
    this.pollPromise = null;
    this.discovery = null;
    this.load();
    if (!this.session) this.tryImportCliAuth();
  }

  endpoints() {
    const d = this.discovery || {};
    return {
      device: d.device_authorization_endpoint || DEFAULT_DEVICE_URL,
      token: d.token_endpoint || DEFAULT_TOKEN_URL,
      revoke: d.revocation_endpoint || DEFAULT_REVOKE_URL,
      userinfo: d.userinfo_endpoint || DEFAULT_USERINFO_URL,
    };
  }

  async discover() {
    if (this.discovery) return this.discovery;
    try {
      const res = await this.fetch(DISCOVERY_URL, { headers: { accept: "application/json", "user-agent": FORM_HEADERS["user-agent"] } });
      if (res.ok) {
        const j = await res.json();
        if (j && j.token_endpoint) this.discovery = j;
      }
    } catch (e) { /* pakai default resmi auth.x.ai */ }
    return this.discovery;
  }

  // ---- persistence (encrypted) ------------------------------------------
  deriveKey(salt) {
    if (!this.secret || this.secret.length < 8) return null;
    return crypto.scryptSync(this.secret, salt, 32);
  }

  encryptSecrets(obj, salt) {
    const key = this.deriveKey(salt);
    const raw = JSON.stringify(obj);
    if (!key) return { plain: raw }; // tes / AUTH_SECRET pendek: tetap 0600
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
    return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), data: data.toString("hex") };
  }

  decryptSecrets(blob, salt) {
    if (!blob) return null;
    if (blob.plain) {
      try { return JSON.parse(blob.plain); } catch (e) { return null; }
    }
    const key = this.deriveKey(salt);
    if (!key || !blob.iv || !blob.tag || !blob.data) return null;
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"));
      d.setAuthTag(Buffer.from(blob.tag, "hex"));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(blob.data, "hex")), d.final()]).toString("utf8"));
    } catch (e) { return null; }
  }

  publicPending() {
    const p = this.pending;
    if (!p) return null;
    return {
      userCode: p.userCode,
      verificationUri: p.verificationUri,
      verificationUriComplete: p.verificationUriComplete,
      expiresAt: p.expiresAt,
      interval: p.interval,
    };
  }

  diskPayload() {
    const salt = crypto.randomBytes(16);
    const secrets = {};
    if (this.session) {
      secrets.session = {
        accessToken: this.session.accessToken,
        refreshToken: this.session.refreshToken,
        expiresAt: this.session.expiresAt,
        email: this.session.email || "",
        sub: this.session.sub || "",
        tokenType: this.session.tokenType || "Bearer",
        scope: this.session.scope || "",
      };
    }
    if (this.pending) secrets.pendingDeviceCode = this.pending.deviceCode;
    return {
      v: 1,
      salt: salt.toString("hex"),
      secrets: this.encryptSecrets(secrets, salt),
      public: {
        connected: !!(this.session && this.session.accessToken),
        email: this.session ? this.session.email : "",
        expiresAt: this.session ? this.session.expiresAt : 0,
        pending: this.publicPending(),
      },
    };
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!raw || raw.v !== 1) return;
      const salt = Buffer.from(String(raw.salt || ""), "hex");
      const secrets = this.decryptSecrets(raw.secrets, salt) || {};
      if (secrets.session && secrets.session.accessToken) {
        this.session = {
          accessToken: secrets.session.accessToken,
          refreshToken: secrets.session.refreshToken || "",
          expiresAt: Number(secrets.session.expiresAt) || jwtExp(secrets.session.accessToken) || 0,
          email: secrets.session.email || "",
          sub: secrets.session.sub || "",
          tokenType: secrets.session.tokenType || "Bearer",
          scope: secrets.session.scope || "",
        };
      }
      const pub = (raw.public && raw.public.pending) || null;
      if (pub && secrets.pendingDeviceCode && Number(pub.expiresAt) > this.now()) {
        this.pending = {
          deviceCode: secrets.pendingDeviceCode,
          userCode: pub.userCode,
          verificationUri: pub.verificationUri,
          verificationUriComplete: pub.verificationUriComplete,
          expiresAt: Number(pub.expiresAt),
          interval: Number(pub.interval) || 5,
        };
        this.kickPoll();
      }
    } catch (e) { /* file rusak: mulai kosong */ }
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.diskPayload()), "utf8");
      fs.renameSync(tmp, this.file);
      if (process.platform !== "win32") { try { fs.chmodSync(this.file, 0o600); } catch (e) {} }
    } catch (e) { /* abaikan kegagalan tulis */ }
  }

  // Operator already ran `grok login` on this machine: copy tokens into our store.
  tryImportCliAuth() {
    try {
      if (!this.cliAuthFile || !fs.existsSync(this.cliAuthFile)) return;
      const j = JSON.parse(fs.readFileSync(this.cliAuthFile, "utf8"));
      const access = j && (j.access_token || (j.tokens && j.tokens.access_token));
      const refresh = j && (j.refresh_token || (j.tokens && j.tokens.refresh_token) || "");
      if (!access) return;
      const exp = Number(j.expires_at) || (j.expires_in ? this.now() + Number(j.expires_in) * 1000 : jwtExp(access));
      this.session = {
        accessToken: String(access),
        refreshToken: String(refresh || ""),
        expiresAt: exp || 0,
        email: j.email || jwtClaim(access, "email") || "",
        sub: j.sub || jwtClaim(access, "sub") || "",
        tokenType: j.token_type || "Bearer",
        scope: j.scope || this.scope,
      };
      this.save();
    } catch (e) { /* ignore */ }
  }

  connected() { return !!(this.session && this.session.accessToken); }

  // Safe for the browser: no tokens, no device_code.
  status() {
    const s = this.session;
    const expired = !!(s && s.expiresAt && s.expiresAt < this.now() && !s.refreshToken);
    return {
      connected: this.connected() && !expired,
      email: s ? (s.email || "") : "",
      emailMasked: s ? maskEmail(s.email) : "",
      expiresAt: s ? (s.expiresAt || 0) : 0,
      pending: this.publicPending(),
      source: this.connected() ? "account" : (this.pending ? "pending" : "none"),
      apiBase: this.apiBase,
    };
  }

  async startLogin() {
    this.cancelPoll();
    await this.discover();
    const ep = this.endpoints();
    const res = await this.fetch(ep.device, {
      method: "POST",
      headers: FORM_HEADERS,
      body: formBody({ client_id: this.clientId, scope: this.scope }),
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { j = null; }
    if (!res.ok || !j || !j.device_code || !j.user_code) {
      const msg = (j && (j.error_description || j.error)) || text || res.statusText;
      throw new Error("Grok login gagal memulai (HTTP " + res.status + "): " + String(msg).slice(0, 400));
    }
    const interval = Math.max(1, parseInt(j.interval, 10) || 5);
    const expiresIn = Math.max(30, parseInt(j.expires_in, 10) || 600);
    this.pending = {
      deviceCode: String(j.device_code),
      userCode: String(j.user_code),
      verificationUri: String(j.verification_uri || (ISSUER + "/activate")),
      verificationUriComplete: String(j.verification_uri_complete || j.verification_uri || ""),
      expiresAt: this.now() + expiresIn * 1000,
      interval,
    };
    this.save();
    this.kickPoll();
    return this.status();
  }

  cancelLogin() {
    this.cancelPoll();
    this.pending = null;
    this.save();
    return this.status();
  }

  cancelPoll() {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    this.pollPromise = null;
  }

  kickPoll() {
    if (!this.autoPoll || !this.pending || this.pollPromise) return;
    this.pollPromise = this.pollUntilDone().finally(() => { this.pollPromise = null; });
  }

  async pollUntilDone() {
    while (this.pending) {
      const wait = Math.max(1, (this.pending.interval || 5)) * 1000;
      await sleep(wait);
      if (!this.pending) return;
      try {
        const r = await this.pollOnce();
        if (r === "ok" || r === "expired" || r === "denied") return;
        if (r === "slow_down" && this.pending) this.pending.interval = (this.pending.interval || 5) + 5;
      } catch (e) {
        // Jaringan: coba lagi sampai expires_at.
        if (this.pending && this.now() >= this.pending.expiresAt) {
          this.pending = null;
          this.save();
          return;
        }
      }
    }
  }

  async pollOnce() {
    if (!this.pending) return "idle";
    if (this.now() >= this.pending.expiresAt) {
      this.pending = null;
      this.save();
      return "expired";
    }
    await this.discover();
    const res = await this.fetch(this.endpoints().token, {
      method: "POST",
      headers: FORM_HEADERS,
      body: formBody({
        grant_type: DEVICE_GRANT,
        client_id: this.clientId,
        device_code: this.pending.deviceCode,
      }),
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { j = null; }
    const err = j && j.error;
    if (err === "authorization_pending") return "pending";
    if (err === "slow_down") return "slow_down";
    if (err === "access_denied" || err === "expired_token") {
      this.pending = null;
      this.save();
      return err === "access_denied" ? "denied" : "expired";
    }
    if (!res.ok || !j || !j.access_token) {
      const msg = (j && (j.error_description || j.error)) || text || res.statusText;
      if (res.status >= 500) throw new Error(msg);
      this.pending = null;
      this.save();
      throw new Error("Grok login ditolak (HTTP " + res.status + "): " + String(msg).slice(0, 400));
    }
    await this.acceptTokens(j);
    this.pending = null;
    this.save();
    return "ok";
  }

  async acceptTokens(j) {
    const access = String(j.access_token || "");
    const refresh = String(j.refresh_token || (this.session && this.session.refreshToken) || "");
    const expiresAt = jwtExp(access) || (this.now() + (parseInt(j.expires_in, 10) || 6 * 3600) * 1000);
    let email = jwtClaim(access, "email") || jwtClaim(j.id_token, "email") || (this.session && this.session.email) || "";
    let sub = jwtClaim(access, "sub") || jwtClaim(j.id_token, "sub") || (this.session && this.session.sub) || "";
    this.session = {
      accessToken: access,
      refreshToken: refresh,
      expiresAt,
      email,
      sub,
      tokenType: j.token_type || "Bearer",
      scope: j.scope || this.scope,
    };
    if (!email) {
      try {
        const info = await this.userinfo(access);
        if (info) {
          email = info.email || info.preferred_username || "";
          sub = info.sub || sub;
          this.session.email = email;
          this.session.sub = sub;
        }
      } catch (e) { /* email opsional */ }
    }
  }

  async userinfo(token) {
    await this.discover();
    const res = await this.fetch(this.endpoints().userinfo, {
      headers: { authorization: "Bearer " + token, accept: "application/json", "user-agent": FORM_HEADERS["user-agent"] },
    });
    if (!res.ok) return null;
    return res.json();
  }

  refreshSkew(accessToken) {
    const exp = jwtExp(accessToken);
    if (!exp) return 120000;
    const remaining = exp - this.now();
    if (remaining <= 45 * 60 * 1000) return 120000; // token pendek: 2 menit
    return 5 * 60 * 1000;
  }

  async getAccessToken() {
    if (!this.session || !this.session.accessToken) {
      throw new Error("Belum masuk ke akun Grok. Buka setelan AI dan klik Masuk dengan Grok.");
    }
    const skew = this.refreshSkew(this.session.accessToken);
    if (this.session.expiresAt && this.session.expiresAt - this.now() > skew) return this.session.accessToken;
    if (!this.session.refreshToken) {
      this.session = null;
      this.save();
      throw new Error("Sesi Grok kedaluwarsa. Masuk lagi lewat setelan AI.");
    }
    await this.refresh();
    return this.session.accessToken;
  }

  async refresh() {
    if (!this.session || !this.session.refreshToken) throw new Error("Sesi Grok kedaluwarsa. Masuk lagi lewat setelan AI.");
    await this.discover();
    const res = await this.fetch(this.endpoints().token, {
      method: "POST",
      headers: FORM_HEADERS,
      body: formBody({
        grant_type: "refresh_token",
        client_id: this.clientId,
        refresh_token: this.session.refreshToken,
      }),
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { j = null; }
    if (!res.ok || !j || !j.access_token) {
      const msg = (j && (j.error_description || j.error)) || text || res.statusText;
      if (res.status === 400 || res.status === 401 || /invalid_grant|revoked/i.test(String(msg))) {
        this.session = null;
        this.save();
        throw new Error("Sesi Grok tidak berlaku lagi (refresh ditolak). Masuk lagi lewat setelan AI.");
      }
      throw new Error("Gagal memperbarui sesi Grok (HTTP " + res.status + "): " + String(msg).slice(0, 400));
    }
    await this.acceptTokens(j);
    this.save();
  }

  async logout() {
    this.cancelPoll();
    const token = this.session && (this.session.refreshToken || this.session.accessToken);
    this.session = null;
    this.pending = null;
    this.save();
    if (token) {
      try {
        await this.discover();
        await this.fetch(this.endpoints().revoke, {
          method: "POST",
          headers: FORM_HEADERS,
          body: formBody({ token, client_id: this.clientId }),
        });
      } catch (e) { /* revoke best-effort */ }
    }
    return this.status();
  }
}

GrokAuth.DEFAULT_CLIENT_ID = DEFAULT_CLIENT_ID;
GrokAuth.DEFAULT_SCOPE = DEFAULT_SCOPE;
GrokAuth.DEFAULT_API_BASE = DEFAULT_API_BASE;
GrokAuth.DEVICE_GRANT = DEVICE_GRANT;
GrokAuth.maskEmail = maskEmail;
GrokAuth.jwtExp = jwtExp;

module.exports = GrokAuth;
