// A tiny page for watching the live feed during development: log in as the demo admin and see every rider move.
// Only served when NODE_ENV is not production. It uses the demo admin account created by `npm run db:seed`.
export const LIVE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RELAY live feed (dev only)</title>
<style>
  body { margin: 0; background: #070B14; color: #F4F1EA; font: 14px system-ui, sans-serif; }
  #bar { display: flex; gap: 8px; align-items: center; padding: 12px; flex-wrap: wrap; }
  input, button { padding: 6px 10px; border-radius: 6px; border: 1px solid #334; background: #10182a; color: inherit; }
  button { background: #FFB347; color: #070B14; border: 0; font-weight: 600; cursor: pointer; }
  #map { display: block; width: 100%; max-width: 900px; background: #0b1224; border-top: 1px solid #223; border-bottom: 1px solid #223; }
  #log { margin: 0; padding: 12px; color: #A9B1C3; font-size: 12px; white-space: pre-wrap; max-height: 220px; overflow: auto; }
</style>
</head>
<body>
<div id="bar">
  <strong>RELAY live feed</strong>
  <input id="email" value="admin@relay.demo" aria-label="Admin email">
  <input id="password" type="password" value="relay-demo-123" aria-label="Password">
  <button id="go">Connect</button>
  <span id="status">disconnected</span>
  <span id="count"></span>
</div>
<canvas id="map" width="900" height="560"></canvas>
<pre id="log"></pre>
<script src="/socket.io/socket.io.js"></script>
<script>
  var BOX = { minLat: 8.95, maxLat: 9.2, minLng: 7.3, maxLng: 7.65 };
  var riders = {};
  var canvas = document.getElementById("map");
  var ctx = canvas.getContext("2d");
  var statusEl = document.getElementById("status");
  var logEl = document.getElementById("log");

  function project(lat, lng) {
    return [
      ((lng - BOX.minLng) / (BOX.maxLng - BOX.minLng)) * canvas.width,
      (1 - (lat - BOX.minLat) / (BOX.maxLat - BOX.minLat)) * canvas.height,
    ];
  }
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#16203a";
    for (var i = 1; i < 10; i++) {
      ctx.beginPath(); ctx.moveTo((canvas.width / 10) * i, 0); ctx.lineTo((canvas.width / 10) * i, canvas.height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, (canvas.height / 10) * i); ctx.lineTo(canvas.width, (canvas.height / 10) * i); ctx.stroke();
    }
    var ids = Object.keys(riders);
    document.getElementById("count").textContent = ids.length + " riders";
    ids.forEach(function (id) {
      var r = riders[id], p = project(r.lat, r.lng);
      ctx.fillStyle = r.orderId ? "#FFB347" : "#5CA9FF";
      ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#F4F1EA"; ctx.font = "11px system-ui";
      ctx.fillText(id.slice(0, 4) + (r.orderId ? " (on order)" : ""), p[0] + 10, p[1] + 4);
    });
  }
  function log(msg) {
    logEl.textContent = new Date().toLocaleTimeString() + "  " + msg + "\\n" + logEl.textContent.split("\\n").slice(0, 40).join("\\n");
  }
  document.getElementById("go").onclick = function () {
    fetch("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: document.getElementById("email").value, password: document.getElementById("password").value }),
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        if (!r.ok) { statusEl.textContent = "login failed"; return; }
        var socket = io({ auth: { token: r.data.accessToken } });
        socket.on("connect", function () { statusEl.textContent = "connected"; });
        socket.on("disconnect", function () { statusEl.textContent = "disconnected (reconnect with a fresh login)"; });
        socket.on("connect_error", function (e) { statusEl.textContent = "error: " + e.message; });
        socket.on("rider:location", function (p) { riders[p.riderId] = p; draw(); });
        socket.on("order:status", function (p) { log("order " + p.orderId.slice(0, 8) + " is " + p.status); });
        socket.on("admin:alert", function (p) { log("ALERT order " + p.orderId.slice(0, 8) + ": " + p.reason + " after " + p.attempts + " rounds"); });
      });
  };
  draw();
</script>
</body>
</html>`;
