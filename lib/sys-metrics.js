"use strict";

/**
 * Metrik sistem ringan untuk indikator di menubar: % CPU, % RAM, dan GPU
 * (utilisasi + VRAM) bila ada.
 *
 * - CPU  : selisih waktu idle/total dari os.cpus() antar sampel.
 * - RAM  : Linux memakai MemAvailable (/proc/meminfo) agar cache tidak
 *          dihitung terpakai; platform lain memakai os.freemem().
 * - GPU  : nvidia-smi (Windows/Linux) -> AMD sysfs (Linux) ->
 *          Get-Counter GPU Engine (Windows, lambat, hanya utilisasi).
 *
 * Sampling hanya berjalan selama ada klien yang meminta (touch()) supaya
 * server idle tidak terus memanggil nvidia-smi.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFile, spawnSync } = require("child_process");

const IS_WINDOWS = process.platform === "win32";

function cpuTimes() {
  let idle = 0, total = 0;
  os.cpus().forEach((c) => {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  });
  return { idle, total };
}

function hasBin(bin, args) {
  try { return spawnSync(bin, args || ["--version"], { stdio: "ignore", windowsHide: true, timeout: 5000 }).status === 0; }
  catch (e) { return false; }
}

class SysMetrics {
  constructor(options) {
    options = options || {};
    this.intervalMs = options.intervalMs || 2000;
    this.activeWindowMs = options.activeWindowMs || 30000;
    this.lastTouch = 0;
    this.prevCpu = cpuTimes();
    this.cpuPercent = 0;
    this.gpu = [];          // sampel terbaru
    this.gpuInfo = [];      // statis: nama + VRAM
    this.gpuMode = "none";  // nvidia | amd-sysfs | win-counter | none
    this.gpuBusy = false;
    this.lastGpuAt = 0;
    this.detectGpu();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  touch() { this.lastTouch = Date.now(); }
  active() { return Date.now() - this.lastTouch < this.activeWindowMs; }

  // ---- deteksi GPU (sekali, asinkron) --------------------------------------
  detectGpu() {
    if (hasBin("nvidia-smi", ["--version"])) {
      this.gpuMode = "nvidia";
      execFile("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"],
        { timeout: 8000, windowsHide: true }, (err, out) => {
          if (err) return;
          this.gpuInfo = String(out).trim().split(/\r?\n/).filter(Boolean).map((line) => {
            const p = line.split(",").map((s) => s.trim());
            return { name: p[0], memoryMb: parseInt(p[1], 10) || 0, driver: p[2] || "", vendor: "NVIDIA" };
          });
        });
      return;
    }
    if (process.platform === "linux") {
      const cards = this.amdCards();
      if (cards.length) {
        this.gpuMode = "amd-sysfs";
        this.gpuInfo = cards.map((c) => ({
          name: c.name, vendor: "AMD",
          memoryMb: Math.round((this.readNum(path.join(c.dev, "mem_info_vram_total")) || 0) / 1048576),
        }));
        return;
      }
      // Nama saja (tanpa utilisasi) dari lspci.
      execFile("sh", ["-c", "lspci 2>/dev/null | grep -iE 'vga|3d|display'"], { timeout: 5000 }, (err, out) => {
        if (err || !out) return;
        this.gpuInfo = String(out).trim().split(/\r?\n/).filter(Boolean).map((l) => ({ name: l.replace(/^[0-9a-f:.]+\s+[^:]+:\s*/i, "").trim(), memoryMb: 0, vendor: "" }));
      });
      return;
    }
    if (IS_WINDOWS) {
      this.gpuMode = "win-counter";
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_VideoController | Where-Object { $_.AdapterRAM -gt 0 -or $_.Name -notmatch 'Remote|Basic' } | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress"],
        { timeout: 15000, windowsHide: true }, (err, out) => {
          if (err || !out) return;
          try {
            let j = JSON.parse(String(out)); if (!Array.isArray(j)) j = [j];
            this.gpuInfo = j.filter((g) => g && g.Name).map((g) => ({ name: g.Name, memoryMb: Math.round((g.AdapterRAM || 0) / 1048576), driver: g.DriverVersion || "", vendor: "" }));
          } catch (e) {}
        });
    }
  }

  amdCards() {
    const out = [];
    try {
      fs.readdirSync("/sys/class/drm").filter((n) => /^card\d+$/.test(n)).forEach((n) => {
        const dev = path.join("/sys/class/drm", n, "device");
        if (!fs.existsSync(path.join(dev, "gpu_busy_percent"))) return;
        let name = "AMD GPU";
        try { name = fs.readFileSync(path.join(dev, "product_name"), "utf8").trim() || name; } catch (e) {}
        out.push({ dev, name });
      });
    } catch (e) {}
    return out;
  }

  readNum(file) { try { return parseFloat(fs.readFileSync(file, "utf8")); } catch (e) { return null; } }

  // ---- sampling --------------------------------------------------------------
  tick() {
    if (!this.active()) return;
    const cur = cpuTimes();
    const dIdle = cur.idle - this.prevCpu.idle, dTotal = cur.total - this.prevCpu.total;
    if (dTotal > 0) this.cpuPercent = Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
    this.prevCpu = cur;
    const gpuEvery = this.gpuMode === "win-counter" ? 8000 : 3000;
    if (this.gpuMode !== "none" && !this.gpuBusy && Date.now() - this.lastGpuAt >= gpuEvery) this.sampleGpu();
  }

  sampleGpu() {
    this.gpuBusy = true;
    const done = (list) => { this.gpuBusy = false; this.lastGpuAt = Date.now(); if (list) this.gpu = list; };
    if (this.gpuMode === "nvidia") {
      execFile("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"],
        { timeout: 6000, windowsHide: true }, (err, out) => {
          if (err) return done(null);
          done(String(out).trim().split(/\r?\n/).filter(Boolean).map((line) => {
            const p = line.split(",").map((s) => s.trim());
            return { name: p[0], utilPercent: parseInt(p[1], 10) || 0, memUsedMb: parseInt(p[2], 10) || 0, memTotalMb: parseInt(p[3], 10) || 0, tempC: parseInt(p[4], 10) || null };
          }));
        });
      return;
    }
    if (this.gpuMode === "amd-sysfs") {
      const list = this.amdCards().map((c) => ({
        name: c.name,
        utilPercent: Math.round(this.readNum(path.join(c.dev, "gpu_busy_percent")) || 0),
        memUsedMb: Math.round((this.readNum(path.join(c.dev, "mem_info_vram_used")) || 0) / 1048576),
        memTotalMb: Math.round((this.readNum(path.join(c.dev, "mem_info_vram_total")) || 0) / 1048576),
        tempC: null,
      }));
      return done(list);
    }
    if (this.gpuMode === "win-counter") {
      // Utilisasi total mesin 3D dari semua proses (Windows tanpa nvidia-smi).
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "(Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples | Measure-Object -Property CookedValue -Sum | Select-Object -ExpandProperty Sum"],
        { timeout: 12000, windowsHide: true }, (err, out) => {
          if (err) return done(null);
          const util = Math.max(0, Math.min(100, Math.round(parseFloat(String(out).trim().replace(",", ".")) || 0)));
          const info = this.gpuInfo[0] || { name: "GPU", memoryMb: 0 };
          done([{ name: info.name, utilPercent: util, memUsedMb: null, memTotalMb: info.memoryMb || null, tempC: null }]);
        });
      return;
    }
    done(null);
  }

  memory() {
    const total = os.totalmem();
    let available = os.freemem();
    if (process.platform === "linux") {
      try {
        const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(fs.readFileSync("/proc/meminfo", "utf8"));
        if (m) available = parseInt(m[1], 10) * 1024;
      } catch (e) {}
    }
    const used = Math.max(0, total - available);
    return { totalGb: Math.round(total / 1073741824 * 10) / 10, usedGb: Math.round(used / 1073741824 * 10) / 10, percent: Math.round(used / total * 100) };
  }

  snapshot() {
    this.touch();
    const la = os.loadavg();
    return {
      ts: Date.now(),
      cpu: { percent: this.cpuPercent, cores: os.cpus().length, load1: IS_WINDOWS ? null : Math.round(la[0] * 100) / 100 },
      mem: this.memory(),
      gpu: this.gpu,
      gpuMode: this.gpuMode,
    };
  }

  info() { return { mode: this.gpuMode, devices: this.gpuInfo }; }
}

SysMetrics.hasBin = hasBin;
module.exports = SysMetrics;
