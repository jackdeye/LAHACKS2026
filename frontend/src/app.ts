// AEGIS EDGE — Defense Console Frontend
//
// Connects to the FastAPI backend over WebSocket, streams live telemetry
// into Chart.js views, and orchestrates pipeline-state UI transitions.

// Chart.js is loaded globally via CDN in index.html.
declare const Chart: new (ctx: CanvasRenderingContext2D, config: unknown) => ChartInstance;
interface ChartInstance {
  data: { datasets: { data: Array<number | null> }[] };
  update(mode?: "none" | "active" | "resize" | "show" | "hide"): void;
}

const WS_URL: string = (() => {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const host = location.host || "localhost:8000";
  return `${proto}://${host}/ws`;
})();
const API_BASE: string = location.origin && location.origin.startsWith("http")
  ? location.origin
  : "http://localhost:8000";

const MAX_POINTS = 100;       // 10s @ 10Hz
const STATUS_ORDER = [
  "monitoring",
  "anomaly_detected",
  "llm_processing",
  "flashing",
  "patched",
] as const;
type SystemStatus = typeof STATUS_ORDER[number];
type SensorKey = "temperature" | "pressure" | "current";
type LogLevel = "info" | "ok" | "warn" | "alert" | "ai";
type LinkState = "connecting" | "connected" | "disconnected";

interface Sensors {
  temperature: number;
  pressure: number;
  current: number;
}

interface TelemetryStats {
  temp_variance?: number;
  pressure_variance?: number;
  current_variance?: number;
}

interface TelemetryMsg {
  type: "telemetry";
  sensors: Sensors;
  anomaly: boolean;
  anomaly_confidence: number;
  stats?: TelemetryStats;
}

interface AnomalyMsg {
  type: "anomaly";
  reason: string;
}

interface StatusMsg {
  type: "status";
  status: SystemStatus;
  message?: string;
}

interface LLMResponseMsg {
  type: "llm_response";
  used_fallback: boolean;
  analysis: string;
  code: string;
  timestamp: number;
}

interface FlashCompleteMsg {
  type: "flash_complete";
  success: boolean;
  message: string;
  output: string;
}

interface ConnectedMsg {
  type: "connected";
  simulate_serial: boolean;
  simulate_flash: boolean;
  force_fallback_llm: boolean;
  anomaly_count?: number;
  status?: SystemStatus;
}

interface ErrorMsg {
  type: "error";
  message: string;
}

interface AckMsg {
  type: "ack";
}

type WsMessage =
  | TelemetryMsg
  | AnomalyMsg
  | StatusMsg
  | LLMResponseMsg
  | FlashCompleteMsg
  | ConnectedMsg
  | ErrorMsg
  | AckMsg;

// ── DOM helpers ────────────────────────────────────────────────────────────
function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function bySelector<T extends Element>(selector: string): T {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el as T;
}

// ── Chart factory ──────────────────────────────────────────────────────────
function makeChart(canvasId: string, color: string, yMin: number, yMax: number): ChartInstance {
  const canvas = byId<HTMLCanvasElement>(canvasId);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(`Canvas #${canvasId} has no 2d context`);
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

const charts: Record<SensorKey, ChartInstance> = {
  temperature: makeChart("tempChart", "#00ff9d", 18, 32),
  pressure: makeChart("pressureChart", "#00d4ff", 990, 1040),
  current: makeChart("currentChart", "#b67bff", 0.4, 1.4),
};

function pushPoint(sensor: SensorKey, value: number): void {
  const ds = charts[sensor].data.datasets[0];
  ds.data.push(value);
  if (ds.data.length > MAX_POINTS) ds.data.shift();
  charts[sensor].update("none");
}

const els = {
  systemStatus: byId<HTMLElement>("systemStatus"),
  anomalyCount: byId<HTMLElement>("anomalyCount"),
  linkStatus: byId<HTMLElement>("linkStatus"),
  clock: byId<HTMLElement>("clock"),
  tempReading: byId<HTMLElement>("tempReading"),
  pressureReading: byId<HTMLElement>("pressureReading"),
  currentReading: byId<HTMLElement>("currentReading"),
  tempTag: byId<HTMLElement>("tempTag"),
  pressureTag: byId<HTMLElement>("pressureTag"),
  currentTag: byId<HTMLElement>("currentTag"),
  pipeline: byId<HTMLElement>("pipeline"),
  confFill: byId<HTMLElement>("confFill"),
  confValue: byId<HTMLElement>("confValue"),
  statT: byId<HTMLElement>("statT"),
  statP: byId<HTMLElement>("statP"),
  statI: byId<HTMLElement>("statI"),
  eventLog: byId<HTMLElement>("eventLog"),
  logCount: byId<HTMLElement>("logCount"),
  codeBlock: byId<HTMLElement>("codeBlock"),
  codeTag: byId<HTMLElement>("codeTag"),
  codeMeta: byId<HTMLElement>("codeMeta"),
  codePanel: bySelector<HTMLElement>(".code-panel"),
  modeBadge: byId<HTMLElement>("modeBadge"),
  btnAttack: byId<HTMLButtonElement>("btnAttack"),
  btnClear: byId<HTMLButtonElement>("btnClear"),
};

let logCount = 0;
function log(msg: string, lvl: LogLevel = "info"): void {
  logCount++;
  els.logCount.textContent = String(logCount);
  const ts = new Date().toISOString().slice(11, 19);
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.dataset.lvl = lvl;
  entry.innerHTML = `<span class="ts">${ts}</span><span class="lvl">${lvl.toUpperCase()}</span><span class="msg"></span>`;
  const msgSpan = entry.querySelector(".msg");
  if (msgSpan) msgSpan.textContent = msg;
  els.eventLog.prepend(entry);
  while (els.eventLog.children.length > 200) {
    els.eventLog.lastChild?.remove();
  }
}

function setSystemStatus(status: SystemStatus): void {
  els.systemStatus.textContent = status.toUpperCase().replace(/_/g, " ");
  els.systemStatus.dataset.state = status;

  const idx = STATUS_ORDER.indexOf(status);
  els.pipeline.querySelectorAll<HTMLElement>(".step").forEach((step) => {
    const stepName = step.dataset.step ?? "";
    const stepIdx = (STATUS_ORDER as readonly string[]).indexOf(stepName);
    step.classList.toggle("active", stepIdx === idx);
    step.classList.toggle("done", stepIdx >= 0 && stepIdx < idx);
  });
}

function setLinkStatus(state: LinkState): void {
  els.linkStatus.textContent = state.toUpperCase();
  els.linkStatus.dataset.state = state;
}

// ── Telemetry handling ────────────────────────────────────────────────────
let lastSensors: Sensors | null = null;
function handleTelemetry(msg: TelemetryMsg): void {
  const { sensors, anomaly, anomaly_confidence, stats } = msg;
  lastSensors = sensors;

  pushPoint("temperature", sensors.temperature);
  pushPoint("pressure", sensors.pressure);
  pushPoint("current", sensors.current);

  els.tempReading.innerHTML = `${sensors.temperature.toFixed(2)} <span>°C</span>`;
  els.pressureReading.innerHTML = `${sensors.pressure.toFixed(2)} <span>hPa</span>`;
  els.currentReading.innerHTML = `${sensors.current.toFixed(3)} <span>A</span>`;

  const tempPanel = bySelector<HTMLElement>('[data-sensor="temperature"]');
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
function handleAnomaly(msg: AnomalyMsg): void {
  setSystemStatus("anomaly_detected");
  bySelector<HTMLElement>('[data-sensor="temperature"]').classList.add("alert");
  log(msg.reason, "alert");
}

function handleStatus(msg: StatusMsg): void {
  setSystemStatus(msg.status);
  if (msg.message) {
    const lvl: LogLevel =
      msg.status === "llm_processing" ? "ai" :
      msg.status === "flashing" ? "warn" :
      msg.status === "monitoring" ? "ok" : "info";
    log(msg.message, lvl);
  }
  if (msg.status === "monitoring") {
    bySelector<HTMLElement>('[data-sensor="temperature"]').classList.remove("alert");
  }
}

let typeAnimToken = 0;
function typeCode(code: string): void {
  const myToken = ++typeAnimToken;
  els.codeBlock.textContent = "";
  let i = 0;
  const speed = Math.max(1, Math.floor(code.length / 600));
  function step(): void {
    if (myToken !== typeAnimToken) return;
    const next = Math.min(code.length, i + speed);
    els.codeBlock.textContent = code.slice(0, next);
    const parent = els.codeBlock.parentElement;
    if (parent) parent.scrollTop = parent.scrollHeight;
    i = next;
    if (i < code.length) requestAnimationFrame(step);
  }
  step();
}

function handleLLMResponse(msg: LLMResponseMsg): void {
  els.codeTag.textContent = msg.used_fallback ? "FALLBACK PATCH" : "AI PATCH";
  els.codeTag.dataset.state = "processing";
  els.codePanel.classList.add("live");
  els.codeMeta.textContent = `${msg.analysis} · ${msg.code.length} bytes · ${new Date(msg.timestamp * 1000).toISOString().slice(11, 19)}`;
  typeCode(msg.code);
  log(msg.analysis, "ai");
}

function handleFlashComplete(msg: FlashCompleteMsg): void {
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

function handleConnected(msg: ConnectedMsg): void {
  log(`Link established · sim_serial=${msg.simulate_serial} sim_flash=${msg.simulate_flash} fallback_llm=${msg.force_fallback_llm}`, "ok");
  els.modeBadge.textContent = msg.simulate_serial ? "SIMULATION" : "LIVE HARDWARE";
  els.anomalyCount.textContent = String(msg.anomaly_count ?? 0);
  setSystemStatus(msg.status ?? "monitoring");
}

// ── WebSocket ─────────────────────────────────────────────────────────────
let ws: WebSocket | null = null;
let reconnectDelay = 500;

function connect(): void {
  setLinkStatus("connecting");
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setLinkStatus("connected");
    reconnectDelay = 500;
  };

  ws.onmessage = (ev: MessageEvent<string>) => {
    let msg: WsMessage;
    try {
      msg = JSON.parse(ev.data) as WsMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "telemetry":
        handleTelemetry(msg);
        break;
      case "anomaly":
        handleAnomaly(msg);
        els.anomalyCount.textContent = String(parseInt(els.anomalyCount.textContent ?? "0", 10) + 1);
        break;
      case "status":
        handleStatus(msg);
        break;
      case "llm_response":
        handleLLMResponse(msg);
        break;
      case "flash_complete":
        handleFlashComplete(msg);
        break;
      case "connected":
        handleConnected(msg);
        break;
      case "error":
        log(msg.message, "alert");
        break;
      case "ack":
        break;
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
async function postJSON(path: string): Promise<void> {
  try {
    await fetch(`${API_BASE}${path}`, { method: "POST" });
  } catch (e) {
    const err = e as Error;
    log(`POST ${path} failed: ${err.message}`, "alert");
  }
}

els.btnAttack.addEventListener("click", () => {
  log("Operator triggered EMI attack simulation", "warn");
  void postJSON("/api/simulate/attack");
});
els.btnClear.addEventListener("click", () => {
  log("Operator cleared attack simulation", "info");
  void postJSON("/api/simulate/clear");
});

// ── Clock ─────────────────────────────────────────────────────────────────
setInterval(() => {
  els.clock.textContent = new Date().toISOString().slice(11, 19);
}, 1000);

// ── Boot ──────────────────────────────────────────────────────────────────
log("Console initialized — establishing link to backend", "info");
connect();
