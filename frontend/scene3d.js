// Digital twin — Three.js scene wrapping the Arduino UNO, Flipper Zero, LCD,
// and procedurally generated breadboard / sensors / motor / wires.
//
// World units are centimeters. Relative scale is approximately correct across
// the loaded GLBs and the procedural parts.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
const GLBS = {
    uno: {
        url: "/models/arduino_uno_r3_elegoo.glb",
        longestDimCm: 6.86,
        position: [-12, 0, 0],
        rotation: [0, Math.PI * 0.5, 0],
    },
    flipper: {
        url: "/models/flipper_zero.glb",
        longestDimCm: 10,
        position: [13, 0, 0],
        rotation: [0, -Math.PI * 0.5, 0],
    },
    lcd: {
        url: "/models/162__lcd_display.glb",
        longestDimCm: 8,
        position: [0, 0, -8],
        rotation: [0, Math.PI, 0],
    },
};
// ── Procedural parts ───────────────────────────────────────────────────────
function makeBreadboard() {
    const g = new THREE.Group();
    const W = 16.5, D = 5.5, H = 0.85;
    // body
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), new THREE.MeshStandardMaterial({ color: 0xe8e6dc, roughness: 0.7, metalness: 0.05 }));
    body.position.y = H / 2;
    g.add(body);
    // hole-pattern top texture
    const c = document.createElement("canvas");
    c.width = 1024;
    c.height = 256;
    const ctx = c.getContext("2d");
    if (ctx) {
        ctx.fillStyle = "#ece9dd";
        ctx.fillRect(0, 0, c.width, c.height);
        // bus / divider lines
        ctx.fillStyle = "#bcb8a8";
        ctx.fillRect(0, 10, c.width, 1);
        ctx.fillRect(0, 246, c.width, 1);
        // central gap (shaded)
        ctx.fillStyle = "#cfcbb9";
        ctx.fillRect(0, 122, c.width, 12);
        // hole grid
        ctx.fillStyle = "#1a1f24";
        const nx = 60, ny = 14;
        const padX = 8, padY = 8;
        const sx = (c.width - padX * 2) / (nx - 1);
        const sy = (c.height - padY * 2) / (ny - 1);
        for (let iy = 0; iy < ny; iy++) {
            for (let ix = 0; ix < nx; ix++) {
                const x = padX + ix * sx;
                const y = padY + iy * sy;
                ctx.beginPath();
                ctx.arc(x, y, 1.6, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const top = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, metalness: 0.04 }));
    top.rotation.x = -Math.PI / 2;
    top.position.y = H + 0.001;
    g.add(top);
    return g;
}
function makeDHT11() {
    const g = new THREE.Group();
    // PCB
    const pcbMat = new THREE.MeshStandardMaterial({ color: 0x1f6fb2, roughness: 0.55, metalness: 0.1 });
    const pcb = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.18, 1.2), pcbMat);
    pcb.position.y = 0.5;
    g.add(pcb);
    // Sensor cap material (same one used for the cylindrical body)
    const casingMat = new THREE.MeshStandardMaterial({ color: 0x2a89d8, roughness: 0.65, metalness: 0.1 });
    // Expose every body material that should glow on failure
    g.userData.glowMats = [pcbMat, casingMat];
    // sensor body (perforated blue cap)
    const sensor = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.1, 24), casingMat);
    sensor.position.set(-0.3, 1.15, 0);
    g.add(sensor);
    // perforations on the cap (just darker dots via decal-like spheres)
    const holeMat = new THREE.MeshBasicMaterial({ color: 0x05080d });
    for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), holeMat);
        dot.position.set(-0.3 + Math.cos(a) * 0.42, 1.4, Math.sin(a) * 0.42);
        g.add(dot);
    }
    // pins
    const pinMat = new THREE.MeshStandardMaterial({ color: 0xc8c8c8, roughness: 0.4, metalness: 0.85 });
    for (let i = 0; i < 3; i++) {
        const pin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.1), pinMat);
        pin.position.set(-0.6 + i * 0.6, 0.25, 0.5);
        g.add(pin);
    }
    return g;
}
function makePot() {
    const g = new THREE.Group();
    const casingMat = new THREE.MeshStandardMaterial({ color: 0x1c4ea8, roughness: 0.5, metalness: 0.15 });
    const knobMat = new THREE.MeshStandardMaterial({ color: 0x0d1219, roughness: 0.6, metalness: 0.2 });
    // Expose every visible body material that should glow on failure
    g.userData.glowMats = [casingMat, knobMat];
    // body (blue cube)
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.95, 1.5), casingMat);
    body.position.y = 0.475;
    g.add(body);
    // shaft
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.6, 16), new THREE.MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.4, metalness: 0.9 }));
    shaft.position.y = 0.95 + 0.3;
    g.add(shaft);
    // knob
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.45, 0.3, 24), knobMat);
    knob.position.y = 0.95 + 0.6 + 0.15;
    g.add(knob);
    // pointer mark on knob
    const mark = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.04, 0.08), new THREE.MeshBasicMaterial({ color: 0xff3e5f }));
    mark.position.set(0.15, 0.95 + 0.6 + 0.31, 0);
    g.add(mark);
    // pins
    const pinMat = new THREE.MeshStandardMaterial({ color: 0xc8c8c8, roughness: 0.4, metalness: 0.85 });
    for (let i = -1; i <= 1; i++) {
        const pin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.4, 0.08), pinMat);
        pin.position.set(i * 0.5, 0.2, 0.65);
        g.add(pin);
    }
    return g;
}
// Generic 3-pin breakout PCB used as the base for the new sensor modules.
function makeBreakoutPcb(width, depth, pcbColor, pinCount) {
    const g = new THREE.Group();
    const pcbMat = new THREE.MeshStandardMaterial({
        color: pcbColor, roughness: 0.55, metalness: 0.1,
    });
    const pcb = new THREE.Mesh(new THREE.BoxGeometry(width, 0.18, depth), pcbMat);
    pcb.position.y = 0.5;
    g.add(pcb);
    // pin header on the front edge (z = +depth/2)
    const pinMat = new THREE.MeshStandardMaterial({ color: 0xc8c8c8, roughness: 0.4, metalness: 0.85 });
    const startX = -((pinCount - 1) * 0.3) / 2;
    for (let i = 0; i < pinCount; i++) {
        const pin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.08), pinMat);
        pin.position.set(startX + i * 0.3, 0.25, depth / 2 - 0.1);
        g.add(pin);
    }
    return { group: g, pcbMat };
}
// Pressure sensor — small green PCB with a metal port dome (BMP/MPX style).
function makePressure() {
    const { group: g, pcbMat } = makeBreakoutPcb(1.6, 1.2, 0x1f7a3a, 4);
    const portMat = new THREE.MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.35, metalness: 0.9 });
    const chipMat = new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.7, metalness: 0.2 });
    g.userData.glowMats = [pcbMat];
    // metallic port dome
    const port = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.55, 24), portMat);
    port.position.set(-0.25, 0.875, 0);
    g.add(port);
    const portCap = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.18, 0.18, 24), portMat);
    portCap.position.set(-0.25, 1.24, 0);
    g.add(portCap);
    // tiny intake nipple on top
    const nipple = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.18, 12), portMat);
    nipple.position.set(-0.25, 1.42, 0);
    g.add(nipple);
    // companion IC chip
    const chip = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.12, 0.45), chipMat);
    chip.position.set(0.45, 0.66, 0);
    g.add(chip);
    return g;
}
// Current sensor — red Hall-effect breakout (ACS712 style) with SOIC + screw terminals.
function makeCurrent() {
    const { group: g, pcbMat } = makeBreakoutPcb(1.8, 1.4, 0xa5252b, 4);
    const chipMat = new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.7, metalness: 0.2 });
    const terminalMat = new THREE.MeshStandardMaterial({ color: 0x4a90c2, roughness: 0.45, metalness: 0.6 });
    const screwMat = new THREE.MeshStandardMaterial({ color: 0xd0d0d0, roughness: 0.3, metalness: 0.95 });
    g.userData.glowMats = [pcbMat];
    // SOIC chip
    const chip = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.14, 0.4), chipMat);
    chip.position.set(0.15, 0.67, 0);
    g.add(chip);
    // two screw terminals on the back edge for the current path
    for (let i = 0; i < 2; i++) {
        const term = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.35, 0.4), terminalMat);
        term.position.set(-0.55 + i * 0.55, 0.77, -0.45);
        g.add(term);
        const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.06, 12), screwMat);
        screw.position.set(-0.55 + i * 0.55, 0.97, -0.45);
        g.add(screw);
    }
    return g;
}
function makeMotorFan() {
    const g = new THREE.Group();
    // motor body (silver cylinder lying on its side along Z)
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 2.0, 24), new THREE.MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.45, metalness: 0.85 }));
    body.rotation.x = Math.PI / 2;
    body.position.y = 0.7;
    g.add(body);
    // shaft
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.6, 12), new THREE.MeshStandardMaterial({ color: 0x999999, roughness: 0.3, metalness: 0.95 }));
    shaft.rotation.x = Math.PI / 2;
    shaft.position.set(0, 0.7, 1.3);
    g.add(shaft);
    // fan rotor
    const fan = new THREE.Group();
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.18, 16), new THREE.MeshStandardMaterial({ color: 0x222a32, roughness: 0.6, metalness: 0.3 }));
    hub.rotation.x = Math.PI / 2;
    fan.add(hub);
    const bladeMat = new THREE.MeshStandardMaterial({
        color: 0xf2c87a, roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide, transparent: true, opacity: 0.95,
    });
    const bladeShape = new THREE.Shape();
    bladeShape.moveTo(0, 0);
    bladeShape.bezierCurveTo(0.2, 0.4, 1.6, 0.5, 2.2, 0.0);
    bladeShape.bezierCurveTo(1.6, -0.3, 0.4, -0.25, 0, 0);
    for (let i = 0; i < 3; i++) {
        const blade = new THREE.Mesh(new THREE.ShapeGeometry(bladeShape), bladeMat);
        blade.rotation.z = (i / 3) * Math.PI * 2;
        fan.add(blade);
    }
    fan.position.set(0, 0.7, 1.65);
    g.add(fan);
    return { group: g, fan };
}
function makeWire(start, end, color, sag = 1.5) {
    // 1. Add "lift" so the wire goes straight up out of the pin/breadboard first
    const lift = 0.5;
    const startUp = new THREE.Vector3(start.x, start.y + lift, start.z);
    const endUp = new THREE.Vector3(end.x, end.y + lift, end.z);
    // 2. Find the midpoint between the elevated start and end points
    const mid = new THREE.Vector3().addVectors(startUp, endUp).multiplyScalar(0.5);
    // 3. Arch UPWARDS instead of downwards
    mid.y += sag;
    // 4. Add organic non-uniformity 
    const dist = start.distanceTo(end);
    const pseudoRandomX = Math.sin(start.x * 12.9898 + end.z * 78.233);
    const pseudoRandomZ = Math.cos(start.z * 12.9898 + end.x * 78.233);
    // Splay the wires outward slightly
    mid.x += pseudoRandomX * dist * 0.15;
    mid.z += pseudoRandomZ * dist * 0.15;
    // 5. Add transitional control points to "fatten" the arch
    const c1 = new THREE.Vector3().lerpVectors(startUp, mid, 0.5);
    c1.y += sag * 0.1;
    const c2 = new THREE.Vector3().lerpVectors(mid, endUp, 0.5);
    c2.y += sag * 0.1;
    // 6. Build the curve passing through our new control points
    const curve = new THREE.CatmullRomCurve3([
        start, // Pin entry
        startUp, // Vertical lift
        c1, // Arch transition
        mid, // Peak of the arch (offset randomly)
        c2, // Arch transition
        endUp, // Vertical drop
        end // Pin exit
    ]);
    curve.curveType = 'catmullrom';
    curve.tension = 0.6;
    const geo = new THREE.TubeGeometry(curve, 80, 0.08, 12, false);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.2 });
    return new THREE.Mesh(geo, mat);
}
// ── Init ───────────────────────────────────────────────────────────────────
export async function initScene(canvas, onProgress) {
    const wrap = canvas.parentElement;
    const width = wrap?.clientWidth ?? 800;
    const height = wrap?.clientHeight ?? 480;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    const scene = new THREE.Scene();
    scene.background = null;
    const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 500);
    camera.position.set(18, 18, 26);
    // lighting — soft daylight, no neon rim
    scene.add(new THREE.HemisphereLight(0xffffff, 0xddd9d0, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(20, 30, 15);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.4);
    fill.position.set(-15, 12, -10);
    scene.add(fill);
    const bottom = new THREE.DirectionalLight(0xfff2e0, 0.2);
    bottom.position.set(0, -8, 18);
    scene.add(bottom);
    // ground — warm neutral that complements the GLBs
    const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.MeshStandardMaterial({
        color: 0xf0eee8, roughness: 0.9, metalness: 0,
        transparent: true, opacity: 0.9,
    }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    scene.add(ground);
    // All model parts go inside this group so we can lift the entire device off
    // the ground in one place. Without the lift, the motor's fan blades clip
    // through the ground plane (blade radius ~2.2, motor sits at y≈0).
    const MODEL_LIFT = 1.7;
    const modelRoot = new THREE.Group();
    modelRoot.position.y = MODEL_LIFT;
    scene.add(modelRoot);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 8;
    controls.maxDistance = 80;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.target.set(0, 1 + MODEL_LIFT, 0);
    const parts = {};
    // ── Procedural parts ─────────────────────────────────────────────────────
    const breadboard = makeBreadboard();
    modelRoot.add(breadboard);
    parts.breadboard = breadboard;
    // Pulsing halo disc beneath an anomaly-able part — much more visible at
    // orbit distance than emissive on a small mesh.
    function makeHalo() {
        const halo = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.8, 48), new THREE.MeshBasicMaterial({
            color: 0xff3030,
            transparent: true,
            opacity: 0,
            side: THREE.DoubleSide,
            depthWrite: false,
        }));
        halo.rotation.x = -Math.PI / 2;
        halo.position.y = 0.89; // just above breadboard top
        halo.renderOrder = 999;
        return halo;
    }
    function makeFailLight() {
        const l = new THREE.PointLight(0xff2020, 0, 12, 1.6);
        return l;
    }
    const dht = makeDHT11();
    dht.position.set(-5.5, 0.85, 0.6);
    modelRoot.add(dht);
    parts.dht11 = dht;
    const dhtHalo = makeHalo();
    dhtHalo.position.set(-5.5, 0.89, 0.6);
    modelRoot.add(dhtHalo);
    dht.userData.halo = dhtHalo;
    const dhtLight = makeFailLight();
    dhtLight.position.set(-5.5, 2.0, 0.6);
    modelRoot.add(dhtLight);
    dht.userData.failLight = dhtLight;
    const pot = makePot();
    pot.position.set(-1.2, 0.85, 0.6);
    modelRoot.add(pot);
    parts.pot = pot;
    const potHalo = makeHalo();
    potHalo.position.set(-1.2, 0.89, 0.6);
    modelRoot.add(potHalo);
    pot.userData.halo = potHalo;
    const potLight = makeFailLight();
    potLight.position.set(-1.2, 2.4, 0.6);
    modelRoot.add(potLight);
    pot.userData.failLight = potLight;
    const pressure = makePressure();
    pressure.position.set(2.2, 0.85, 0.6);
    modelRoot.add(pressure);
    parts.pressure = pressure;
    const pressureHalo = makeHalo();
    pressureHalo.position.set(2.2, 0.89, 0.6);
    modelRoot.add(pressureHalo);
    pressure.userData.halo = pressureHalo;
    const pressureLight = makeFailLight();
    pressureLight.position.set(2.2, 2.4, 0.6);
    modelRoot.add(pressureLight);
    pressure.userData.failLight = pressureLight;
    const current = makeCurrent();
    current.position.set(5.0, 0.85, 0.6);
    modelRoot.add(current);
    parts.current = current;
    const currentHalo = makeHalo();
    currentHalo.position.set(5.0, 0.89, 0.6);
    modelRoot.add(currentHalo);
    current.userData.halo = currentHalo;
    const currentLight = makeFailLight();
    currentLight.position.set(5.0, 2.4, 0.6);
    modelRoot.add(currentLight);
    current.userData.failLight = currentLight;
    const { group: motorGroup, fan } = makeMotorFan();
    motorGroup.position.set(5.5, 0, 5.5);
    motorGroup.rotation.y = 0;
    modelRoot.add(motorGroup);
    parts.motor = motorGroup;
    parts.fan = fan;
    // ── Load GLBs ────────────────────────────────────────────────────────────
    const loader = new GLTFLoader();
    async function loadGlb(entry, label) {
        onProgress(`LOADING ${label.toUpperCase()}…`);
        const gltf = await loader.loadAsync(entry.url);
        const root = gltf.scene;
        const box = new THREE.Box3().setFromObject(root);
        const size = new THREE.Vector3();
        box.getSize(size);
        const center = new THREE.Vector3();
        box.getCenter(center);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const s = entry.longestDimCm / maxDim;
        root.scale.setScalar(s);
        root.position.sub(center.multiplyScalar(s));
        root.rotation.set(...entry.rotation);
        root.position.add(new THREE.Vector3(...entry.position));
        // sit on ground (modelRoot's local y=0 plane)
        const post = new THREE.Box3().setFromObject(root);
        root.position.y -= post.min.y;
        modelRoot.add(root);
        return root;
    }
    parts.uno = await loadGlb(GLBS.uno, "Arduino");
    parts.flipper = await loadGlb(GLBS.flipper, "Flipper");
    parts.lcd = await loadGlb(GLBS.lcd, "LCD");
    // ── Wire harness ────────────────────────────────────────────────────────
    // Jumper-wire colors from a typical breadboard kit
    const RED = 0xff3030;
    const BLACK = 0x202020;
    const YELLOW = 0xfac02a;
    const GREEN = 0x35c46b;
    const BLUE = 0x2a8df0;
    const WHITE = 0xe8e8e8;
    const ORANGE = 0xff8a3d;
    const PURPLE = 0xa45ce6;
    const GRAY = 0x9aa3ad;
    const BROWN = 0x8a5a3b;
    // Approximate UNO header strip locations (UNO is at -12 X, rotated 90° on Y).
    const unoDigPin = (n) => {
        const t = (n / 13) * 5.3 - 2.5;
        return new THREE.Vector3(-11.0, 1.4, t);
    };
    const unoAnaPin = (n) => {
        const t = (n / 5) * 3.5 - 1.6;
        return new THREE.Vector3(-13.0, 1.4, t);
    };
    // Helper to calculate standard 1602 LCD pin positions
    const lcdPin = (pinNumber) => {
        const pitch = 0.254;
        const yBase = 3.2;
        const zBase = -8.05;
        const startX = 1.9;
        return new THREE.Vector3(startX - ((pinNumber - 1) * pitch), yBase, zBase);
    };
    // Breadboard target: rows on the side facing the UNO
    const bbRow = (x, z) => new THREE.Vector3(x, 0.9, z);
    const specs = [
        // ── Power / ground rails ──
        { from: unoAnaPin(0), to: bbRow(-7.5, 2.6), color: RED, sag: 0.5 },
        { from: unoAnaPin(1), to: bbRow(-7.5, -2.6), color: BLACK, sag: 0.5 },
        { from: bbRow(7.5, 2.6), to: bbRow(-7.5, 2.6), color: RED, sag: 0.15 },
        { from: bbRow(7.5, -2.6), to: bbRow(-7.5, -2.6), color: BLACK, sag: 0.15 },
        // ── DHT11 (D2 + power) ──
        { from: unoDigPin(2), to: bbRow(-5.5, 1.0), color: YELLOW, sag: 0.6 },
        { from: bbRow(-5.5, 2.4), to: bbRow(-5.5, 1.5), color: RED, sag: 0.05 },
        { from: bbRow(-5.5, -2.4), to: bbRow(-5.5, 0.5), color: BLACK, sag: 0.05 },
        // ── Pot (A0 + power) ──
        { from: unoAnaPin(2), to: bbRow(-1.2, 1.0), color: BLUE, sag: 0.7 },
        { from: bbRow(-1.2, 2.4), to: bbRow(-1.2, 1.5), color: RED, sag: 0.05 },
        { from: bbRow(-1.2, -2.4), to: bbRow(-1.2, 0.5), color: BLACK, sag: 0.05 },
        // ── Pressure sensor (A3 + power) ──
        { from: unoAnaPin(3), to: bbRow(2.2, 1.0), color: GREEN, sag: 0.8 },
        { from: bbRow(2.2, 2.4), to: bbRow(2.2, 1.5), color: RED, sag: 0.05 },
        { from: bbRow(2.2, -2.4), to: bbRow(2.2, 0.5), color: BLACK, sag: 0.05 },
        // ── Current sensor (A4 + power) ──
        { from: unoAnaPin(4), to: bbRow(5.0, 1.0), color: PURPLE, sag: 0.85 },
        { from: bbRow(5.0, 2.4), to: bbRow(5.0, 1.5), color: RED, sag: 0.05 },
        { from: bbRow(5.0, -2.4), to: bbRow(5.0, 0.5), color: BLACK, sag: 0.05 },
        // ── LCD bus (LCD at z = -8) ──
        { from: bbRow(7.5, -2.6), to: lcdPin(1), color: BLACK, sag: 1.2 }, // VSS (Pin 1)
        { from: bbRow(7.5, 2.6), to: lcdPin(2), color: RED, sag: 1.2 }, // VDD (Pin 2)
        { from: unoDigPin(4), to: lcdPin(4), color: GREEN, sag: 1.4 }, // RS  (Pin 4)
        { from: unoDigPin(5), to: lcdPin(6), color: WHITE, sag: 1.4 }, // E   (Pin 6)
        { from: unoDigPin(6), to: lcdPin(11), color: ORANGE, sag: 1.4 }, // D4  (Pin 11)
        { from: unoDigPin(10), to: lcdPin(12), color: PURPLE, sag: 1.4 }, // D5  (Pin 12)
        { from: unoDigPin(11), to: lcdPin(13), color: GRAY, sag: 1.4 }, // D6  (Pin 13)
        { from: unoDigPin(12), to: lcdPin(14), color: BROWN, sag: 1.4 }, // D7  (Pin 14)
        // ── Motor (D9 PWM via transistor; 5V supply) ──
        { from: unoDigPin(9), to: new THREE.Vector3(5.5, 1.0, 4.5), color: BLUE, sag: 0.8 },
        { from: bbRow(7.5, 2.6), to: new THREE.Vector3(5.5, 1.2, 4.8), color: RED, sag: 0.7 },
        { from: bbRow(7.5, -2.6), to: new THREE.Vector3(5.5, 0.6, 5.2), color: BLACK, sag: 0.6 },
        // ── Buzzer + LED ──
        { from: unoDigPin(8), to: bbRow(3.5, 0.5), color: ORANGE, sag: 0.5 },
        { from: unoDigPin(13), to: bbRow(2.0, 0.5), color: GREEN, sag: 0.5 },
    ];
    const harness = new THREE.Group();
    for (const s of specs) {
        harness.add(makeWire(s.from, s.to, s.color, s.sag ?? 0.5));
    }
    modelRoot.add(harness);
    onProgress("LIVE");
    // ── Resize ──────────────────────────────────────────────────────────────
    function resize() {
        const w = wrap?.clientWidth ?? width;
        const h = wrap?.clientHeight ?? height;
        if (w === 0 || h === 0)
            return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    const ro = new ResizeObserver(resize);
    if (wrap)
        ro.observe(wrap);
    // ── Render loop with spinning fan & pulsing animations ─────────────────
    const failingSensors = new Set();
    // Every sensor that participates in the anomaly-highlight system. Anything
    // listed here is allowed to be passed to setSensorFailure(); the loop below
    // updates its materials / halo / light each frame regardless of which one
    // is currently flagged.
    const ANOMALY_SENSORS = ["dht11", "pot", "pressure", "current"];
    const clock = new THREE.Clock();
    function tick() {
        const dt = clock.getDelta();
        const time = clock.getElapsedTime();
        fan.rotation.z -= dt * 8; // spinning fan
        // 0..1 sine pulse at ~3 Hz
        const pulse01 = 0.5 + 0.5 * Math.sin(time * 6);
        ANOMALY_SENSORS.forEach((id) => {
            const part = parts[id];
            if (!part)
                return;
            const failing = failingSensors.has(id);
            // (1) Emissive glow on every body material — drive both states each
            // frame so we can't leak a stale glow from material defaults
            // (MeshStandardMaterial.emissiveIntensity defaults to 1).
            const mats = part.userData.glowMats ?? [];
            for (const m of mats) {
                if (failing) {
                    m.emissive.setHex(0xff4040);
                    m.emissiveIntensity = 3.5 + pulse01 * 4.5;
                }
                else {
                    m.emissive.setHex(0x000000);
                    m.emissiveIntensity = 0;
                }
            }
            // (2) Ground halo
            const halo = part.userData.halo;
            if (halo) {
                const mat = halo.material;
                if (failing) {
                    mat.opacity = 0.7 + pulse01 * 0.3;
                    const s = 1.3 + pulse01 * 0.7;
                    halo.scale.set(s, s, 1);
                }
                else {
                    mat.opacity = 0;
                    halo.scale.set(1, 1, 1);
                }
            }
            // (3) Point light spilling red onto nearby surfaces
            const light = part.userData.failLight;
            if (light) {
                light.intensity = failing ? 8 + pulse01 * 12 : 0;
            }
        });
        controls.update();
        renderer.render(scene, camera);
        requestAnimationFrame(tick);
    }
    tick();
    return {
        setStatus(label) { onProgress(label); },
        parts,
        setSensorFailure(sensorId, isFailing) {
            if (isFailing) {
                failingSensors.add(sensorId);
            }
            else {
                failingSensors.delete(sensorId);
            }
        }
    };
}
