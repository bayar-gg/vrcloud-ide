(function (global) {
  "use strict";

  class C9SyncClient {
    constructor() {
      this.handlers = {};
      this.queue = [];
      this.pending = {};
      this.seq = 0;
      this.clientId = null;
      this.socket = null;
      this.closed = false;
      this.retry = 500;
      this.connect();
    }

    on(type, fn) {
      (this.handlers[type] || (this.handlers[type] = [])).push(fn);
      return () => {
        this.handlers[type] = (this.handlers[type] || []).filter((x) => x !== fn);
      };
    }

    emit(type, value) {
      (this.handlers[type] || []).slice().forEach((fn) => {
        try { fn(value); } catch (e) { console.error("sync handler", type, e); }
      });
      (this.handlers["*"] || []).slice().forEach((fn) => {
        try { fn(value); } catch (e) {}
      });
    }

    status(value) {
      this.emit("status", { type: "status", value });
    }

    connect() {
      if (this.closed) return;
      this.status("connecting");
      const proto = location.protocol === "https:" ? "wss://" : "ws://";
      const ws = new WebSocket(proto + location.host + "/sync");
      this.socket = ws;
      ws.onopen = () => {
        this.retry = 500;
        this.status("online");
        const queued = this.queue.splice(0);
        queued.forEach((msg) => this.send(msg));
      };
      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        if (msg.type === "snapshot") this.clientId = msg.clientId;
        if (msg.requestId && this.pending[msg.requestId]) {
          const p = this.pending[msg.requestId];
          delete this.pending[msg.requestId];
          if (msg.type === "error") p.reject(new Error(msg.message));
          else p.resolve(msg);
        }
        this.emit(msg.type, msg);
      };
      ws.onclose = () => {
        if (this.socket !== ws) return;
        this.status("offline");
        setTimeout(() => this.connect(), this.retry);
        this.retry = Math.min(10000, this.retry * 1.7);
      };
      ws.onerror = () => {};
    }

    send(message) {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(message));
      } else {
        // Layout/doc terbaru menggantikan event lama sejenis agar reconnect ringan.
        if (message.type === "layout" || message.type === "doc-change" || message.type === "cursor") {
          this.queue = this.queue.filter((x) => !(x.type === message.type && (!message.path || x.path === message.path)));
        }
        this.queue.push(message);
      }
    }

    request(type, payload) {
      const requestId = "req-" + Date.now().toString(36) + "-" + (++this.seq);
      return new Promise((resolve, reject) => {
        this.pending[requestId] = { resolve, reject };
        this.send(Object.assign({}, payload || {}, { type, requestId }));
        setTimeout(() => {
          if (!this.pending[requestId]) return;
          delete this.pending[requestId];
          reject(new Error("Request timeout"));
        }, 15000);
      });
    }
  }

  global.C9SyncClient = C9SyncClient;
})(window);
