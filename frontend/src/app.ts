// AEGIS EDGE — Agent Mesh Frontend
//
// Connects to the FastAPI backend over WebSocket and translates pipeline
// events into agent-graph state transitions. Each backend status maps to one
// of four conceptual agents shown as nodes in the canvas.

import { initScene } from "./scene3d.js";

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
type AgentState = "idle" | "active" | "done" | "fail";
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

  detailBody: byId<HTMLElement>("detailBody"),
  detailName: byId<HTMLElement>("detailName"),
  detailTag: byId<HTMLElement>("detailTag"),
  detailDot: byId<HTMLElement>("detailDot"),

  incidentPanel: byId<HTMLElement>("incidentPanel"),
  incidentClose: byId<HTMLButtonElement>("incidentClose"),
  agentGraph: document.getElementById("agentGraph") as unknown as SVGSVGElement,
  graphViewport: document.getElementById("graphViewport") as unknown as SVGGElement,
  graphRecenter: byId<HTMLButtonElement>("graphRecenter"),
  graphEdges: document.getElementById("graphEdges") as unknown as SVGGElement,
  graphNodes: document.getElementById("graphNodes") as unknown as SVGGElement,
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
  debugger: { state: "idle", status: "MONITORING", color: "cyan", payload: null },
  orchestrator: { state: "idle", status: "IDLE", color: "violet", payload: null },
  coder: { state: "idle", status: "IDLE", color: "accent", payload: null },
  verifier: { state: "idle", status: "IDLE", color: "warn", payload: null },
};

// ── Obsidian-style spawn graph ────────────────────────────────────────────
const SVG_NS = "http://www.w3.org/2000/svg";

interface NodeLayout {
  key: AgentKey;
  x: number; y: number;
  parent: AgentKey | null;
  label: string;
  role: string;
}

const NODE_LAYOUT: Record<AgentKey, NodeLayout> = {
  debugger:     { key: "debugger",     x: 165, y: 70,  parent: null,           label: "Debugger",     role: "reads sensor logs" },
  orchestrator: { key: "orchestrator", x: 210, y: 175, parent: "debugger",     label: "Orchestrator", role: "plans response"   },
  coder:        { key: "coder",        x: 130, y: 285, parent: "orchestrator", label: "Coding Agent", role: "synthesises patch" },
  verifier:     { key: "verifier",     x: 195, y: 395, parent: "coder",        label: "Verifier",     role: "compiles & flashes" },
};

const NODE_RADIUS = 22;
const spawnedAgents = new Set<AgentKey>();

// ── Pan / zoom for the agent graph (Obsidian-style navigation) ────────────
let panX = 0;
let panY = 0;
let zoom = 1;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3.5;
const DRAG_THRESHOLD = 4; // px in viewBox space before a click becomes a drag
let isPanning = false;
let suppressNextClick = false;
let dragStart: { x: number; y: number } | null = null;
let panStart: { x: number; y: number } | null = null;
let dragMoved = false;

function applyViewport(): void {
  els.graphViewport.setAttribute(
    "transform",
    `translate(${panX} ${panY}) scale(${zoom})`,
  );
}

function svgPoint(clientX: number, clientY: number): { x: number; y: number } {
  const ctm = els.agentGraph.getScreenCTM();
  if (!ctm) return { x: clientX, y: clientY };
  const inv = ctm.inverse();
  return {
    x: clientX * inv.a + clientY * inv.c + inv.e,
    y: clientX * inv.b + clientY * inv.d + inv.f,
  };
}

function resetViewport(): void {
  panX = 0;
  panY = 0;
  zoom = 1;
  applyViewport();
}

els.agentGraph.addEventListener("mousedown", (e: MouseEvent) => {
  if (e.button !== 0) return;
  isPanning = true;
  dragMoved = false;
  dragStart = svgPoint(e.clientX, e.clientY);
  panStart = { x: panX, y: panY };
  els.agentGraph.classList.add("is-panning");
});

window.addEventListener("mousemove", (e: MouseEvent) => {
  if (!isPanning || !dragStart || !panStart) return;
  const cur = svgPoint(e.clientX, e.clientY);
  const dx = cur.x - dragStart.x;
  const dy = cur.y - dragStart.y;
  if (!dragMoved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
    dragMoved = true;
  }
  panX = panStart.x + dx;
  panY = panStart.y + dy;
  applyViewport();
});

function endPan(): void {
  if (!isPanning) return;
  isPanning = false;
  els.agentGraph.classList.remove("is-panning");
  if (dragMoved) {
    suppressNextClick = true;
    // clear after the click event has had a chance to fire
    setTimeout(() => { suppressNextClick = false; }, 0);
  }
  dragStart = null;
  panStart = null;
}
window.addEventListener("mouseup", endPan);
window.addEventListener("mouseleave", endPan);

els.agentGraph.addEventListener(
  "wheel",
  (e: WheelEvent) => {
    e.preventDefault();
    const cur = svgPoint(e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
    if (newZoom === zoom) return;
    // anchor the zoom on the cursor: keep the local point under the cursor fixed
    const localX = (cur.x - panX) / zoom;
    const localY = (cur.y - panY) / zoom;
    panX = cur.x - localX * newZoom;
    panY = cur.y - localY * newZoom;
    zoom = newZoom;
    applyViewport();
  },
  { passive: false },
);

els.graphRecenter.addEventListener("click", (e) => {
  e.stopPropagation();
  resetViewport();
});

applyViewport();

function spawnAgent(key: AgentKey): void {
  if (spawnedAgents.has(key)) return;
  spawnedAgents.add(key);

  const layout = NODE_LAYOUT[key];

  // 1. Draw the edge from parent first (under the nodes)
  if (layout.parent) {
    const p = NODE_LAYOUT[layout.parent];
    const path = document.createElementNS(SVG_NS, "path");
    path.classList.add("graph-edge");
    path.setAttribute("data-edge-to", key);
    // gentle bezier — control point shifts horizontally for organic feel
    const dx = (layout.x - p.x);
    const cx1 = p.x + dx * 0.25;
    const cy1 = p.y + (layout.y - p.y) * 0.5;
    const cx2 = p.x + dx * 0.75;
    const cy2 = p.y + (layout.y - p.y) * 0.5;
    // Trim endpoints so the path stops at the node circles, not their centers
    const angle = Math.atan2(layout.y - p.y, layout.x - p.x);
    const sx = p.x + Math.cos(angle) * NODE_RADIUS;
    const sy = p.y + Math.sin(angle) * NODE_RADIUS;
    const ex = layout.x - Math.cos(angle) * NODE_RADIUS;
    const ey = layout.y - Math.sin(angle) * NODE_RADIUS;
    path.setAttribute("d", `M ${sx} ${sy} C ${cx1} ${cy1} ${cx2} ${cy2} ${ex} ${ey}`);
    els.graphEdges.appendChild(path);
    // Animate stroke draw-in
    const length = (path as SVGPathElement).getTotalLength();
    path.setAttribute("stroke-dasharray", String(length));
    path.setAttribute("stroke-dashoffset", String(length));
    requestAnimationFrame(() => {
      path.setAttribute("stroke-dashoffset", "0");
    });
  }

  // 2. Build the node group. Outer <g> holds the SVG translate (positional),
  // inner <g class="graph-node-anim"> handles the CSS scale animation —
  // separating the two avoids CSS transforms clobbering the SVG translate.
  const g = document.createElementNS(SVG_NS, "g");
  g.classList.add("graph-node");
  g.setAttribute("data-agent", key);
  g.setAttribute("data-state", "idle");
  g.setAttribute("data-spawned", "false");
  g.setAttribute("transform", `translate(${layout.x} ${layout.y})`);

  const anim = document.createElementNS(SVG_NS, "g");
  anim.classList.add("graph-node-anim");
  g.appendChild(anim);

  const halo = document.createElementNS(SVG_NS, "circle");
  halo.classList.add("node-halo");
  halo.setAttribute("r", String(NODE_RADIUS + 2));
  anim.appendChild(halo);

  const bg = document.createElementNS(SVG_NS, "circle");
  bg.classList.add("node-bg");
  bg.setAttribute("r", String(NODE_RADIUS));
  anim.appendChild(bg);

  const label = document.createElementNS(SVG_NS, "text");
  label.classList.add("node-label");
  label.setAttribute("y", String(NODE_RADIUS + 16));
  label.textContent = layout.label;
  anim.appendChild(label);

  const role = document.createElementNS(SVG_NS, "text");
  role.classList.add("node-role");
  role.setAttribute("y", String(NODE_RADIUS + 30));
  role.textContent = layout.role;
  anim.appendChild(role);

  g.addEventListener("click", (ev) => {
    if (suppressNextClick) {
      ev.stopPropagation();
      return;
    }
    selectAgent(key);
  });

  els.graphNodes.appendChild(g);
  // trigger spawn animation on next frame
  requestAnimationFrame(() => g.setAttribute("data-spawned", "true"));
}

function nodeEl(key: AgentKey): SVGGElement | null {
  return els.graphNodes.querySelector<SVGGElement>(`[data-agent="${key}"]`);
}

function setAgent(key: AgentKey, state: AgentState, status?: string): void {
  agents[key].state = state;
  if (status) agents[key].status = status;
  const el = nodeEl(key);
  if (el) el.setAttribute("data-state", state);
  if (state === "active") selectAgent(key);
  else if (selectedAgent === key) renderDetail(key);
}

function clearGraph(): void {
  spawnedAgents.clear();
  els.graphEdges.innerHTML = "";
  els.graphNodes.innerHTML = "";
  resetViewport();
}

function openIncidentPanel(): void {
  els.incidentPanel.dataset.open = "true";
}
function closeIncidentPanel(): void {
  els.incidentPanel.dataset.open = "false";
}
els.incidentClose.addEventListener("click", () => {
  closeIncidentPanel();
  resetAll();
});

function resetAll(): void {
  agents.debugger = { state: "idle", status: "MONITORING", color: "cyan", payload: null };
  agents.orchestrator = { state: "idle", status: "IDLE", color: "violet", payload: null };
  agents.coder = { state: "idle", status: "IDLE", color: "accent", payload: null };
  agents.verifier = { state: "idle", status: "IDLE", color: "warn", payload: null };
  clearGraph();
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
  els.graphNodes.querySelectorAll<SVGGElement>(".graph-node").forEach((n) => {
    n.classList.toggle("selected", n.getAttribute("data-agent") === key);
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

// (Click-to-inspect is wired per-node when each agent is spawned.)

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

  // --- NEW: Sync the 3D twin with the anomaly state! ---
  if (sceneApi) {
    sceneApi.setSensorFailure("dht11", anomaly);
  }
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
  // Each anomaly event begins a fresh incident — clear any stale agents that
  // were left over because the user dismissed the previous panel manually
  // (CLEAR ATTACK / X) before the backend's pipeline reached `monitoring`.
  clearGraph();
  openIncidentPanel();
  spawnAgent("debugger");
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
      closeIncidentPanel();
      break;
    case "anomaly_detected":
      openIncidentPanel();
      spawnAgent("debugger");
      setAgent("debugger", "active", "ANALYSING");
      break;
    case "llm_processing":
      setAgent("debugger", "done", "REPORTED");
      // small stagger so the edge draws after the parent has settled
      setTimeout(() => {
        spawnAgent("orchestrator");
        setAgent("orchestrator", "active", "REASONING");
        agents.orchestrator.payload = {
          kind: "prose",
          title: "Orchestrator",
          meta: "dispatching to air-gapped intelligence layer",
          text: msg.message ?? "Routing telemetry window to the inference layer and planning a remediation strategy…",
        };
        if (selectedAgent === "orchestrator") renderDetail("orchestrator");
      }, 250);
      break;
    case "flashing":
      setAgent("coder", "done", "PATCH READY");
      setTimeout(() => {
        spawnAgent("verifier");
        setAgent("verifier", "active", "FLASHING");
        agents.verifier.payload = {
          kind: "prose",
          title: "Verifier",
          meta: "compiling firmware patch",
          text: msg.message ?? "Compiling and flashing the synthesised virtual-sensor patch onto the target MCU…",
        };
        if (selectedAgent === "verifier") renderDetail("verifier");
      }, 250);
      break;
    case "patched":
      setAgent("verifier", "done", "VERIFIED");
      break;
  }
}

function handleLLMResponse(msg: LLMResponseMsg): void {
  setAgent("orchestrator", "done", "PLAN READY");
  setTimeout(() => {
    spawnAgent("coder");
    setAgent("coder", "active", "SYNTHESISING");
    agents.coder.payload = {
      kind: "code",
      title: "Coding Agent",
      meta: `${msg.used_fallback ? "fallback" : "ai"} · ${msg.code.length} bytes · ${new Date(msg.timestamp * 1000).toISOString().slice(11, 19)}`,
      text: msg.analysis,
      code: msg.code,
    };
    selectAgent("coder");
  }, 250);
}

function handleFlashComplete(msg: FlashCompleteMsg): void {
  if (msg.success) {
    setAgent("verifier", "done", "COMPILED ✓");
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
    setAgent("verifier", "fail", "FLASH FAILED");
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
els.btnClear.addEventListener("click", () => {
  // Local UI reset — the /clear endpoint doesn't broadcast a status change,
  // so without this the next attack would short-circuit on stale spawnedAgents.
  closeIncidentPanel();
  resetAll();
  setSystemStatus("monitoring");
  void postJSON("/api/simulate/clear");
});

// ── Clock ─────────────────────────────────────────────────────────────────
setInterval(() => {
  els.clock.textContent = new Date().toISOString().slice(11, 19);
}, 1000);

// ── Boot ──────────────────────────────────────────────────────────────────
renderDetail(null);
connect();

// ── Digital twin (Three.js) ───────────────────────────────────────────────
const twinCanvas = document.getElementById("twinCanvas") as HTMLCanvasElement | null;
const twinTag = document.getElementById("twinTag");
const twinPanel = document.getElementById("twinPanel");
const twinCollapse = document.getElementById("twinCollapse");

// --- NEW: Variable to hold our scene API ---
let sceneApi: any = null; // using 'any' to avoid circular type imports, or import { SceneApi } from "./scene3d.js"

if (twinPanel && twinCollapse) {
  twinCollapse.addEventListener("click", () => {
    twinPanel.classList.toggle("collapsed");
  });
}

if (twinCanvas && twinTag) {
  initScene(twinCanvas, (msg) => { twinTag.textContent = msg; })
    .then((api) => { sceneApi = api; }) // --- CHANGED: Store the API ---
    .catch((err: Error) => { twinTag.textContent = `ERR: ${err.message}`; });
}
