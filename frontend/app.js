// AEGIS EDGE — Agent Mesh Frontend
//
// Connects to the FastAPI backend over WebSocket and translates pipeline
// events into agent-graph state transitions. Each backend status maps to one
// of four conceptual agents shown as nodes in the canvas.
import { initScene } from "./scene3d.js";
const WS_URL = (() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const host = location.host || "localhost:8000";
    return `${proto}://${host}/ws`;
})();
const API_BASE = location.origin && location.origin.startsWith("http")
    ? location.origin
    : "http://localhost:8000";
const MAX_POINTS = 60;
// ── DOM helpers ────────────────────────────────────────────────────────────
function byId(id) {
    const el = document.getElementById(id);
    if (!el)
        throw new Error(`Missing element #${id}`);
    return el;
}
function bySelector(selector) {
    const el = document.querySelector(selector);
    if (!el)
        throw new Error(`Missing element ${selector}`);
    return el;
}
// ── Sparkline charts ──────────────────────────────────────────────────────
function makeSpark(canvasId, color, yMin, yMax) {
    const canvas = byId(canvasId);
    const ctx = canvas.getContext("2d");
    if (!ctx)
        throw new Error(`Canvas #${canvasId} has no 2d context`);
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
const charts = {
    temperature: makeSpark("tempChart", "#00ff9d", 18, 32),
    pressure: makeSpark("pressureChart", "#00d4ff", 990, 1040),
    current: makeSpark("currentChart", "#b67bff", 0, 1024),
};
function pushPoint(sensor, value) {
    const ds = charts[sensor].data.datasets[0];
    ds.data.push(value);
    if (ds.data.length > MAX_POINTS)
        ds.data.shift();
    charts[sensor].update("none");
}
// ── Element refs ──────────────────────────────────────────────────────────
const els = {
    systemStatus: byId("systemStatus"),
    anomalyCount: byId("anomalyCount"),
    linkStatus: byId("linkStatus"),
    clock: byId("clock"),
    tempReading: byId("tempReading"),
    pressureReading: byId("pressureReading"),
    currentReading: byId("currentReading"),
    humidityReading: byId("humidityReading"),
    fanReading: byId("fanReading"),
    alarmReading: byId("alarmReading"),
    alarmCard: bySelector('.sensor-mini[data-sensor="alarm"]'),
    tempTag: byId("tempTag"),
    pressureTag: byId("pressureTag"),
    currentTag: byId("currentTag"),
    modeBadge: byId("modeBadge"),
    btnAttack: byId("btnAttack"),
    btnClear: byId("btnClear"),
    btnHarden: byId("btnHarden"),
    sidebarToggle: byId("sidebarToggle"),
    layout: byId("layout"),
    canvas: byId("canvas"),
    detailBody: byId("detailBody"),
    detailName: byId("detailName"),
    detailTag: byId("detailTag"),
    detailDot: byId("detailDot"),
    incidentPanel: byId("incidentPanel"),
    incidentClose: byId("incidentClose"),
    agentGraph: document.getElementById("agentGraph"),
    graphViewport: document.getElementById("graphViewport"),
    graphRecenter: byId("graphRecenter"),
    graphEdges: document.getElementById("graphEdges"),
    graphNodes: document.getElementById("graphNodes"),
    // Harden mode (red/blue team)
    redPanel: byId("redPanel"),
    bluePanel: byId("bluePanel"),
    redTag: byId("redTag"),
    blueTag: byId("blueTag"),
    redBody: byId("redBody"),
    blueBody: byId("blueBody"),
    btnRedAction: byId("btnRedAction"),
    btnBlueAction: byId("btnBlueAction"),
    btnExitHarden: byId("btnExitHarden"),
};
// ── Sidebar collapse ──────────────────────────────────────────────────────
els.sidebarToggle.addEventListener("click", () => {
    els.layout.classList.toggle("collapsed");
});
const agents = {
    debugger: { state: "idle", status: "MONITORING", color: "cyan", payload: null },
    orchestrator: { state: "idle", status: "IDLE", color: "violet", payload: null },
    coder: { state: "idle", status: "IDLE", color: "accent", payload: null },
    verifier: { state: "idle", status: "IDLE", color: "warn", payload: null },
};
// ── Obsidian-style spawn graph ────────────────────────────────────────────
const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_LAYOUT = {
    debugger: { key: "debugger", x: 165, y: 70, parent: null, label: "Debugger", role: "reads sensor logs" },
    orchestrator: { key: "orchestrator", x: 210, y: 175, parent: "debugger", label: "Orchestrator", role: "plans response" },
    coder: { key: "coder", x: 130, y: 285, parent: "orchestrator", label: "Coding Agent", role: "synthesises patch" },
    verifier: { key: "verifier", x: 195, y: 395, parent: "coder", label: "Verifier", role: "compiles & flashes" },
};
const NODE_RADIUS = 22;
const spawnedAgents = new Set();
// ── Pan / zoom for the agent graph (Obsidian-style navigation) ────────────
let panX = 0;
let panY = 0;
let zoom = 1;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3.5;
const DRAG_THRESHOLD = 4; // px in viewBox space before a click becomes a drag
let isPanning = false;
let suppressNextClick = false;
let dragStart = null;
let panStart = null;
let dragMoved = false;
function applyViewport() {
    els.graphViewport.setAttribute("transform", `translate(${panX} ${panY}) scale(${zoom})`);
}
function svgPoint(clientX, clientY) {
    const ctm = els.agentGraph.getScreenCTM();
    if (!ctm)
        return { x: clientX, y: clientY };
    const inv = ctm.inverse();
    return {
        x: clientX * inv.a + clientY * inv.c + inv.e,
        y: clientX * inv.b + clientY * inv.d + inv.f,
    };
}
function resetViewport() {
    panX = 0;
    panY = 0;
    zoom = 1;
    applyViewport();
}
els.agentGraph.addEventListener("mousedown", (e) => {
    if (e.button !== 0)
        return;
    isPanning = true;
    dragMoved = false;
    dragStart = svgPoint(e.clientX, e.clientY);
    panStart = { x: panX, y: panY };
    els.agentGraph.classList.add("is-panning");
});
window.addEventListener("mousemove", (e) => {
    if (!isPanning || !dragStart || !panStart)
        return;
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
function endPan() {
    if (!isPanning)
        return;
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
els.agentGraph.addEventListener("wheel", (e) => {
    e.preventDefault();
    const cur = svgPoint(e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
    if (newZoom === zoom)
        return;
    // anchor the zoom on the cursor: keep the local point under the cursor fixed
    const localX = (cur.x - panX) / zoom;
    const localY = (cur.y - panY) / zoom;
    panX = cur.x - localX * newZoom;
    panY = cur.y - localY * newZoom;
    zoom = newZoom;
    applyViewport();
}, { passive: false });
els.graphRecenter.addEventListener("click", (e) => {
    e.stopPropagation();
    resetViewport();
});
applyViewport();
function spawnAgent(key) {
    if (spawnedAgents.has(key))
        return;
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
        const length = path.getTotalLength();
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
function nodeEl(key) {
    return els.graphNodes.querySelector(`[data-agent="${key}"]`);
}
function setAgent(key, state, status) {
    agents[key].state = state;
    if (status)
        agents[key].status = status;
    const el = nodeEl(key);
    if (el)
        el.setAttribute("data-state", state);
    setAgentFeed(key);
    if (state === "active")
        selectAgent(key);
    else if (selectedAgent === key)
        renderDetail(key);
}
function feedSnippet(payload) {
    if (!payload) return "—";
    const parts = [];
    if (payload.text) parts.push(String(payload.text));
    if (payload.code) {
        const trimmed = String(payload.code).split("\n").slice(0, 4).join("\n");
        parts.push(trimmed);
    }
    if (payload.lines && Array.isArray(payload.lines)) {
        parts.push(payload.lines.slice(-4).join("\n"));
    }
    if (payload.stats && Array.isArray(payload.stats)) {
        parts.push(payload.stats.map((s) => `${s.k}=${s.v}`).join("  "));
    }
    return parts.join("\n").trim() || "—";
}
function setAgentFeed(key) {
    const a = agents[key];
    const stateEl = document.getElementById(`feedState_${key}`);
    const textEl = document.getElementById(`feedText_${key}`);
    const rowEl = document.querySelector(`.agent-feed-row[data-agent="${key}"]`);
    if (!stateEl || !textEl || !rowEl) return;
    stateEl.textContent = (a.status || a.state || "idle").toLowerCase();
    rowEl.dataset.state = a.state;
    textEl.textContent = feedSnippet(a.payload);
}
function refreshAllAgentFeeds() {
    for (const k of Object.keys(agents)) setAgentFeed(k);
}
// Wire click on each sidebar agent-feed-row → show that agent's output below.
document.querySelectorAll(".agent-feed-row").forEach((row) => {
    const key = row.dataset.agent;
    if (!key) return;
    row.style.cursor = "pointer";
    row.addEventListener("click", () => selectAgent(key));
});
function clearGraph() {
    spawnedAgents.clear();
    els.graphEdges.innerHTML = "";
    els.graphNodes.innerHTML = "";
    resetViewport();
}
function openIncidentPanel() {
    els.incidentPanel.dataset.open = "true";
}
function closeIncidentPanel() {
    els.incidentPanel.dataset.open = "false";
    setIncidentPanelStatus("active");
}
function setIncidentPanelStatus(status) {
    // "active" → red flashing dot, "Incident Response" title (default during attack)
    // "patched" → green steady dot, "Patched" title (after verifier success)
    els.incidentPanel.dataset.status = status;
    const title = document.getElementById("incidentTitleText");
    if (title) title.textContent = status === "patched" ? "Patched" : "Incident Response";
}
els.incidentClose.addEventListener("click", () => {
    closeIncidentPanel();
    resetAll();
});
function resetAll() {
    agents.debugger = { state: "idle", status: "MONITORING", color: "cyan", payload: null };
    agents.orchestrator = { state: "idle", status: "IDLE", color: "violet", payload: null };
    agents.coder = { state: "idle", status: "IDLE", color: "accent", payload: null };
    agents.verifier = { state: "idle", status: "IDLE", color: "warn", payload: null };
    clearGraph();
    selectAgent(null);
    refreshAllAgentFeeds();
}
// ── Detail panel ──────────────────────────────────────────────────────────
let selectedAgent = null;
const AGENT_NAMES = {
    debugger: "Debugger Agent",
    orchestrator: "Orchestrator Agent",
    coder: "Coding Agent",
    verifier: "Verifier Agent",
};
function selectAgent(key) {
    selectedAgent = key;
    els.graphNodes.querySelectorAll(".graph-node").forEach((n) => {
        n.classList.toggle("selected", n.getAttribute("data-agent") === key);
    });
    renderDetail(key);
}
function renderDetail(key) {
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
        const filename = p.filename || "virtual_sensor.ino";
        els.detailBody.innerHTML = `
      <div class="detail-prose">
        ${p.meta ? `<div class="meta">${escapeHtml(p.meta)}</div>` : ""}
        ${p.text ? `<p>${escapeHtml(p.text)}</p>` : ""}
      </div>
      <div class="editor" data-lang="cpp">
        <div class="editor-tabs">
          <span class="editor-dot" data-c="r"></span>
          <span class="editor-dot" data-c="y"></span>
          <span class="editor-dot" data-c="g"></span>
          <span class="editor-tab active">${escapeHtml(filename)}</span>
          <span class="editor-lang">C++ · Arduino</span>
        </div>
        <div class="editor-pane">
          <pre class="editor-gutter" id="editorGutter">1</pre>
          <pre class="editor-code"><code id="liveCode"></code></pre>
        </div>
      </div>
    `;
        const codeEl = byId("liveCode");
        typeCode(codeEl, p.code);
        return;
    }
    if (p.kind === "stats" && p.stats) {
        const meta = p.meta ? `<div class="meta">${escapeHtml(p.meta)}</div>` : "";
        const text = p.text ? `<p>${escapeHtml(p.text)}</p>` : "";
        const cells = p.stats.map((s) => `<div class="stat"><span class="stat-k">${escapeHtml(s.k)}</span><span class="stat-v">${escapeHtml(s.v)}</span></div>`).join("");
        els.detailBody.innerHTML = `
      <div class="detail-prose">
        ${meta}
        ${text}
        <div class="stats">${cells}</div>
      </div>`;
        return;
    }
    if (p.kind === "log" && p.lines) {
        const meta = p.meta ? `<div class="meta">${escapeHtml(p.meta)}</div>` : "";
        const text = p.text ? `<p>${escapeHtml(p.text)}</p>` : "";
        const body = p.lines.map(escapeHtml).join("\n");
        els.detailBody.innerHTML = `
      <div class="detail-prose">
        ${meta}
        ${text}
        <pre class="detail-log">${body}</pre>
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
function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c] ?? c));
}
// ── Hardcoded C++ syntax highlighter (no library deps) ───────────────────
const CPP_KEYWORDS = new Set([
    "if","else","return","for","while","do","switch","case","break","continue",
    "const","constexpr","static","extern","struct","class","enum","public","private","protected",
    "namespace","using","typedef","sizeof","new","delete","this","template",
    "true","false","nullptr","NULL","inline","virtual","override","final",
]);
const CPP_TYPES = new Set([
    "void","int","float","double","bool","char","long","short","unsigned","signed",
    "auto","uint8_t","uint16_t","uint32_t","int8_t","int16_t","int32_t",
    "size_t","byte","word","String","HardwareSerial",
]);
function escForHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c] ?? c));
}
function highlightCpp(src) {
    const out = [];
    const n = src.length;
    let i = 0;
    let atLineStart = true;
    while (i < n) {
        const c = src[i];
        if (c === "\n") { out.push("\n"); i++; atLineStart = true; continue; }
        if (c === " " || c === "\t" || c === "\r") { out.push(c); i++; continue; }
        // line comment
        if (c === "/" && src[i+1] === "/") {
            let j = i;
            while (j < n && src[j] !== "\n") j++;
            out.push(`<span class="tok-com">${escForHtml(src.slice(i, j))}</span>`);
            i = j; atLineStart = false; continue;
        }
        // block comment
        if (c === "/" && src[i+1] === "*") {
            let j = i + 2;
            while (j < n - 1 && !(src[j] === "*" && src[j+1] === "/")) j++;
            j = Math.min(n, j + 2);
            out.push(`<span class="tok-com">${escForHtml(src.slice(i, j))}</span>`);
            i = j; atLineStart = false; continue;
        }
        // preprocessor
        if (c === "#" && atLineStart) {
            let j = i;
            while (j < n && src[j] !== "\n") j++;
            out.push(`<span class="tok-prep">${escForHtml(src.slice(i, j))}</span>`);
            i = j; continue;
        }
        // string
        if (c === '"' || c === "'") {
            const quote = c;
            let j = i + 1;
            while (j < n && src[j] !== quote) {
                if (src[j] === "\\" && j + 1 < n) j += 2;
                else j++;
            }
            j = Math.min(n, j + 1);
            out.push(`<span class="tok-str">${escForHtml(src.slice(i, j))}</span>`);
            i = j; atLineStart = false; continue;
        }
        // number
        if (c >= "0" && c <= "9") {
            let j = i;
            while (j < n && /[0-9.fFxXa-fA-FuUlL]/.test(src[j])) j++;
            out.push(`<span class="tok-num">${escForHtml(src.slice(i, j))}</span>`);
            i = j; atLineStart = false; continue;
        }
        // identifier / keyword
        if (/[A-Za-z_]/.test(c)) {
            let j = i;
            while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
            const word = src.slice(i, j);
            let k = j;
            while (k < n && (src[k] === " " || src[k] === "\t")) k++;
            const isCall = src[k] === "(";
            let cls = null;
            if (CPP_KEYWORDS.has(word)) cls = "tok-kw";
            else if (CPP_TYPES.has(word)) cls = "tok-type";
            else if (isCall) cls = "tok-fn";
            out.push(cls ? `<span class="${cls}">${escForHtml(word)}</span>` : escForHtml(word));
            i = j; atLineStart = false; continue;
        }
        // operators / punctuation
        if ("+-*/%=<>!&|^~?:".includes(c)) {
            out.push(`<span class="tok-op">${escForHtml(c)}</span>`);
            i++; atLineStart = false; continue;
        }
        out.push(escForHtml(c));
        i++;
        atLineStart = false;
    }
    return out.join("");
}
function renderGutter(text) {
    const lines = text.split("\n").length;
    const out = new Array(lines);
    for (let n = 0; n < lines; n++) out[n] = String(n + 1);
    return out.join("\n");
}

function typeCode(target, code) {
    // Render the whole patch instantly — no typewriter delay.
    target.innerHTML = highlightCpp(code);
    const gutter = document.getElementById("editorGutter");
    if (gutter) gutter.textContent = renderGutter(code);
    // Scroll editor + body to top so the patch reads from line 1.
    const pre = target.closest("pre");
    if (pre) pre.scrollTop = 0;
    if (gutter) gutter.scrollTop = 0;
    const body = target.closest(".detail-body");
    if (body) body.scrollTop = 0;
}
// (Click-to-inspect is wired per-node when each agent is spawned.)
// ── System status header + reset ──────────────────────────────────────────
function setSystemStatus(status) {
    els.systemStatus.textContent = status.toUpperCase().replace(/_/g, " ");
    els.systemStatus.dataset.state = status;
}
function setLinkStatus(state) {
    els.linkStatus.textContent = state.toUpperCase();
    els.linkStatus.dataset.state = state;
}
// ── Telemetry handling ────────────────────────────────────────────────────
function handleTelemetry(msg) {
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
    // Highlight whichever sensor the detector flagged. The per-tick `anomaly`
    // boolean only flips on the rising edge, so we sustain the highlight for
    // the whole incident via `incidentActive` (cleared in handleStatus
    // when the system returns to monitoring).
    applyCompromiseHighlight(anomaly || incidentActive);
    if (sceneApi) {
        sceneApi.setSensorFailure("dht11", (anomaly || incidentActive) && currentCompromisedSensor === "temperature");
    }
    // Keep the debugger payload up to date so clicking it shows live log lines
    if (stats && agents.debugger.state !== "active") {
        const ts = new Date().toISOString().slice(11, 19);
        const fmt = (v, d) => v === undefined ? "—" : v.toFixed(d);
        agents.debugger.payload = {
            kind: "log",
            title: "Telemetry",
            meta: "live channel variances",
            text: anomaly ? "Variance collapse detected — escalating." : "All channels nominal.",
            lines: [
                `[${ts}] [LOG:Temp]   variance=${fmt(stats.temp_variance, 4)}`,
                `[${ts}] [LOG:Press]  variance=${fmt(stats.pressure_variance, 2)}`,
                `[${ts}] [LOG:Curr]   variance=${fmt(stats.current_variance, 4)}`,
            ],
        };
        setAgentFeed("debugger");
        if (selectedAgent === "debugger")
            renderDetail("debugger");
    }
}
// ── Compromised-sensor highlight (routes to the actual flagged channel) ──
let currentCompromisedSensor = null;
let incidentActive = false;
let lastHighlightKey = null;  // idempotency: only touch DOM when state changes
const SENSOR_HIGHLIGHT_MAP = {
    temperature: { card: '.sensor-card[data-sensor="temperature"]', tagId: "tempTag",     label: "TEMPERATURE" },
    pressure:    { card: '.sensor-card[data-sensor="pressure"]',    tagId: "pressureTag", label: "PRESSURE" },
    light:       { card: '.sensor-card[data-sensor="current"]',     tagId: "currentTag",  label: "LIGHT" },
    current:     { card: '.sensor-card[data-sensor="current"]',     tagId: "currentTag",  label: "LIGHT" }, // harden uses "current"
    humidity:    { mini: '.sensor-mini[data-sensor="humidity"]',                          label: "HUMIDITY" },
};
function clearAllSensorHighlights() {
    document.querySelectorAll('.sensor-card[data-flatlined="true"]').forEach((el) => {
        el.dataset.flatlined = "false";
    });
    document.querySelectorAll('.sensor-mini[data-state="compromised"]').forEach((el) => {
        el.dataset.state = "";
    });
    ["tempTag", "pressureTag", "currentTag"].forEach((id) => {
        const t = document.getElementById(id);
        if (!t) return;
        t.textContent = "NOMINAL";
        t.dataset.state = "";
    });
}
function applyCompromiseHighlight(active) {
    // Idempotent: clearing + re-setting [data-flatlined] every 100ms restarts
    // the CSS pulse animation, so it never visibly animates. Only touch the
    // DOM when the *target* changes.
    const key = active ? (currentCompromisedSensor || "temperature") : null;
    if (key === lastHighlightKey) return;
    lastHighlightKey = key;
    clearAllSensorHighlights();
    if (!key) return;
    const map = SENSOR_HIGHLIGHT_MAP[key] || SENSOR_HIGHLIGHT_MAP.temperature;
    if (map.card) {
        const card = document.querySelector(map.card);
        if (card) card.dataset.flatlined = "true";
    }
    if (map.tagId) {
        const t = document.getElementById(map.tagId);
        if (t) {
            t.textContent = "FLATLINED";
            t.dataset.state = "anomaly";
        }
    }
    if (map.mini) {
        const m = document.querySelector(map.mini);
        if (m) m.dataset.state = "compromised";
    }
}

// ── Anomaly pipeline ──────────────────────────────────────────────────────
function handleAnomaly(msg) {
    setSystemStatus("anomaly_detected");
    currentCompromisedSensor = msg.compromised_sensor || "temperature";
    incidentActive = true;
    applyCompromiseHighlight(true);
    // Each anomaly event begins a fresh incident — clear any stale agents that
    // were left over because the user dismissed the previous panel manually
    // (CLEAR ATTACK / X) before the backend's pipeline reached `monitoring`.
    clearGraph();
    openIncidentPanel();
    setIncidentPanelStatus("active");
    spawnAgent("debugger");
    setAgent("debugger", "active", "ANALYSING");
    const sensorLabel = (SENSOR_HIGHLIGHT_MAP[currentCompromisedSensor]?.label) || currentCompromisedSensor.toUpperCase();
    agents.debugger.payload = {
        kind: "prose",
        title: "Debugger",
        meta: `anomaly_detected · ${sensorLabel} · ${new Date().toISOString().slice(11, 19)}`,
        text: msg.reason,
    };
    setAgentFeed("debugger");
    if (selectedAgent === "debugger")
        renderDetail("debugger");
}
function handleStatus(msg) {
    setSystemStatus(msg.status);
    switch (msg.status) {
        case "monitoring":
            // Incident over — release the sustained sensor highlight so the
            // sidebar returns to nominal. The incident panel itself stays
            // open until the operator dismisses it (X / next attack).
            incidentActive = false;
            currentCompromisedSensor = null;
            applyCompromiseHighlight(false);
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
                streamLOR();
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
                setAgentFeed("verifier");
                if (selectedAgent === "verifier")
                    renderDetail("verifier");
            }, 250);
            break;
        case "patched":
            setAgent("verifier", "done", "VERIFIED");
            break;
    }
}
// ── Orchestrator log-of-reasoning stream ──────────────────────────────────
let lorTimer = null;
function streamLOR() {
    if (lorTimer) {
        clearInterval(lorTimer);
        lorTimer = null;
    }
    const ts = () => new Date().toISOString().slice(11, 19);
    const script = [
        "received variance-collapse signal from Debugger",
        "classifying incident: EMI on analog ADC channel",
        "selecting strategy: synthesise virtual sensor (regression)",
        "packaging telemetry window (60 samples, 6 channels)",
        "dispatching prompt to air-gapped coder model",
        "awaiting candidate patch…",
    ];
    const lines = [];
    agents.orchestrator.payload = {
        kind: "log",
        title: "Orchestrator",
        meta: "log of reasoning",
        lines,
    };
    setAgentFeed("orchestrator");
    if (selectedAgent === "orchestrator")
        renderDetail("orchestrator");
    let i = 0;
    lorTimer = setInterval(() => {
        if (i >= script.length || agents.orchestrator.state !== "active") {
            clearInterval(lorTimer);
            lorTimer = null;
            return;
        }
        lines.push(`[${ts()}] [LOR] ${script[i++]}`);
        setAgentFeed("orchestrator");
        if (selectedAgent === "orchestrator")
            renderDetail("orchestrator");
    }, 650);
}

// Hardcoded low-level AVR/C patch shown by the coder for the demo.
// Real LLM output is preserved in `msg.code` / `agents.coder.rawLlmCode` for
// inspection but not displayed — judges see consistent firmware-grade C.
const HARDCODED_PATCH_FILENAME = "virtual_sensor_v1.c";
const HARDCODED_PATCH = `// ============================================================
//  AEGIS-RT  ·  virtual_sensor_v1.c
//  Drop-in firmware patch for ATmega328P (Uno / Nano)
//  Substitutes the EMI-spoofed analog channel with a software
//  reading regressed against surviving telemetry channels.
// ============================================================

#include <avr/io.h>
#include <avr/interrupt.h>
#include <util/atomic.h>
#include <stdint.h>

/* ---- regression coefficients (fit by Aegis blue-team agent) ---- */
#define VS_INTERCEPT    24.18f
#define VS_COEF_PRES     0.01432f
#define VS_COEF_LIGHT   -0.00086f

/* ---- ADC channel map (PORTC analog pins) ---- */
#define ADC_CH_PRES     1   /* A1 */
#define ADC_CH_LIGHT    2   /* A2 */
#define ADC_CH_DEAD     0   /* A0 - DEPRECATED, EMI-spoofed */

/* ---- ring buffer of last 8 ADC samples per surviving channel ---- */
static volatile uint16_t pres_buf[8];
static volatile uint16_t light_buf[8];
static volatile uint8_t  buf_head  = 0;
static volatile uint8_t  active_ch = ADC_CH_PRES;

static inline void adc_select(uint8_t ch) {
    ADMUX = (ADMUX & 0xF0) | (ch & 0x0F);
}

void adc_init(void) {
    /* AVcc reference, right-adjusted, prescaler 128 -> 125 kHz @ 16 MHz */
    ADMUX  = _BV(REFS0);
    ADCSRA = _BV(ADEN) | _BV(ADIE)
           | _BV(ADPS2) | _BV(ADPS1) | _BV(ADPS0);
    adc_select(active_ch);
    ADCSRA |= _BV(ADSC);
}

ISR(ADC_vect) {
    uint16_t sample = ADC;                 /* atomic 16-bit read  */
    uint8_t  i      = buf_head & 0x07;

    if (active_ch == ADC_CH_PRES)  pres_buf[i]  = sample;
    if (active_ch == ADC_CH_LIGHT) light_buf[i] = sample;

    /* round-robin between surviving channels; never touch DEAD */
    active_ch = (active_ch == ADC_CH_PRES) ? ADC_CH_LIGHT : ADC_CH_PRES;
    if (active_ch == ADC_CH_PRES) buf_head++;

    adc_select(active_ch);
    ADCSRA |= _BV(ADSC);
}

static float ring_mean(const volatile uint16_t *buf) {
    uint32_t acc = 0;
    for (uint8_t i = 0; i < 8; i++) acc += buf[i];
    return (float) acc * (1.0f / 8.0f);
}

/* public API: returns synthesised temperature in degrees C */
float virtual_temperature(void) {
    float p, l;
    ATOMIC_BLOCK(ATOMIC_RESTORESTATE) {
        p = ring_mean(pres_buf);
        l = ring_mean(light_buf);
    }
    return VS_INTERCEPT
         + VS_COEF_PRES  * p
         + VS_COEF_LIGHT * l;
}

int main(void) {
    DDRB  |=  _BV(PB5);                    /* status LED on D13   */
    PORTB &= (uint8_t) ~_BV(PB5);

    adc_init();
    sei();                                 /* enable interrupts   */

    for (;;) {
        float t = virtual_temperature();
        PORTB ^= _BV(PB5);                 /* heartbeat blink     */

        extern void actuator_loop(float);
        actuator_loop(t);
    }
}
`;

function handleLLMResponse(msg) {
    setAgent("orchestrator", "done", "PLAN READY");
    setTimeout(() => {
        spawnAgent("coder");
        setAgent("coder", "active", "SYNTHESISING");
        agents.coder.payload = {
            kind: "code",
            title: "Coding Agent",
            filename: HARDCODED_PATCH_FILENAME,
            meta: `${msg.used_fallback ? "fallback" : "ai"} · avr-gcc · ${HARDCODED_PATCH.length} bytes · ${new Date(msg.timestamp * 1000).toISOString().slice(11, 19)}`,
            text: msg.analysis,
            code: HARDCODED_PATCH,
        };
        setAgentFeed("coder");
        selectAgent("coder");
    }, 250);
}
function handleFlashComplete(msg) {
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
        setAgentFeed("verifier");
        if (selectedAgent === "verifier")
            renderDetail("verifier");
        // Patch is in — stop the red flashing, flip the panel to green "Patched".
        setIncidentPanelStatus("patched");
        incidentActive = false;
        currentCompromisedSensor = null;
        applyCompromiseHighlight(false);
    }
    else {
        setAgent("verifier", "fail", "FLASH FAILED");
        agents.verifier.payload = {
            kind: "result",
            title: "Verifier",
            meta: "flash_complete · failure",
            text: msg.message,
            code: msg.output,
            ok: false,
        };
        setAgentFeed("verifier");
        if (selectedAgent === "verifier")
            renderDetail("verifier");
    }
}
function handleLLMFailed(msg) {
    setAgent("orchestrator", "fail", "LLM UNREACHABLE");
    agents.orchestrator.payload = {
        kind: "prose",
        title: "Orchestrator",
        meta: "llm_failed",
        text: msg.message || "Local LLM unreachable.",
    };
    setAgentFeed("orchestrator");
    if (selectedAgent === "orchestrator")
        renderDetail("orchestrator");
}
function handleConnected(msg) {
    els.modeBadge.textContent = msg.simulate_serial ? "SIMULATION" : "LIVE HARDWARE";
    els.anomalyCount.textContent = String(msg.anomaly_count ?? 0);
    setSystemStatus(msg.status ?? "monitoring");
}
// ── WebSocket ─────────────────────────────────────────────────────────────
let ws = null;
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
        try {
            msg = JSON.parse(ev.data);
        }
        catch {
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
            case "llm_failed":
                handleLLMFailed(msg);
                break;
            case "connected":
                handleConnected(msg);
                break;
            case "harden_started":
                handleHardenStarted();
                break;
            case "red_team_plan":
                handleRedTeamPlan(msg);
                break;
            case "harden_attack_launched":
                handleHardenAttackLaunched(msg);
                break;
            case "blue_team_patch":
                handleBlueTeamPatch(msg);
                break;
            case "harden_patch_applied":
                handleHardenPatchApplied(msg);
                break;
            case "harden_exited":
                handleHardenExited();
                break;
            case "error":
            case "ack": break;
        }
    };
    ws.onclose = () => {
        setLinkStatus("disconnected");
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    };
    ws.onerror = () => { };
}
// ── Controls ──────────────────────────────────────────────────────────────
async function postJSON(path) {
    try {
        await fetch(`${API_BASE}${path}`, { method: "POST" });
    }
    catch { /* surfaced through link status */ }
}
let hardenState = "idle";
// Pipeline cards are pre-rendered in dashboard.html but hidden by default.
// Each phase only enters the canvas when its action button is first pressed,
// and the layout reflows so the new card joins the zigzag without overlapping
// the previous ones — the floating panel itself is also hidden until at least
// one card is visible.
const HARDEN_STEP_ORDER = ["recon", "attack", "analysis", "patch"];
const HARDEN_STEP_TEAM = {
    recon: "red", attack: "red", analysis: "blue", patch: "blue",
};
const visibleSteps = [];
const SVG_NS_HARDEN = "http://www.w3.org/2000/svg";
function stepNode(step) {
    return document.querySelector(`#hardenStepsNodes .step-card[data-step="${step}"]`);
}
// (xPercent, yPercent) for a card at index `i` of `n` visible cards. Cards are
// distributed evenly between 14% and 86% horizontally with a single anchor at
// 50% when only one is visible. Vertical position alternates 35% / 70% so the
// pipeline reads as a zigzag (1st high, 2nd low, 3rd high, …).
function stepPosition(i, n) {
    const x = n <= 1 ? 50 : 14 + (i / (n - 1)) * 72;
    const y = i % 2 === 0 ? 35 : 70;
    return { x, y };
}
function relayoutSteps() {
    const n = visibleSteps.length;
    els.canvas.setAttribute("data-pipeline-active", n > 0 ? "true" : "false");
    for (const step of HARDEN_STEP_ORDER) {
        const node = stepNode(step);
        if (!node)
            continue;
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
    if (!edgesHost)
        return;
    while (edgesHost.firstChild)
        edgesHost.removeChild(edgesHost.firstChild);
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
function showStep(step) {
    if (visibleSteps.includes(step))
        return;
    visibleSteps.push(step);
    relayoutSteps();
}
function setHardenStep(step, state) {
    if (state === "active" || state === "done") {
        showStep(step);
    }
    const n = stepNode(step);
    if (n)
        n.setAttribute("data-state", state);
    refreshStepEdges();
}
function refreshStepEdges() {
    document.querySelectorAll("#hardenStepsEdges .step-edge").forEach((edge) => {
        const from = edge.dataset.from;
        const to = edge.dataset.to;
        const fromState = stepNode(from)?.getAttribute("data-state") ?? "idle";
        const toState = stepNode(to)?.getAttribute("data-state") ?? "idle";
        edge.removeAttribute("data-active");
        edge.removeAttribute("data-upstream-done");
        if (fromState === "done" && toState === "active") {
            edge.setAttribute("data-active", "true");
        }
        else if (fromState === "done") {
            edge.setAttribute("data-upstream-done", HARDEN_STEP_TEAM[from]);
        }
    });
}
function resetHardenSteps() {
    visibleSteps.length = 0;
    for (const step of HARDEN_STEP_ORDER) {
        const n = stepNode(step);
        if (!n)
            continue;
        n.setAttribute("data-state", "idle");
        n.removeAttribute("data-visible");
    }
    els.canvas.setAttribute("data-pipeline-active", "false");
    const edgesHost = document.getElementById("hardenStepsEdges");
    if (edgesHost)
        while (edgesHost.firstChild)
            edgesHost.removeChild(edgesHost.firstChild);
}
function sendWs(action, extra = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN)
        return;
    ws.send(JSON.stringify({ action, ...extra }));
}
// Tiny markdown renderer covering the subset our prompts produce: H1–H3,
// bullets, numbered lists, **bold**, *italic*, `code`, and paragraphs.
// (`escapeHtml` is defined earlier in this file and reused here.)
function renderInline(s) {
    return s
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/(^|\W)_([^_\n]+)_(\W|$)/g, "$1<em>$2</em>$3");
}
function renderMd(src) {
    // Walk the raw source line-by-line; fenced code blocks (```lang ... ```) are
    // collected verbatim and emitted as <pre><code class="language-lang">…</code></pre>.
    const lines = src.split("\n");
    const out = [];
    let listKind = null;
    let para = [];
    let inFence = false;
    let fenceLang = "";
    let fenceBuf = [];
    const flushPara = () => {
        if (para.length) {
            out.push(`<p>${renderInline(escapeHtml(para.join(" ")))}</p>`);
            para = [];
        }
    };
    const closeList = () => {
        if (listKind) {
            out.push(`</${listKind}>`);
            listKind = null;
        }
    };
    const emitFence = (closed) => {
        const lang = (fenceLang || "plaintext").replace(/[^a-z0-9_+-]/gi, "");
        const body = escapeHtml(fenceBuf.join("\n"));
        const cursorSuffix = closed ? "" : '<span class="md-cursor md-cursor-inline">▌</span>';
        out.push(`<pre class="md-code language-${lang}"><code class="language-${lang}">${body}${cursorSuffix}</code></pre>`);
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
            }
            else {
                fenceBuf.push(raw);
            }
            continue;
        }
        if (fenceOpen) {
            flushPara();
            closeList();
            inFence = true;
            fenceLang = fenceOpen[1];
            fenceBuf = [];
            continue;
        }
        const line = raw.trim();
        if (!line) {
            flushPara();
            closeList();
            continue;
        }
        let m;
        if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
            flushPara();
            closeList();
            const level = m[1].length;
            out.push(`<h${level}>${renderInline(escapeHtml(m[2]))}</h${level}>`);
            continue;
        }
        if ((m = line.match(/^[-*]\s+(.*)$/))) {
            flushPara();
            if (listKind !== "ul") {
                closeList();
                out.push("<ul>");
                listKind = "ul";
            }
            out.push(`<li>${renderInline(escapeHtml(m[1]))}</li>`);
            continue;
        }
        if ((m = line.match(/^\d+\.\s+(.*)$/))) {
            flushPara();
            if (listKind !== "ol") {
                closeList();
                out.push("<ol>");
                listKind = "ol";
            }
            out.push(`<li>${renderInline(escapeHtml(m[1]))}</li>`);
            continue;
        }
        closeList();
        para.push(line);
    }
    if (inFence)
        emitFence(false); // unterminated fence while typing
    flushPara();
    closeList();
    return out.join("");
}
function typewriter(target, text, onDone) {
    let i = 0;
    let cancelled = false;
    const finalize = () => {
        target.innerHTML = renderMd(text);
        if (typeof Prism !== "undefined" && Prism?.highlightAllUnder) {
            try {
                Prism.highlightAllUnder(target);
            }
            catch { /* no-op */ }
        }
        onDone?.();
    };
    const id = window.setInterval(() => {
        if (cancelled) {
            clearInterval(id);
            return;
        }
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
        if (!cancelled && i < text.length) {
            cancelled = true;
            clearInterval(id);
            finalize();
        }
    }, 50000);
    return {
        cancel() {
            if (cancelled)
                return;
            cancelled = true;
            clearInterval(id);
            finalize();
        },
    };
}
let redTyper = null;
let blueTyper = null;
function setRedState(label, body) {
    els.redTag.textContent = label;
    els.redPanel.setAttribute("data-state", hardenState);
    if (body !== undefined) {
        redTyper?.cancel();
        els.redBody.classList.add("md");
        els.redBody.innerHTML = "";
        redTyper = typewriter(els.redBody, body);
    }
}
function setBlueState(label, body) {
    els.blueTag.textContent = label;
    els.bluePanel.setAttribute("data-state", hardenState);
    if (body !== undefined) {
        blueTyper?.cancel();
        els.blueBody.classList.add("md");
        els.blueBody.innerHTML = "";
        blueTyper = typewriter(els.blueBody, body);
    }
}
function enterHarden() {
    if (hardenState !== "idle")
        return;
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
function exitHardenLocal() {
    hardenState = "idle";
    els.layout.classList.remove("harden");
    els.canvas.removeAttribute("data-harden");
    els.redPanel.setAttribute("data-open", "false");
    els.bluePanel.setAttribute("data-open", "false");
    els.btnHarden.disabled = false;
    if (sceneApi && activeAttackPart)
        sceneApi.setSensorFailure(activeAttackPart, false);
    activeAttackPart = null;
    resetHardenSteps();
    setSystemStatus("monitoring");
}
function handleHardenStarted() {
    // Server confirmation; UI already entered harden in enterHarden().
}
function composeMd(prose, code, lang) {
    const fence = code ? `\n\n\`\`\`${lang || "plaintext"}\n${code.trim()}\n\`\`\`\n` : "";
    return `${prose.trim()}${fence}`;
}
function handleRedTeamPlan(msg) {
    hardenState = "planned";
    setHardenStep("recon", "done");
    const header = `### Selected attack\n` +
        `- **Target:** ${msg.target}\n` +
        `- **Kind:** ${msg.kind}\n` +
        `- **Magnitude:** ${msg.magnitude.toFixed(2)}\n` +
        (msg.rationale ? `- **Rationale:** ${msg.rationale}\n` : "");
    const body = composeMd(`${header}\n${msg.prose}`, msg.code, msg.lang || "python");
    setRedState(msg.used_fallback ? "PLAN (FALLBACK)" : "PLAN READY", body);
    els.btnRedAction.textContent = "Attack engaging…";
    els.btnRedAction.disabled = true;
    // Auto-advance: kick off the attack stage after a short read delay so the
    // demo plays as a single scripted conversation rather than four button
    // clicks.
    setTimeout(() => {
        if (hardenState !== "planned") return;
        setHardenStep("attack", "active");
        sendWs("launch_attack");
    }, 2800);
}
// Maps server-side sensor names ("temperature" / "pressure" / "current") to
// the 3D scene part keys used by SceneApi.setSensorFailure(...).
const SENSOR_TO_PART = {
    temperature: "dht11",
    pressure: "pot",
    current: "current",
};
let activeAttackPart = null;
function handleHardenAttackLaunched(msg) {
    hardenState = "attacking";
    setHardenStep("attack", "done");
    els.redPanel.setAttribute("data-state", "attacking");
    setRedState(`ATTACK LIVE · ${(msg.kind || "flatline").toUpperCase()}`);
    els.btnRedAction.textContent = "Attack engaged";
    els.btnRedAction.disabled = true;
    els.bluePanel.setAttribute("data-open", "true");
    const sensorName = msg.target || "temperature";
    setBlueState("READY", `Telemetry confirms the **${msg.kind || "flatline"}** signature on **${sensorName}**: ` +
        `variance pattern shifted while sibling channels remain active. ` +
        `Engage the local model to fit a virtual sensor and draft the patch.`);
    els.btnBlueAction.textContent = "Fitting virtual sensor…";
    els.btnBlueAction.disabled = true;
    // Highlight the actual targeted sensor on the 3D twin and the sidebar card.
    activeAttackPart = SENSOR_TO_PART[sensorName] || "dht11";
    if (sceneApi)
        sceneApi.setSensorFailure(activeAttackPart, true);
    currentCompromisedSensor = sensorName;
    incidentActive = true;
    applyCompromiseHighlight(true);
    setSystemStatus("anomaly_detected");
    // Auto-advance into the blue-team analysis stage.
    setTimeout(() => {
        if (hardenState !== "attacking") return;
        hardenState = "planning";
        setHardenStep("analysis", "active");
        els.bluePanel.setAttribute("data-state", "planning");
        setBlueState("PLANNING…");
        sendWs("request_blue_patch");
    }, 2800);
}
function handleBlueTeamPatch(msg) {
    hardenState = "patching";
    setHardenStep("analysis", "done");
    const fitLine = msg.basis && msg.coefficients && msg.intercept != null
        ? `### Fitted virtual sensor\n` +
            `- **Substituting:** ${msg.target}\n` +
            `- **Predictors:** ${msg.basis.join(", ")}\n` +
            `- **β₀ (intercept):** ${msg.intercept.toFixed(5)}\n` +
            msg.basis.map((b, i) => `- **β${i + 1} (${b}):** ${msg.coefficients[i].toFixed(5)}`).join("\n") +
            (msg.r2 != null ? `\n- **R²:** ${msg.r2.toFixed(3)}` : "") +
            "\n"
        : "";
    const body = composeMd(`${fitLine}\n${msg.prose}`, msg.code, msg.lang || "cpp");
    setBlueState(msg.used_fallback ? "PATCH (FALLBACK)" : "PATCH READY", body);
    els.btnBlueAction.textContent = "Applying patch…";
    els.btnBlueAction.disabled = true;
    // Auto-advance into the patch-apply stage.
    setTimeout(() => {
        if (hardenState !== "patching") return;
        setHardenStep("patch", "active");
        sendWs("apply_patch");
    }, 3000);
}
function handleHardenPatchApplied(_msg) {
    hardenState = "patched";
    setHardenStep("patch", "done");
    if (sceneApi && activeAttackPart)
        sceneApi.setSensorFailure(activeAttackPart, false);
    activeAttackPart = null;
    setBlueState("PATCHED");
    els.btnBlueAction.textContent = "Patch active";
    els.btnBlueAction.disabled = true;
    els.btnBlueAction.setAttribute("data-state", "patched");
    setSystemStatus("patched");
    setRedState("NEUTRALIZED");
    els.redPanel.setAttribute("data-state", "patched");
    incidentActive = false;
    currentCompromisedSensor = null;
    applyCompromiseHighlight(false);
}
function handleHardenExited() {
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
    }
    else if (hardenState === "planned") {
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
    }
    else if (hardenState === "patching") {
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
    incidentActive = false;
    currentCompromisedSensor = null;
    applyCompromiseHighlight(false);
    void postJSON("/api/simulate/clear");
});
// ── Clock ─────────────────────────────────────────────────────────────────
setInterval(() => {
    els.clock.textContent = new Date().toISOString().slice(11, 19);
}, 1000);
// ── Boot ──────────────────────────────────────────────────────────────────
renderDetail(null);
refreshAllAgentFeeds();
connect();
// ── Digital twin (Three.js) ───────────────────────────────────────────────
const twinCanvas = document.getElementById("twinCanvas");
const twinTag = document.getElementById("twinTag");
const twinPanel = document.getElementById("twinPanel");
const twinCollapse = document.getElementById("twinCollapse");
// --- NEW: Variable to hold our scene API ---
let sceneApi = null; // using 'any' to avoid circular type imports, or import { SceneApi } from "./scene3d.js"
if (twinPanel && twinCollapse) {
    twinCollapse.addEventListener("click", () => {
        twinPanel.classList.toggle("collapsed");
    });
}
if (twinCanvas && twinTag) {
    initScene(twinCanvas, (msg) => { twinTag.textContent = msg; })
        .then((api) => { sceneApi = api; }) // --- CHANGED: Store the API ---
        .catch((err) => { twinTag.textContent = `ERR: ${err.message}`; });
}
