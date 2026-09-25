"use strict";

/**
 * Brankas rahasia untuk browser agent (kata sandi, token, OTP seed, dll).
 *
 * Nilai disimpan terenkripsi AES-256-GCM di data/browser-secrets.json; kunci
 * diturunkan (scrypt) dari AUTH_SECRET server + salt acak per berkas. Agent
 * hanya melihat NAMA rahasia; nilainya diketik langsung oleh tool browser_type
 * ({ secret: nama }) dan tidak pernah masuk ke percakapan/log.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const NAME_RE = /^[a-zA-Z0-9_.-]{1,64}$/;

class BrowserSecrets {
  constructor(options) {
    this.file = options.file;
    this.masterSecret = String(options.secret || "");
    this.data = { salt: "", items: {} };
    this.key = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
        if (d && typeof d === "object" && d.items) this.data = { salt: String(d.salt || ""), items: d.items };
      }
    } catch (e) { console.warn("[secrets] berkas rahasia tidak valid, diabaikan:", e.message); }
    if (!this.data.salt) this.data.salt = crypto.randomBytes(16).toString("hex");
    this.key = crypto.scryptSync(this.masterSecret, Buffer.from(this.data.salt, "hex"), 32);
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
    if (process.platform !== "win32") { try { fs.chmodSync(this.file, 0o600); } catch (e) {} }
  }

  list() { return Object.keys(this.data.items).sort(); }
  has(name) { return Object.prototype.hasOwnProperty.call(this.data.items, String(name)); }

  // Metadata untuk UI (tanpa nilai).
  describe() {
    return this.list().map((name) => { const it = this.data.items[name]; return { name, createdAt: it.createdAt || 0, updatedAt: it.updatedAt || it.createdAt || 0, note: it.note || "" }; });
  }

  set(name, value, note) {
    name = String(name || "").trim();
    if (!NAME_RE.test(name)) throw new Error("Nama rahasia hanya huruf/angka/_ . - (maks 64)");
    value = String(value == null ? "" : value);
    if (!value) throw new Error("Nilai rahasia kosong");
    if (value.length > 4096) throw new Error("Nilai rahasia terlalu panjang");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const prev = this.data.items[name];
    this.data.items[name] = { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), data: enc.toString("hex"), note: String(note || (prev && prev.note) || "").slice(0, 200), createdAt: (prev && prev.createdAt) || Date.now(), updatedAt: Date.now() };
    this.save();
  }

  get(name) {
    const it = this.data.items[String(name)];
    if (!it) return null;
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(it.iv, "hex"));
      d.setAuthTag(Buffer.from(it.tag, "hex"));
      return Buffer.concat([d.update(Buffer.from(it.data, "hex")), d.final()]).toString("utf8");
    } catch (e) { return null; } // AUTH_SECRET berubah → tidak bisa didekripsi
  }

  remove(name) {
    if (!this.has(name)) return false;
    delete this.data.items[String(name)];
    this.save();
    return true;
  }
}

module.exports = BrowserSecrets;
