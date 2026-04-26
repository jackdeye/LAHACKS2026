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

interface Sensors {
  temperature: number;
  pressure: number;
  current: number;
  humidity?: number;
  light?: number;
  fan?: number;
  alarm?: number;
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

interface HardenStartedMsg { type: "harden_started"; timestamp: number; }
interface RedTeamPlanMsg {
  type: "red_team_plan";
  prose: string;
  code: string;
  lang: string;
  target: string;
  kind: string;
  magnitude: number;
  rationale?: string;
  used_fallback: boolean;
  timestamp: number;
}
interface HardenAttackLaunchedMsg {
  type: "harden_attack_launched";
  target: string;
  kind?: string;
  magnitude?: number;
  timestamp: number;
}
interface BlueTeamPatchMsg {
  type: "blue_team_patch";
  prose: string;
  code: string;
  lang: string;
  target: string;
  basis?: string[];
  intercept?: number;
  coefficients?: number[];
  r2?: number;
  used_fallback: boolean;
  timestamp: number;
}
interface HardenPatchAppliedMsg {
  type: "harden_patch_applied";
  target: string;
  intercept?: number;
  coefficients?: number[];
  basis?: string[];
  timestamp: number;
}
interface HardenExitedMsg { type: "harden_exited"; timestamp: number; }

type WsMessage =
  | TelemetryMsg | AnomalyMsg | StatusMsg | LLMResponseMsg
  | FlashCompleteMsg | ConnectedMsg | ErrorMsg | AckMsg
  | HardenStartedMsg | RedTeamPlanMsg | HardenAttackLaunchedMsg
  | BlueTeamPatchMsg | HardenPatchAppliedMsg | HardenExitedMsg;

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
  current: makeSpark("currentChart", "#b67bff", 0, 1024),
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
  humidityReading: byId<HTMLElement>("humidityReading"),
  fanReading: byId<HTMLElement>("fanReading"),
  alarmReading: byId<HTMLElement>("alarmReading"),
  alarmCard: bySelector<HTMLElement>('.sensor-mini[data-sensor="alarm"]'),
  tempTag: byId<HTMLElement>("tempTag"),
  pressureTag: byId<HTMLElement>("pressureTag"),
  currentTag: byId<HTMLElement>("currentTag"),
  modeBadge: byId<HTMLElement>("modeBadge"),
  btnAttack: byId<HTMLButtonElement>("btnAttack"),
  btnClear: byId<HTMLButtonElement>("btnClear"),
  btnHarden: byId<HTMLButtonElement>("btnHarden"),
  sidebarToggle: byId<HTMLButtonElement>("sidebarToggle"),
  layout: byId<HTMLElement>("layout"),
  canvas: byId<HTMLElement>("canvas"),

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

  // Harden mode (red/blue team)
  redPanel: byId<HTMLElement>("redPanel"),
  bluePanel: byId<HTMLElement>("bluePanel"),
  redTag: byId<HTMLElement>("redTag"),
  blueTag: byId<HTMLElement>("blueTag"),
  redBody: byId<HTMLElement>("redBody"),
  blueBody: byId<HTMLElement>("blueBody"),
  btnRedAction: byId<HTMLButtonElement>("btnRedAction"),
  btnBlueAction: byId<HTMLButtonElement>("btnBlueAction"),
  btnExitHarden: byId<HTMLButtonElement>("btnExitHarden"),
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
  const { sensors, anomaly, stats } = msg;

  pushPoint("temperature", sensors.temperature);
  pushPoint("pressure", sensors.pressure);
  pushPoint("current", sensors.current);

  els.tempReading.innerHTML = `${sensors.temperature.toFixed(2)} <span>°C</span>`;
  els.pressureReading.innerHTML = `${sensors.pressure.toFixed(2)} <span>hPa</span>`;
  els.currentReading.innerHTML = `${Math.round(sensors.current)} <span>lux</span>`;

  if (sensors.humidity !== undefined) {
    els.humidityReading.innerHTML = `${sensors.humidity.toFixed(1)} <em>%</em>`;
  }
  if (sensors.fan !== undefined) {
    els.fanReading.innerHTML = `${Math.round(sensors.fan)} <em>pwm</em>`;
  }
  if (sensors.alarm !== undefined) {
    const triggered = sensors.alarm !== 0;
    els.alarmReading.textContent = triggered ? "ACTIVE" : "CLEAR";
    els.alarmCard.dataset.state = triggered ? "active" : "";
  }

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
      case "harden_started": handleHardenStarted(); break;
      case "red_team_plan": handleRedTeamPlan(msg); break;
      case "harden_attack_launched": handleHardenAttackLaunched(msg); break;
      case "blue_team_patch": handleBlueTeamPatch(msg); break;
      case "harden_patch_applied": handleHardenPatchApplied(msg); break;
      case "harden_exited": handleHardenExited(); break;
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

// ── Harden mode (red team / blue team) ────────────────────────────────────
type HardenState = "idle" | "armed" | "planning" | "planned" | "attacking" | "patching" | "patched";
type HardenStep = "recon" | "attack" | "analysis" | "patch";
type StepState = "idle" | "active" | "done";
let hardenState: HardenState = "idle";

// Pipeline cards are pre-rendered in dashboard.html but hidden by default.
// Each phase only enters the canvas when its action button is first pressed,
// and the layout reflows so the new card joins the zigzag without overlapping
// the previous ones — the floating panel itself is also hidden until at least
// one card is visible.
const HARDEN_STEP_ORDER: HardenStep[] = ["recon", "attack", "analysis", "patch"];
const HARDEN_STEP_TEAM: Record<HardenStep, "red" | "blue"> = {
  recon: "red", attack: "red", analysis: "blue", patch: "blue",
};
const visibleSteps: HardenStep[] = [];
const SVG_NS_HARDEN = "http://www.w3.org/2000/svg";

function stepNode(step: HardenStep): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#hardenStepsNodes .step-card[data-step="${step}"]`);
}

// (xPercent, yPercent) for a card at index `i` of `n` visible cards. Cards are
// distributed evenly between 14% and 86% horizontally with a single anchor at
// 50% when only one is visible. Vertical position alternates 35% / 70% so the
// pipeline reads as a zigzag (1st high, 2nd low, 3rd high, …).
function stepPosition(i: number, n: number): { x: number; y: number } {
  const x = n <= 1 ? 50 : 14 + (i / (n - 1)) * 72;
  const y = i % 2 === 0 ? 35 : 70;
  return { x, y };
}

function relayoutSteps(): void {
  const n = visibleSteps.length;
  els.canvas.setAttribute("data-pipeline-active", n > 0 ? "true" : "false");
  for (const step of HARDEN_STEP_ORDER) {
    const node = stepNode(step);
    if (!node) continue;
    const i = visibleSteps.indexOf(step);
    if (i === -1) {
      node.removeAttribute("data-visible");
      continue;
    }
    const { x, y } = stepPosition(i, n);
    node.style.left = `${x}%`;
    node.style.top = `${y}%`;
    node.setAttribute("data-visible", "true");
  }
  // Rebuild edges to connect each adjacent pair of *visible* cards in order.
  const edgesHost = document.getElementById("hardenStepsEdges");
  if (!edgesHost) return;
  while (edgesHost.firstChild) edgesHost.removeChild(edgesHost.firstChild);
  for (let i = 0; i < n - 1; i++) {
    const a = stepPosition(i, n);
    const b = stepPosition(i + 1, n);
    const line = document.createElementNS(SVG_NS_HARDEN, "line");
    line.classList.add("step-edge");
    line.setAttribute("data-from", visibleSteps[i]);
    line.setAttribute("data-to", visibleSteps[i + 1]);
    line.setAttribute("x1", String(a.x));
    line.setAttribute("y1", String(a.y));
    line.setAttribute("x2", String(b.x));
    line.setAttribute("y2", String(b.y));
    edgesHost.appendChild(line);
  }
  refreshStepEdges();
}

function showStep(step: HardenStep): void {
  if (visibleSteps.includes(step)) return;
  visibleSteps.push(step);
  relayoutSteps();
}

function setHardenStep(step: HardenStep, state: StepState): void {
  if (state === "active" || state === "done") {
    showStep(step);
  }
  const n = stepNode(step);
  if (n) n.setAttribute("data-state", state);
  refreshStepEdges();
}

function refreshStepEdges(): void {
  document.querySelectorAll<SVGLineElement>("#hardenStepsEdges .step-edge").forEach((edge) => {
    const from = edge.dataset.from as HardenStep;
    const to = edge.dataset.to as HardenStep;
    const fromState = stepNode(from)?.getAttribute("data-state") ?? "idle";
    const toState = stepNode(to)?.getAttribute("data-state") ?? "idle";
    edge.removeAttribute("data-active");
    edge.removeAttribute("data-upstream-done");
    if (fromState === "done" && toState === "active") {
      edge.setAttribute("data-active", "true");
    } else if (fromState === "done") {
      edge.setAttribute("data-upstream-done", HARDEN_STEP_TEAM[from]);
    }
  });
}

function resetHardenSteps(): void {
  visibleSteps.length = 0;
  for (const step of HARDEN_STEP_ORDER) {
    const n = stepNode(step);
    if (!n) continue;
    n.setAttribute("data-state", "idle");
    n.removeAttribute("data-visible");
  }
  els.canvas.setAttribute("data-pipeline-active", "false");
  const edgesHost = document.getElementById("hardenStepsEdges");
  if (edgesHost) while (edgesHost.firstChild) edgesHost.removeChild(edgesHost.firstChild);
}

function sendWs(action: string, extra: Record<string, unknown> = {}): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ action, ...extra }));
}

// Tiny markdown renderer covering the subset our prompts produce: H1–H3,
// bullets, numbered lists, **bold**, *italic*, `code`, and paragraphs.
// (`escapeHtml` is defined earlier in this file and reused here.)
function renderInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_\n]+)_(\W|$)/g, "$1<em>$2</em>$3");
}
function renderMd(src: string): string {
  // Walk the raw source line-by-line; fenced code blocks (```lang ... ```) are
  // collected verbatim and emitted as <pre><code class="language-lang">…</code></pre>.
  const lines = src.split("\n");
  const out: string[] = [];
  let listKind: "ul" | "ol" | null = null;
  let para: string[] = [];
  let inFence = false;
  let fenceLang = "";
  let fenceBuf: string[] = [];
  const flushPara = () => {
    if (para.length) { out.push(`<p>${renderInline(escapeHtml(para.join(" ")))}</p>`); para = []; }
  };
  const closeList = () => {
    if (listKind) { out.push(`</${listKind}>`); listKind = null; }
  };
  const emitFence = (closed: boolean) => {
    const lang = (fenceLang || "plaintext").replace(/[^a-z0-9_+-]/gi, "");
    const body = escapeHtml(fenceBuf.join("\n"));
    const cursorSuffix = closed ? "" : '<span class="md-cursor md-cursor-inline">▌</span>';
    out.push(
      `<pre class="md-code language-${lang}"><code class="language-${lang}">${body}${cursorSuffix}</code></pre>`,
    );
  };
  for (const raw of lines) {
    const fenceOpen = raw.match(/^\s*```\s*([a-zA-Z0-9_+-]*)\s*$/);
    if (inFence) {
      if (fenceOpen) {
        // closing fence
        emitFence(true);
        inFence = false;
        fenceLang = "";
        fenceBuf = [];
      } else {
        fenceBuf.push(raw);
      }
      continue;
    }
    if (fenceOpen) {
      flushPara(); closeList();
      inFence = true;
      fenceLang = fenceOpen[1];
      fenceBuf = [];
      continue;
    }
    const line = raw.trim();
    if (!line) { flushPara(); closeList(); continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flushPara(); closeList();
      const level = m[1].length;
      out.push(`<h${level}>${renderInline(escapeHtml(m[2]))}</h${level}>`);
      continue;
    }
    if ((m = line.match(/^[-*]\s+(.*)$/))) {
      flushPara();
      if (listKind !== "ul") { closeList(); out.push("<ul>"); listKind = "ul"; }
      out.push(`<li>${renderInline(escapeHtml(m[1]))}</li>`);
      continue;
    }
    if ((m = line.match(/^\d+\.\s+(.*)$/))) {
      flushPara();
      if (listKind !== "ol") { closeList(); out.push("<ol>"); listKind = "ol"; }
      out.push(`<li>${renderInline(escapeHtml(m[1]))}</li>`);
      continue;
    }
    closeList();
    para.push(line);
  }
  if (inFence) emitFence(false);  // unterminated fence while typing
  flushPara();
  closeList();
  return out.join("");
}

// Streaming typewriter — types `text` into `target` as if an LLM were emitting it,
// re-rendering markdown each tick so headings/bold/lists appear progressively.
// On completion, calls Prism (loaded via CDN) to syntax-highlight any fenced
// code blocks that were emitted during typing.
declare const Prism: { highlightAllUnder?: (root: HTMLElement) => void } | undefined;
interface Typer { cancel(): void; }
function typewriter(target: HTMLElement, text: string, onDone?: () => void): Typer {
  let i = 0;
  let cancelled = false;
  const finalize = () => {
    target.innerHTML = renderMd(text);
    if (typeof Prism !== "undefined" && Prism?.highlightAllUnder) {
      try { Prism.highlightAllUnder(target); } catch { /* no-op */ }
    }
    onDone?.();
  };
  const id = window.setInterval(() => {
    if (cancelled) { clearInterval(id); return; }
    const pace = 3 + Math.floor(Math.random() * 4);
    i = Math.min(text.length, i + pace);
    if (i >= text.length) {
      clearInterval(id);
      finalize();
      return;
    }
    // While typing, render markdown but skip Prism (cheap; ~1KB strings).
    // Code blocks display as un-highlighted monospace until the closing fence
    // arrives and finalize() runs Prism.
    target.innerHTML = renderMd(text.slice(0, i)) + '<span class="md-cursor">▌</span>';
  }, 22);
  window.setTimeout(() => {
    if (!cancelled && i < text.length) { cancelled = true; clearInterval(id); finalize(); }
  }, 50_000);
  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      clearInterval(id);
      finalize();
    },
  };
}

let redTyper: Typer | null = null;
let blueTyper: Typer | null = null;

function setRedState(label: string, body?: string): void {
  els.redTag.textContent = label;
  els.redPanel.setAttribute("data-state", hardenState);
  if (body !== undefined) {
    redTyper?.cancel();
    els.redBody.classList.add("md");
    els.redBody.innerHTML = "";
    redTyper = typewriter(els.redBody, body);
  }
}
function setBlueState(label: string, body?: string): void {
  els.blueTag.textContent = label;
  els.bluePanel.setAttribute("data-state", hardenState);
  if (body !== undefined) {
    blueTyper?.cancel();
    els.blueBody.classList.add("md");
    els.blueBody.innerHTML = "";
    blueTyper = typewriter(els.blueBody, body);
  }
}

function enterHarden(): void {
  if (hardenState !== "idle") return;
  hardenState = "armed";
  els.layout.classList.add("harden");
  els.canvas.setAttribute("data-harden", "true");
  els.redPanel.setAttribute("data-open", "true");
  els.bluePanel.setAttribute("data-open", "false");
  els.btnHarden.disabled = true;
  setRedState("READY");
  els.btnRedAction.textContent = "Generate attack plan";
  els.btnRedAction.disabled = false;
  els.btnBlueAction.textContent = "Generate countermeasure";
  els.btnBlueAction.disabled = true;
  els.btnBlueAction.removeAttribute("data-state");
  setBlueState("STANDBY");
  resetHardenSteps();
  closeIncidentPanel();
  sendWs("start_harden");
}

function exitHardenLocal(): void {
  hardenState = "idle";
  els.layout.classList.remove("harden");
  els.canvas.removeAttribute("data-harden");
  els.redPanel.setAttribute("data-open", "false");
  els.bluePanel.setAttribute("data-open", "false");
  els.btnHarden.disabled = false;
  if (sceneApi && activeAttackPart) sceneApi.setSensorFailure(activeAttackPart, false);
  activeAttackPart = null;
  resetHardenSteps();
  setSystemStatus("monitoring");
}

function handleHardenStarted(): void {
  // Server confirmation; UI already entered harden in enterHarden().
}

function composeMd(prose: string, code: string, lang: string): string {
  const fence = code ? `\n\n\`\`\`${lang || "plaintext"}\n${code.trim()}\n\`\`\`\n` : "";
  return `${prose.trim()}${fence}`;
}

function handleRedTeamPlan(msg: RedTeamPlanMsg): void {
  hardenState = "planned";
  setHardenStep("recon", "done");
  const header =
    `### Selected attack\n` +
    `- **Target:** ${msg.target}\n` +
    `- **Kind:** ${msg.kind}\n` +
    `- **Magnitude:** ${msg.magnitude.toFixed(2)}\n` +
    (msg.rationale ? `- **Rationale:** ${msg.rationale}\n` : "");
  const body = composeMd(`${header}\n${msg.prose}`, msg.code, msg.lang || "python");
  setRedState(msg.used_fallback ? "PLAN (FALLBACK)" : "PLAN READY", body);
  els.btnRedAction.textContent = "Launch attack";
  els.btnRedAction.disabled = false;
}

// Maps server-side sensor names ("temperature" / "pressure" / "current") to
// the 3D scene part keys used by SceneApi.setSensorFailure(...).
const SENSOR_TO_PART: Record<string, string> = {
  temperature: "dht11",
  pressure: "pot",
  current: "current",
};
let activeAttackPart: string | null = null;

function handleHardenAttackLaunched(msg: HardenAttackLaunchedMsg): void {
  hardenState = "attacking";
  setHardenStep("attack", "done");
  els.redPanel.setAttribute("data-state", "attacking");
  setRedState(`ATTACK LIVE · ${(msg.kind || "flatline").toUpperCase()}`);
  els.btnRedAction.textContent = "Attack engaged";
  els.btnRedAction.disabled = true;
  els.bluePanel.setAttribute("data-open", "true");
  const sensorName = msg.target || "temperature";
  setBlueState(
    "READY",
    `Telemetry confirms the **${msg.kind || "flatline"}** signature on **${sensorName}**: ` +
    `variance pattern shifted while sibling channels remain active. ` +
    `Engage the local model to fit a virtual sensor and draft the patch.`,
  );
  els.btnBlueAction.disabled = false;
  // Highlight the actual targeted sensor on the 3D twin.
  activeAttackPart = SENSOR_TO_PART[sensorName] || "dht11";
  if (sceneApi) sceneApi.setSensorFailure(activeAttackPart, true);
  setSystemStatus("anomaly_detected");
}

function handleBlueTeamPatch(msg: BlueTeamPatchMsg): void {
  hardenState = "patching";
  setHardenStep("analysis", "done");
  const fitLine =
    msg.basis && msg.coefficients && msg.intercept != null
      ? `### Fitted virtual sensor\n` +
        `- **Substituting:** ${msg.target}\n` +
        `- **Predictors:** ${msg.basis.join(", ")}\n` +
        `- **β₀ (intercept):** ${msg.intercept.toFixed(5)}\n` +
        msg.basis.map((b, i) => `- **β${i + 1} (${b}):** ${(msg.coefficients as number[])[i].toFixed(5)}`).join("\n") +
        (msg.r2 != null ? `\n- **R²:** ${msg.r2.toFixed(3)}` : "") +
        "\n"
      : "";
  const body = composeMd(`${fitLine}\n${msg.prose}`, msg.code, msg.lang || "cpp");
  setBlueState(msg.used_fallback ? "PATCH (FALLBACK)" : "PATCH READY", body);
  els.btnBlueAction.textContent = "Apply patch";
  els.btnBlueAction.disabled = false;
}

function handleHardenPatchApplied(_msg: HardenPatchAppliedMsg): void {
  hardenState = "patched";
  setHardenStep("patch", "done");
  if (sceneApi && activeAttackPart) sceneApi.setSensorFailure(activeAttackPart, false);
  activeAttackPart = null;
  setBlueState("PATCHED");
  els.btnBlueAction.textContent = "Patch active";
  els.btnBlueAction.disabled = true;
  els.btnBlueAction.setAttribute("data-state", "patched");
  setSystemStatus("patched");
  setRedState("NEUTRALIZED");
  els.redPanel.setAttribute("data-state", "patched");
}

function handleHardenExited(): void {
  exitHardenLocal();
}

els.btnHarden.addEventListener("click", enterHarden);

els.btnRedAction.addEventListener("click", () => {
  if (hardenState === "armed") {
    hardenState = "planning";
    setHardenStep("recon", "active");
    setRedState("PLANNING…");
    els.btnRedAction.disabled = true;
    sendWs("request_red_plan");
  } else if (hardenState === "planned") {
    setHardenStep("attack", "active");
    sendWs("launch_attack");
  }
});

els.btnBlueAction.addEventListener("click", () => {
  if (hardenState === "attacking") {
    hardenState = "planning"; // blue planning, not red — but reuse tag styling via state attr
    setHardenStep("analysis", "active");
    els.bluePanel.setAttribute("data-state", "planning");
    setBlueState("PLANNING…");
    els.btnBlueAction.disabled = true;
    sendWs("request_blue_patch");
  } else if (hardenState === "patching") {
    setHardenStep("patch", "active");
    sendWs("apply_patch");
  }
});

els.btnExitHarden.addEventListener("click", () => {
  sendWs("exit_harden");
  exitHardenLocal();
});

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
