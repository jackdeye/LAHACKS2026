// AEGIS EDGE — Defense Console Frontend
//
// Connects to the FastAPI backend over WebSocket, streams live telemetry
// into Chart.js views, and orchestrates pipeline-state UI transitions.

const WS_URL = (() => {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const host = location.host || "localhost:8000";
  return `${proto}://${host}/ws`;
})();
const API_BASE = location.origin && location.origin.startsWith("http")
  ? location.origin
  : "http://localhost:8000";

const MAX_POINTS = 100;       // 10s @ 10Hz
const STATUS_ORDER = ["monitoring", "anomaly_detected", "llm_processing", "flashing", "patched"];

// ── Chart factory ──────────────────────────────────────────────────────────
function makeChart(canvasId, color, yMin, yMax) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  return new Chart(ctx, {
    type: "line",
    data: {
      labels: Array(MAX_POINTS).fill(""),
      datasets: [{
        data: Array(MAX_POINTS).fill(null),
        borderColor: color,
        backgroundColor: `${color}1f`,
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.3,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false, grid: { display: false } },
        y: {
          min: yMin, max: yMax,
          grid: { color: "rgba(255,255,255,0.04)" },
          ticks: {
            color: "#4d6280",
            font: { family: "JetBrains Mono", size: 10 },
            maxTicksLimit: 4,
          },
        },
      },
    },
  });
}

const charts = {
  temperature: makeChart("tempChart", "#00ff9d", 18, 32),
  pressure: makeChart("pressureChart", "#00d4ff", 990, 1040),
  current: makeChart("currentChart", "#b67bff", 0.4, 1.4),
};

function pushPoint(sensor, value) {
  const ds = charts[sensor].data.datasets[0];
  ds.data.push(value);
  if (ds.data.length > MAX_POINTS) ds.data.shift();
  charts[sensor].update("none");
}

// ── DOM helpers ────────────────────────────────────────────────────────────
const els = {
  systemStatus: document.getElementById("systemStatus"),
  anomalyCount: document.getElementById("anomalyCount"),
  linkStatus: document.getElementById("linkStatus"),
  clock: document.getElementById("clock"),
  tempReading: document.getElementById("tempReading"),
  pressureReading: document.getElementById("pressureReading"),
  currentReading: document.getElementById("currentReading"),
  tempTag: document.getElementById("tempTag"),
  pressureTag: document.getElementById("pressureTag"),
  currentTag: document.getElementById("currentTag"),
  pipeline: document.getElementById("pipeline"),
  confFill: document.getElementById("confFill"),
  confValue: document.getElementById("confValue"),
  statT: document.getElementById("statT"),
  statP: document.getElementById("statP"),
  statI: document.getElementById("statI"),
  eventLog: document.getElementById("eventLog"),
  logCount: document.getElementById("logCount"),
  codeBlock: document.getElementById("codeBlock"),
  codeTag: document.getElementById("codeTag"),
  codeMeta: document.getElementById("codeMeta"),
  codePanel: document.querySelector(".code-panel"),
  modeBadge: document.getElementById("modeBadge"),
  btnAttack: document.getElementById("btnAttack"),
  btnClear: document.getElementById("btnClear"),
};

let logCount = 0;
function log(msg, lvl = "info") {
  logCount++;
  els.logCount.textContent = String(logCount);
  const ts = new Date().toISOString().slice(11, 19);
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.dataset.lvl = lvl;
  entry.innerHTML = `<span class="ts">${ts}</span><span class="lvl">${lvl.toUpperCase()}</span><span class="msg"></span>`;
  entry.querySelector(".msg").textContent = msg;
  els.eventLog.prepend(entry);
  while (els.eventLog.children.length > 200) els.eventLog.lastChild.remove();
}

function setSystemStatus(status) {
  els.systemStatus.textContent = status.toUpperCase().replace(/_/g, " ");
  els.systemStatus.dataset.state = status;

  const idx = STATUS_ORDER.indexOf(status);
  els.pipeline.querySelectorAll(".step").forEach((step) => {
    const stepIdx = STATUS_ORDER.indexOf(step.dataset.step);
    step.classList.toggle("active", stepIdx === idx);
    step.classList.toggle("done", stepIdx >= 0 && stepIdx < idx);
  });
}

function setLinkStatus(state) {
  els.linkStatus.textContent = state.toUpperCase();
  els.linkStatus.dataset.state = state;
}

// ── Telemetry handling ────────────────────────────────────────────────────
let lastSensors = null;
function handleTelemetry(msg) {
  const { sensors, anomaly, anomaly_confidence, stats } = msg;
  lastSensors = sensors;

  pushPoint("temperature", sensors.temperature);
  pushPoint("pressure", sensors.pressure);
  pushPoint("current", sensors.current);

  els.tempReading.innerHTML = `${sensors.temperature.toFixed(2)} <span>°C</span>`;
  els.pressureReading.innerHTML = `${sensors.pressure.toFixed(2)} <span>hPa</span>`;
  els.currentReading.innerHTML = `${sensors.current.toFixed(3)} <span>A</span>`;

  // Anomaly visual cue on the temp panel
  const tempPanel = document.querySelector('[data-sensor="temperature"]');
  tempPanel.dataset.flatlined = anomaly ? "true" : "false";
  els.tempTag.textContent = anomaly ? "FLATLINED" : "NOMINAL";
  els.tempTag.dataset.state = anomaly ? "anomaly" : "";

  if (stats) {
    if (stats.temp_variance !== undefined) els.statT.textContent = stats.temp_variance.toFixed(4);
    if (stats.pressure_variance !== undefined) els.statP.textContent = stats.pressure_variance.toFixed(2);
    if (stats.current_variance !== undefined) els.statI.textContent = stats.current_variance.toFixed(4);
  }

  const conf = Math.round((anomaly_confidence || 0) * 100);
  els.confFill.style.width = `${conf}%`;
  els.confValue.textContent = `${conf}%`;
}

// ── Pipeline events ───────────────────────────────────────────────────────
function handleAnomaly(msg) {
  setSystemStatus("anomaly_detected");
  document.querySelector('[data-sensor="temperature"]').classList.add("alert");
  log(msg.reason, "alert");
}

function handleStatus(msg) {
  setSystemStatus(msg.status);
  if (msg.message) {
    const lvl = msg.status === "llm_processing" ? "ai" :
                msg.status === "flashing" ? "warn" :
                msg.status === "monitoring" ? "ok" : "info";
    log(msg.message, lvl);
  }
  if (msg.status === "monitoring") {
    document.querySelector('[data-sensor="temperature"]').classList.remove("alert");
  }
}

let typeAnimToken = 0;
function typeCode(code) {
  const myToken = ++typeAnimToken;
  els.codeBlock.textContent = "";
  let i = 0;
  const speed = Math.max(1, Math.floor(code.length / 600));
  function step() {
    if (myToken !== typeAnimToken) return;
    const next = Math.min(code.length, i + speed);
    els.codeBlock.textContent = code.slice(0, next);
    els.codeBlock.parentElement.scrollTop = els.codeBlock.parentElement.scrollHeight;
    i = next;
    if (i < code.length) requestAnimationFrame(step);
  }
  step();
}

function handleLLMResponse(msg) {
  els.codeTag.textContent = msg.used_fallback ? "FALLBACK PATCH" : "AI PATCH";
  els.codeTag.dataset.state = "processing";
  els.codePanel.classList.add("live");
  els.codeMeta.textContent = `${msg.analysis} · ${msg.code.length} bytes · ${new Date(msg.timestamp * 1000).toISOString().slice(11, 19)}`;
  typeCode(msg.code);
  log(msg.analysis, "ai");
}

function handleFlashComplete(msg) {
  if (msg.success) {
    els.codeTag.textContent = "FLASHED";
    els.codeTag.dataset.state = "patched";
    els.codePanel.classList.remove("live");
    log(msg.message, "ok");
    log(msg.output.split("\n").slice(0, 3).join(" · "), "info");
  } else {
    els.codeTag.textContent = "FLASH FAILED";
    els.codeTag.dataset.state = "anomaly";
    log(msg.message, "alert");
  }
}

function handleConnected(msg) {
  log(`Link established · sim_serial=${msg.simulate_serial} sim_flash=${msg.simulate_flash} fallback_llm=${msg.force_fallback_llm}`, "ok");
  els.modeBadge.textContent = msg.simulate_serial ? "SIMULATION" : "LIVE HARDWARE";
  els.anomalyCount.textContent = String(msg.anomaly_count || 0);
  setSystemStatus(msg.status || "monitoring");
}

// ── WebSocket ─────────────────────────────────────────────────────────────
let ws;
let reconnectDelay = 500;

function connect() {
  setLinkStatus("connecting");
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setLinkStatus("connected");
    reconnectDelay = 500;
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case "telemetry": handleTelemetry(msg); break;
      case "anomaly": handleAnomaly(msg); els.anomalyCount.textContent = String(parseInt(els.anomalyCount.textContent) + 1); break;
      case "status": handleStatus(msg); break;
      case "llm_response": handleLLMResponse(msg); break;
      case "flash_complete": handleFlashComplete(msg); break;
      case "connected": handleConnected(msg); break;
      case "error": log(msg.message, "alert"); break;
      case "ack": /* no-op */ break;
    }
  };

  ws.onclose = () => {
    setLinkStatus("disconnected");
    log("Link lost — reconnecting…", "warn");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  };

  ws.onerror = () => { /* onclose will handle reconnect */ };
}

// ── Controls ──────────────────────────────────────────────────────────────
async function postJSON(path) {
  try {
    await fetch(`${API_BASE}${path}`, { method: "POST" });
  } catch (e) {
    log(`POST ${path} failed: ${e.message}`, "alert");
  }
}

els.btnAttack.addEventListener("click", () => {
  log("Operator triggered EMI attack simulation", "warn");
  postJSON("/api/simulate/attack");
});
els.btnClear.addEventListener("click", () => {
  log("Operator cleared attack simulation", "info");
  postJSON("/api/simulate/clear");
});

// ── Clock ─────────────────────────────────────────────────────────────────
setInterval(() => {
  els.clock.textContent = new Date().toISOString().slice(11, 19);
}, 1000);

// ── Boot ──────────────────────────────────────────────────────────────────
log("Console initialized — establishing link to backend", "info");
connect();
