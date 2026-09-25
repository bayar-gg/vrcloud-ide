"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

function localIpv4() {
  const ips = new Set(["127.0.0.1"]);
  const nics = os.networkInterfaces();
  Object.keys(nics).forEach((name) => {
    (nics[name] || []).forEach((info) => {
      const v4 = info.family === "IPv4" || info.family === 4;
      if (v4 && info.address && info.address !== "0.0.0.0") ips.add(info.address);
    });
  });
  return Array.from(ips);
}

function publicIpv4() {
  const bin = process.platform === "win32" ? "curl.exe" : "curl";
  try {
    const r = spawnSync(bin, ["-4", "-fsS", "--max-time", "3", "https://ip.me"], {
      encoding: "utf8", timeout: 5000, windowsHide: true,
    });
    const ip = String(r.stdout || "").trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  } catch (e) {}
  return "";
}

function extraNames() {
  return String(process.env.TLS_SAN || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

function isIpv4(s) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
}

function wantedNames() {
  const ips = localIpv4();
  const pub = publicIpv4();
  if (pub) ips.push(pub);
  const dns = ["localhost"];
  extraNames().forEach((n) => { if (isIpv4(n)) ips.push(n); else dns.push(n); });
  return {
    ips: Array.from(new Set(ips)),
    dns: Array.from(new Set(dns)),
  };
}

function sanText(names) {
  return names.dns.map((d) => "DNS:" + d).concat(names.ips.map((ip) => "IP:" + ip)).join(",");
}

function stampOf(names) {
  return names.dns.join(",") + "|" + names.ips.join(",");
}

function readUserMaterial() {
  const cert = process.env.TLS_CERT || "";
  const key = process.env.TLS_KEY || "";
  if (cert && key && fs.existsSync(cert) && fs.existsSync(key)) {
    return { cert: fs.readFileSync(cert), key: fs.readFileSync(key), selfSigned: false, ips: [], dns: [] };
  }
  return null;
}

function tryOpenssl(keyPath, certPath, names) {
  const r = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "825", "-nodes",
    "-keyout", keyPath, "-out", certPath,
    "-subj", "/CN=VRCloud",
    "-addext", "subjectAltName=" + sanText(names),
  ], { encoding: "utf8", timeout: 30000, windowsHide: true });
  return r.status === 0 && fs.existsSync(keyPath) && fs.existsSync(certPath);
}

function tryPowershell(pfxPath, names) {
  const ext = "2.5.29.17={text}" + names.dns.map((d) => "DNS=" + d).concat(names.ips.map((ip) => "IPAddress=" + ip)).join("&");
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "$cert = New-SelfSignedCertificate -Subject 'CN=VRCloud' -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(825) -TextExtension @('" + ext.replace(/'/g, "''") + "')",
    "$pwd = ConvertTo-SecureString 'vrcloud' -Force -AsPlainText",
    "Export-PfxCertificate -Cert $cert -FilePath '" + pfxPath.replace(/'/g, "''") + "' -Password $pwd | Out-Null",
    "Remove-Item -LiteralPath ('Cert:\\CurrentUser\\My\\' + $cert.Thumbprint) -Force",
  ].join("; ");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8", timeout: 40000, windowsHide: true,
  });
  return r.status === 0 && fs.existsSync(pfxPath);
}

// Sertifikat untuk https://IP:PORT. Pakai TLS_CERT/TLS_KEY bila diisi;
// kalau tidak, buat self-signed yang memuat localhost dan IP mesin.
function ensureTlsMaterial(dir) {
  const user = readUserMaterial();
  if (user) return user;
  fs.mkdirSync(dir, { recursive: true });
  const names = wantedNames();
  const stamp = stampOf(names);
  const stampPath = path.join(dir, "san.txt");
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  const pfxPath = path.join(dir, "cert.pfx");
  const have = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, "utf8").trim() : "";
  if (have === stamp && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), selfSigned: true, ips: names.ips, dns: names.dns };
  }
  if (have === stamp && fs.existsSync(pfxPath)) {
    return { pfx: fs.readFileSync(pfxPath), passphrase: "vrcloud", selfSigned: true, ips: names.ips, dns: names.dns };
  }
  const tmpKey = keyPath + ".tmp";
  const tmpCert = certPath + ".tmp";
  try { fs.unlinkSync(tmpKey); } catch (e) {}
  try { fs.unlinkSync(tmpCert); } catch (e) {}
  if (tryOpenssl(tmpKey, tmpCert, names)) {
    try { fs.unlinkSync(keyPath); } catch (e) {}
    try { fs.unlinkSync(certPath); } catch (e) {}
    fs.renameSync(tmpKey, keyPath);
    fs.renameSync(tmpCert, certPath);
    try { fs.chmodSync(keyPath, 0o600); } catch (e) {}
    try { fs.unlinkSync(pfxPath); } catch (e) {}
    fs.writeFileSync(stampPath, stamp, "utf8");
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), selfSigned: true, ips: names.ips, dns: names.dns };
  }
  try { fs.unlinkSync(tmpKey); } catch (e) {}
  try { fs.unlinkSync(tmpCert); } catch (e) {}
  const tmpPfx = pfxPath + ".tmp";
  try { fs.unlinkSync(tmpPfx); } catch (e) {}
  if (process.platform === "win32" && tryPowershell(tmpPfx, names)) {
    try { fs.unlinkSync(pfxPath); } catch (e) {}
    fs.renameSync(tmpPfx, pfxPath);
    try { fs.unlinkSync(certPath); } catch (e) {}
    try { fs.unlinkSync(keyPath); } catch (e) {}
    fs.writeFileSync(stampPath, stamp, "utf8");
    return { pfx: fs.readFileSync(pfxPath), passphrase: "vrcloud", selfSigned: true, ips: names.ips, dns: names.dns };
  }
  throw new Error("Tidak bisa membuat sertifikat TLS. Pasang openssl, atau isi TLS_CERT dan TLS_KEY di .env.");
}

module.exports = { ensureTlsMaterial };
