// AEGIS EDGE — Agent Mesh Frontend
//
// Connects to the FastAPI backend over WebSocket and translates pipeline
// events into agent-graph state transitions. Each backend status maps to one
// of four conceptual agents shown as nodes in the canvas.

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

const MAX_POINTS = 60;
type SystemStatus =
  | "monitoring"
  | "anomaly_detected"
  | "llm_processing"
  | "flashing"
  | "patched";
type SensorKey = "temperature" | "pressure" | "current";
type AgentKey = "debugger" | "orchestrator" | "coder" | "verifier";
type AgentState = "idle" | "active" | "done";
type EdgeKey = "d-o" | "o-c" | "c-v";
type LinkState = "connecting" | "connected" | "disconnected";

interface Sensors { temperature: number; pressure: number; current: number; }
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
interface AnomalyMsg { type: "anomaly"; reason: string; }
interface StatusMsg { type: "status"; status: SystemStatus; message?: string; }
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
interface ErrorMsg { type: "error"; message: string; }
interface AckMsg { type: "ack"; }

type WsMessage =
  | TelemetryMsg | AnomalyMsg | StatusMsg | LLMResponseMsg
  | FlashCompleteMsg | ConnectedMsg | ErrorMsg | AckMsg;

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

// ── Sparkline charts ──────────────────────────────────────────────────────
function makeSpark(canvasId: string, color: string, yMin: number, yMax: number): ChartInstance {
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
        backgroundColor: `${color}22`,
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.35,
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
        y: { display: false, min: yMin, max: yMax, grid: { display: false } },
      },
    },
  });
}

const charts: Record<SensorKey, ChartInstance> = {
  temperature: makeSpark("tempChart", "#00ff9d", 18, 32),
  pressure: makeSpark("pressureChart", "#00d4ff", 990, 1040),
  current: makeSpark("currentChart", "#b67bff", 0.4, 1.4),
};

function pushPoint(sensor: SensorKey, value: number): void {
  const ds = charts[sensor].data.datasets[0];
  ds.data.push(value);
  if (ds.data.length > MAX_POINTS) ds.data.shift();
  charts[sensor].update("none");
}

// ── Element refs ──────────────────────────────────────────────────────────
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
  confFill: byId<HTMLElement>("confFill"),
  confValue: byId<HTMLElement>("confValue"),
  modeBadge: byId<HTMLElement>("modeBadge"),
  btnAttack: byId<HTMLButtonElement>("btnAttack"),
  btnClear: byId<HTMLButtonElement>("btnClear"),
  sidebarToggle: byId<HTMLButtonElement>("sidebarToggle"),
  layout: byId<HTMLElement>("layout"),

  detail: byId<HTMLElement>("detail"),
  detailBody: byId<HTMLElement>("detailBody"),
  detailName: byId<HTMLElement>("detailName"),
  detailTag: byId<HTMLElement>("detailTag"),
  detailDot: byId<HTMLElement>("detailDot"),
};

// ── Sidebar collapse ──────────────────────────────────────────────────────
els.sidebarToggle.addEventListener("click", () => {
  els.layout.classList.toggle("collapsed");
});

// ── Agents ────────────────────────────────────────────────────────────────
type AgentColorKey = "cyan" | "violet" | "accent" | "warn";

interface AgentInfo {
  state: AgentState;
  status: string;
  color: AgentColorKey;
  payload: AgentPayload | null;
}

interface AgentPayload {
  // Free-form rendering: either prose+meta, code, or a list of stats
  kind: "prose" | "code" | "stats" | "result";
  title: string;
  meta?: string;
  text?: string;
  code?: string;
  stats?: { k: string; v: string }[];
  ok?: boolean;
}

const agents: Record<AgentKey, AgentInfo> = {
  debugger:     { state: "idle", status: "MONITORING", color: "cyan",   payload: null },
  orchestrator: { state: "idle", status: "IDLE",       color: "violet", payload: null },
  coder:        { state: "idle", status: "IDLE",       color: "accent", payload: null },
  verifier:     { state: "idle", status: "IDLE",       color: "warn",   payload: null },
};

function agentEl(key: AgentKey): HTMLElement {
  return bySelector<HTMLElement>(`.agent[data-agent="${key}"]`);
}
function edgeEl(key: EdgeKey): HTMLElement {
  return bySelector<HTMLElement>(`.edge[data-edge="${key}"]`);
}

function setAgent(key: AgentKey, state: AgentState, status?: string): void {
  agents[key].state = state;
  if (status) agents[key].status = status;
  const el = agentEl(key);
  el.dataset.state = state;
  const statusEl = el.querySelector<HTMLElement>(".agent-status");
  if (statusEl) statusEl.textContent = agents[key].status;
  if (state === "active") selectAgent(key);
  else if (selectedAgent === key) renderDetail(key);
}

function setEdge(key: EdgeKey, mode: "idle" | "active" | "done"): void {
  const e = edgeEl(key);
  e.dataset.active = mode === "active" ? "true" : "false";
  e.dataset.done = mode === "done" ? "true" : "false";
}

function resetAll(): void {
  setAgent("debugger", "idle", "MONITORING");
  setAgent("orchestrator", "idle", "IDLE");
  setAgent("coder", "idle", "IDLE");
  setAgent("verifier", "idle", "IDLE");
  for (const k of ["d-o", "o-c", "c-v"] as EdgeKey[]) setEdge(k, "idle");
  agents.debugger.payload = null;
  agents.orchestrator.payload = null;
  agents.coder.payload = null;
  agents.verifier.payload = null;
  selectAgent(null);
}

// ── Detail panel ──────────────────────────────────────────────────────────
let selectedAgent: AgentKey | null = null;

const AGENT_NAMES: Record<AgentKey, string> = {
  debugger: "Debugger Agent",
  orchestrator: "Orchestrator Agent",
  coder: "Coding Agent",
  verifier: "Verifier Agent",
};

function selectAgent(key: AgentKey | null): void {
  selectedAgent = key;
  document.querySelectorAll<HTMLElement>(".agent").forEach((a) => {
    a.classList.toggle("selected", a.dataset.agent === key);
  });
  renderDetail(key);
}

function renderDetail(key: AgentKey | null): void {
  if (!key) {
    els.detailName.textContent = "Awaiting incident";
    els.detailTag.textContent = "STANDBY";
    els.detailTag.removeAttribute("data-c");
    els.detailDot.removeAttribute("data-c");
    els.detailBody.innerHTML = `
      <div class="detail-placeholder">
        The mesh is monitoring telemetry. When the Debugger flags an anomaly,
        the Orchestrator dispatches the Coding Agent to synthesise a virtual-sensor
        patch, and the Verifier compiles and flashes it.
      </div>`;
    return;
  }

  const info = agents[key];
  els.detailName.textContent = AGENT_NAMES[key];
  els.detailDot.dataset.c = info.color;
  els.detailTag.textContent = info.status;
  els.detailTag.dataset.c = info.color;

  if (!info.payload) {
    els.detailBody.innerHTML = `<div class="detail-placeholder">No output yet from ${AGENT_NAMES[key]}.</div>`;
    return;
  }

  const p = info.payload;
  if (p.kind === "code" && p.code) {
    els.detailBody.innerHTML = `
      <div class="detail-prose">
        ${p.meta ? `<div class="meta">${escapeHtml(p.meta)}</div>` : ""}
        ${p.text ? `<p>${escapeHtml(p.text)}</p>` : ""}
      </div>
      <pre class="detail-code"><code id="liveCode"></code></pre>
    `;
    const codeEl = byId<HTMLElement>("liveCode");
    typeCode(codeEl, p.code);
    return;
  }

  if (p.kind === "stats" && p.stats) {
    const meta = p.meta ? `<div class="meta">${escapeHtml(p.meta)}</div>` : "";
    const text = p.text ? `<p>${escapeHtml(p.text)}</p>` : "";
    const cells = p.stats.map((s) =>
      `<div class="stat"><span class="stat-k">${escapeHtml(s.k)}</span><span class="stat-v">${escapeHtml(s.v)}</span></div>`
    ).join("");
    els.detailBody.innerHTML = `
      <div class="detail-prose">
        ${meta}
        ${text}
        <div class="stats">${cells}</div>
      </div>`;
    return;
  }

  if (p.kind === "result") {
    const dotColor = p.ok ? "accent" : "danger";
    els.detailTag.dataset.c = dotColor;
    els.detailBody.innerHTML = `
      <div class="detail-prose">
        ${p.meta ? `<div class="meta">${escapeHtml(p.meta)}</div>` : ""}
        <p>${escapeHtml(p.text ?? "")}</p>
        ${p.code ? `<pre class="detail-code">${escapeHtml(p.code)}</pre>` : ""}
      </div>`;
    return;
  }

  // prose fallback
  els.detailBody.innerHTML = `
    <div class="detail-prose">
      ${p.meta ? `<div class="meta">${escapeHtml(p.meta)}</div>` : ""}
      ${p.text ? `<p>${escapeHtml(p.text)}</p>` : ""}
    </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] ?? c));
}

let typeAnimToken = 0;
function typeCode(target: HTMLElement, code: string): void {
  const myToken = ++typeAnimToken;
  target.textContent = "";
  let i = 0;
  const speed = Math.max(2, Math.floor(code.length / 400));
  function step(): void {
    if (myToken !== typeAnimToken) return;
    const next = Math.min(code.length, i + speed);
    target.textContent = code.slice(0, next);
    const parent = target.parentElement;
    if (parent) parent.scrollTop = parent.scrollHeight;
    i = next;
    if (i < code.length) requestAnimationFrame(step);
  }
  step();
}

// Click-to-inspect
document.querySelectorAll<HTMLElement>(".agent").forEach((el) => {
  el.addEventListener("click", () => {
    const key = el.dataset.agent as AgentKey | undefined;
    if (key) selectAgent(key);
  });
});

// ── System status header + reset ──────────────────────────────────────────
function setSystemStatus(status: SystemStatus): void {
  els.systemStatus.textContent = status.toUpperCase().replace(/_/g, " ");
  els.systemStatus.dataset.state = status;
}
function setLinkStatus(state: LinkState): void {
  els.linkStatus.textContent = state.toUpperCase();
  els.linkStatus.dataset.state = state;
}

// ── Telemetry handling ────────────────────────────────────────────────────
function handleTelemetry(msg: TelemetryMsg): void {
  const { sensors, anomaly, anomaly_confidence, stats } = msg;

  pushPoint("temperature", sensors.temperature);
  pushPoint("pressure", sensors.pressure);
  pushPoint("current", sensors.current);

  els.tempReading.innerHTML = `${sensors.temperature.toFixed(2)} <span>°C</span>`;
  els.pressureReading.innerHTML = `${sensors.pressure.toFixed(2)} <span>hPa</span>`;
  els.currentReading.innerHTML = `${sensors.current.toFixed(3)} <span>A</span>`;

  const tempCard = bySelector<HTMLElement>('.sensor-card[data-sensor="temperature"]');
  tempCard.dataset.flatlined = anomaly ? "true" : "false";
  els.tempTag.textContent = anomaly ? "FLATLINED" : "NOMINAL";
  els.tempTag.dataset.state = anomaly ? "anomaly" : "";

  // Keep the debugger payload up to date so clicking it shows live stats
  if (stats && agents.debugger.state !== "active") {
    agents.debugger.payload = {
      kind: "stats",
      title: "Telemetry",
      meta: "live sensor variances",
      text: anomaly ? "Variance collapse detected — escalating." : "All channels nominal.",
      stats: [
        { k: "σ²(T)", v: stats.temp_variance?.toFixed(4) ?? "—" },
        { k: "σ²(P)", v: stats.pressure_variance?.toFixed(2) ?? "—" },
        { k: "σ²(I)", v: stats.current_variance?.toFixed(4) ?? "—" },
      ],
    };
    if (selectedAgent === "debugger") renderDetail("debugger");
  }

  const conf = Math.round((anomaly_confidence || 0) * 100);
  els.confFill.style.width = `${conf}%`;
  els.confValue.textContent = `${conf}%`;
}

// ── Anomaly pipeline ──────────────────────────────────────────────────────
function handleAnomaly(msg: AnomalyMsg): void {
  setSystemStatus("anomaly_detected");
  setAgent("debugger", "active", "ANALYSING");
  agents.debugger.payload = {
    kind: "prose",
    title: "Debugger",
    meta: "anomaly_detected · " + new Date().toISOString().slice(11, 19),
    text: msg.reason,
  };
  if (selectedAgent === "debugger") renderDetail("debugger");
}

function handleStatus(msg: StatusMsg): void {
  setSystemStatus(msg.status);
  switch (msg.status) {
    case "monitoring":
      resetAll();
      break;
    case "anomaly_detected":
      setAgent("debugger", "active", "ANALYSING");
      break;
    case "llm_processing":
      setAgent("debugger", "done", "REPORTED");
      setEdge("d-o", "active");
      setAgent("orchestrator", "active", "REASONING");
      agents.orchestrator.payload = {
        kind: "prose",
        title: "Orchestrator",
        meta: "dispatching to air-gapped intelligence layer",
        text: msg.message ?? "Routing telemetry window to the inference layer and planning a remediation strategy…",
      };
      if (selectedAgent === "orchestrator") renderDetail("orchestrator");
      break;
    case "flashing":
      setAgent("coder", "done", "PATCH READY");
      setEdge("c-v", "active");
      setAgent("verifier", "active", "FLASHING");
      agents.verifier.payload = {
        kind: "prose",
        title: "Verifier",
        meta: "compiling firmware patch",
        text: msg.message ?? "Compiling and flashing the synthesised virtual-sensor patch onto the target MCU…",
      };
      if (selectedAgent === "verifier") renderDetail("verifier");
      break;
    case "patched":
      setAgent("verifier", "done", "VERIFIED");
      break;
  }
}

function handleLLMResponse(msg: LLMResponseMsg): void {
  setAgent("orchestrator", "done", "PLAN READY");
  setEdge("o-c", "active");
  setAgent("coder", "active", "SYNTHESISING");
  agents.coder.payload = {
    kind: "code",
    title: "Coding Agent",
    meta: `${msg.used_fallback ? "fallback" : "ai"} · ${msg.code.length} bytes · ${new Date(msg.timestamp * 1000).toISOString().slice(11, 19)}`,
    text: msg.analysis,
    code: msg.code,
  };
  selectAgent("coder");
}

function handleFlashComplete(msg: FlashCompleteMsg): void {
  if (msg.success) {
    setAgent("verifier", "done", "COMPILED ✓");
    setEdge("c-v", "done");
    setEdge("o-c", "done");
    setEdge("d-o", "done");
    agents.verifier.payload = {
      kind: "result",
      title: "Verifier",
      meta: "flash_complete · success",
      text: msg.message,
      code: msg.output.split("\n").slice(0, 12).join("\n"),
      ok: true,
    };
    if (selectedAgent === "verifier") renderDetail("verifier");
  } else {
    setAgent("verifier", "active", "FLASH FAILED");
    agents.verifier.payload = {
      kind: "result",
      title: "Verifier",
      meta: "flash_complete · failure",
      text: msg.message,
      code: msg.output,
      ok: false,
    };
    if (selectedAgent === "verifier") renderDetail("verifier");
  }
}

function handleConnected(msg: ConnectedMsg): void {
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
    try { msg = JSON.parse(ev.data) as WsMessage; }
    catch { return; }

    switch (msg.type) {
      case "telemetry": handleTelemetry(msg); break;
      case "anomaly":
        handleAnomaly(msg);
        els.anomalyCount.textContent = String(parseInt(els.anomalyCount.textContent ?? "0", 10) + 1);
        break;
      case "status": handleStatus(msg); break;
      case "llm_response": handleLLMResponse(msg); break;
      case "flash_complete": handleFlashComplete(msg); break;
      case "connected": handleConnected(msg); break;
      case "error": case "ack": break;
    }
  };

  ws.onclose = () => {
    setLinkStatus("disconnected");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  };

  ws.onerror = () => { /* onclose handles reconnect */ };
}

// ── Controls ──────────────────────────────────────────────────────────────
async function postJSON(path: string): Promise<void> {
  try { await fetch(`${API_BASE}${path}`, { method: "POST" }); }
  catch { /* surfaced through link status */ }
}

els.btnAttack.addEventListener("click", () => { void postJSON("/api/simulate/attack"); });
els.btnClear.addEventListener("click", () => { void postJSON("/api/simulate/clear"); });

// ── Clock ─────────────────────────────────────────────────────────────────
setInterval(() => {
  els.clock.textContent = new Date().toISOString().slice(11, 19);
}, 1000);

// ── Boot ──────────────────────────────────────────────────────────────────
renderDetail(null);
connect();
