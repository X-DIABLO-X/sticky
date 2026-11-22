import type { OverlayDrawEvent, OverlayVizEvent } from "../../types/events";

/**
 * Generate smooth normalized 0..1000 coordinates for a damped sine wave polyline.
 */
function buildDampedSineCoords(
  startX: number,
  endX: number,
  centerY: number,
  amplitude: number,
  cycles: number,
  samples: number
): number[] {
  const coords: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const x = Math.round(startX + (endX - startX) * t);
    const decay = Math.exp(-1.15 * t);
    const y = Math.round(
      centerY - Math.sin(t * Math.PI * 2 * cycles) * amplitude * decay
    );
    coords.push(x, y);
  }
  return coords;
}

/**
 * Gorgeous multi-shape persistent Rough.js whiteboard diagram showcase.
 * All shapes use normalized 0..1000 coordinates and `persistent: true`.
 */
export const DEMO_SKETCH_DRAWINGS: OverlayDrawEvent[] = [
  {
    id: "demo-sketch-title",
    shape: "text",
    coords: [275, 130],
    label: "Sticky Rough.js Whiteboard · y(t) = A · sin(ωt) · e^(-ζt)",
    color: "#34d399",
    persistent: true,
    style: "sketch",
  },
  {
    id: "demo-sketch-box",
    shape: "box",
    coords: [145, 220, 385, 385],
    label: "SoM Grounded Viewport",
    color: "#10b981",
    persistent: true,
    style: "sketch",
  },
  {
    id: "demo-sketch-curve",
    shape: "curve",
    coords: [392, 300, 495, 185, 578, 282],
    label: "Curved Spatial Vector",
    color: "#38bdf8",
    persistent: true,
    style: "sketch",
  },
  {
    id: "demo-sketch-circle",
    shape: "circle",
    coords: [652, 315, 74],
    label: "Neural Target Focus",
    color: "#f59e0b",
    persistent: true,
    style: "sketch",
  },
  {
    id: "demo-sketch-arrow-down",
    shape: "arrow",
    coords: [265, 392, 265, 456],
    color: "#34d399",
    persistent: true,
    style: "sketch",
  },
  {
    id: "demo-sketch-triangle",
    shape: "polygon",
    coords: [195, 588, 335, 588, 265, 466],
    label: "3-Point Pose Mesh",
    color: "#a855f7",
    persistent: true,
    style: "sketch",
  },
  {
    id: "demo-sketch-axis-y",
    shape: "dashed",
    coords: [435, 452, 435, 622],
    color: "#64748b",
    persistent: true,
    style: "sketch",
  },
  {
    id: "demo-sketch-axis-x",
    shape: "dashed",
    coords: [420, 536, 818, 536],
    label: "Equilibrium Axis (y = 0)",
    color: "#94a3b8",
    persistent: true,
    style: "sketch",
  },
  {
    id: "demo-sketch-sine",
    shape: "polyline",
    coords: buildDampedSineCoords(435, 800, 536, 74, 2.25, 28),
    label: "Damped Harmonic Response",
    color: "#2dd4bf",
    persistent: true,
    style: "sketch",
  },
];

/* ============================================================================
 * PRESET 1: INTERACTIVE HTML5 SPRING PHYSICS VS CUBIC-BEZIER EASING
 * ============================================================================ */

const SPRING_VS_EASING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{
    margin:0;padding:0;width:100%;height:100%;overflow:hidden;
    background:#09090b;color:#f4f4f5;
    font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    user-select:none;-webkit-font-smoothing:antialiased;
  }
  .wrap{display:flex;flex-direction:column;width:100%;height:100%;padding:10px 12px;gap:8px;}
  .telemetry{
    display:flex;align-items:center;justify-content:space-between;gap:8px;
    padding:6px 10px;border-radius:10px;
    background:rgba(24,24,27,0.85);border:1px solid rgba(255,255,255,0.08);
    font-size:11px;flex-shrink:0;
  }
  .legend{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
  .pill{display:inline-flex;align-items:center;gap:6px;font-weight:600;color:#e4e4e7;}
  .dot{width:8px;height:8px;border-radius:999px;display:inline-block;}
  .dot.em{background:#10b981;box-shadow:0 0 8px #10b981;}
  .dot.cy{background:#38bdf8;box-shadow:0 0 8px #38bdf8;}
  .regime{
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:10px;padding:2px 8px;border-radius:999px;font-weight:700;
    background:rgba(56,189,248,0.14);color:#7dd3fc;border:1px solid rgba(56,189,248,0.35);
    white-space:nowrap;
  }
  .stage{
    position:relative;flex:1;min-height:160px;border-radius:12px;overflow:hidden;
    background:radial-gradient(ellipse at top,rgba(16,185,129,0.08),rgba(9,9,11,0.98) 70%);
    border:1px solid rgba(255,255,255,0.08);
    cursor:pointer;
  }
  canvas{display:block;width:100%;height:100%;}
  .controls{
    display:flex;align-items:center;gap:12px;flex-shrink:0;
    padding:8px 10px;border-radius:10px;
    background:rgba(24,24,27,0.9);border:1px solid rgba(255,255,255,0.08);
  }
  .ctrl{display:flex;flex-direction:column;gap:3px;flex:1;min-width:110px;}
  .ctrl-head{display:flex;justify-content:space-between;font-size:10.5px;color:#a1a1aa;font-weight:600;}
  .ctrl-val{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#f4f4f5;}
  input[type=range]{
    -webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:999px;
    background:#27272a;outline:none;cursor:pointer;
  }
  input[type=range]::-webkit-slider-thumb{
    -webkit-appearance:none;appearance:none;width:13px;height:13px;border-radius:999px;
    background:#10b981;border:2px solid #ecfdf5;box-shadow:0 0 8px rgba(16,185,129,0.7);
  }
  #damping::-webkit-slider-thumb{background:#38bdf8;box-shadow:0 0 8px rgba(56,189,248,0.7);}
  .replay-btn{
    flex-shrink:0;display:inline-flex;align-items:center;gap:6px;
    padding:7px 12px;border-radius:9px;border:1px solid rgba(16,185,129,0.45);
    background:linear-gradient(135deg,rgba(16,185,129,0.22),rgba(56,189,248,0.18));
    color:#ecfdf5;font-size:11.5px;font-weight:700;cursor:pointer;
    transition:transform 0.12s ease,background 0.15s ease;
  }
  .replay-btn:hover{background:linear-gradient(135deg,rgba(16,185,129,0.34),rgba(56,189,248,0.28));}
  .replay-btn:active{transform:scale(0.96);}
</style>
</head>
<body>
<div class="wrap">
  <div class="telemetry">
    <div class="legend">
      <span class="pill"><span class="dot em"></span>Cubic Ease-In-Out</span>
      <span class="pill"><span class="dot cy"></span>Hooke Spring (F = -kx - cv)</span>
    </div>
    <span class="regime" id="regimeBadge">ζ = 0.41 · Underdamped</span>
  </div>

  <div class="stage" id="stage" title="Click anywhere to replay">
    <canvas id="cv"></canvas>
  </div>

  <div class="controls">
    <label class="ctrl">
      <span class="ctrl-head"><span>Stiffness (k)</span><span class="ctrl-val" id="kVal">180</span></span>
      <input id="stiffness" type="range" min="40" max="420" step="5" value="180" />
    </label>
    <label class="ctrl">
      <span class="ctrl-head"><span>Damping (c)</span><span class="ctrl-val" id="cVal">11</span></span>
      <input id="damping" type="range" min="3" max="42" step="1" value="11" />
    </label>
    <button class="replay-btn" id="replayBtn">↻ Replay</button>
  </div>
</div>

<script>
(function(){
  const stage = document.getElementById("stage");
  const canvas = document.getElementById("cv");
  const ctx = canvas.getContext("2d");
  const kInput = document.getElementById("stiffness");
  const cInput = document.getElementById("damping");
  const kVal = document.getElementById("kVal");
  const cVal = document.getElementById("cVal");
  const regimeBadge = document.getElementById("regimeBadge");
  const replayBtn = document.getElementById("replayBtn");

  let W = 540, H = 260;
  function resize(){
    const rect = stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(240, rect.width);
    H = Math.max(150, rect.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  new ResizeObserver(resize).observe(stage);

  const DURATION_EASE = 0.85;
  const WINDOW_SEC = 2.0;
  const MASS = 1.0;

  let stiffness = Number(kInput.value);
  let damping = Number(cInput.value);
  let simTime = 0;
  let spring = { x: 0, v: 0 };
  let easeVal = 0;
  let historyEase = [];
  let historySpring = [];
  let lastNow = performance.now();

  function easeInOutCubic(t){
    const u = Math.max(0, Math.min(1, t));
    return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  }

  function updateRegime(){
    const zeta = damping / (2 * Math.sqrt(stiffness * MASS));
    const label = zeta < 0.94 ? "Underdamped" : zeta <= 1.08 ? "Critically Damped" : "Overdamped";
    regimeBadge.textContent = "ζ = " + zeta.toFixed(2) + " · " + label;
    if (zeta < 0.94) {
      regimeBadge.style.color = "#7dd3fc";
      regimeBadge.style.borderColor = "rgba(56,189,248,0.4)";
      regimeBadge.style.background = "rgba(56,189,248,0.14)";
    } else if (zeta <= 1.08) {
      regimeBadge.style.color = "#6ee7b7";
      regimeBadge.style.borderColor = "rgba(16,185,129,0.45)";
      regimeBadge.style.background = "rgba(16,185,129,0.16)";
    } else {
      regimeBadge.style.color = "#fcd34d";
      regimeBadge.style.borderColor = "rgba(245,158,11,0.4)";
      regimeBadge.style.background = "rgba(245,158,11,0.14)";
    }
  }

  function resetSim(){
    simTime = 0;
    spring = { x: 0, v: 0 };
    easeVal = 0;
    historyEase = [{ t: 0, x: 0 }];
    historySpring = [{ t: 0, x: 0 }];
    lastNow = performance.now();
    updateRegime();
  }

  kInput.addEventListener("input", () => {
    stiffness = Number(kInput.value);
    kVal.textContent = String(stiffness);
    resetSim();
  });
  cInput.addEventListener("input", () => {
    damping = Number(cInput.value);
    cVal.textContent = String(damping);
    resetSim();
  });
  replayBtn.addEventListener("click", resetSim);
  stage.addEventListener("click", resetSim);

  function drawCoil(x1, x2, y, coils, amp){
    const dist = x2 - x1;
    if (Math.abs(dist) < 12) return;
    ctx.save();
    ctx.strokeStyle = "rgba(56,189,248,0.55)";
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x1, y);
    const lead = 10;
    const body = Math.max(4, dist - lead * 2);
    ctx.lineTo(x1 + lead, y);
    for (let i = 0; i <= coils; i++) {
      const f = i / coils;
      const px = x1 + lead + f * body;
      const py = y + (i === 0 || i === coils ? 0 : (i % 2 === 0 ? -amp : amp));
      ctx.lineTo(px, py);
    }
    ctx.lineTo(x2, y);
    ctx.stroke();
    ctx.restore();
  }

  function drawOrb(x, y, color, glow, valueText){
    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = 18;
    const g = ctx.createRadialGradient(x - 3, y - 3, 1, x, y, 12);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.35, color);
    g.addColorStop(1, glow);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, 10.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.font = "700 10px ui-monospace,SFMono-Regular,Menlo,monospace";
    ctx.fillStyle = "#e4e4e7";
    ctx.textAlign = "center";
    ctx.fillText(valueText, x, y - 15);
    ctx.restore();
  }

  function tick(now){
    requestAnimationFrame(tick);
    const dt = Math.min((now - lastNow) / 1000, 0.04);
    lastNow = now;

    if (simTime < WINDOW_SEC) {
      const steps = 4;
      const subDt = dt / steps;
      for (let s = 0; s < steps; s++) {
        simTime = Math.min(WINDOW_SEC, simTime + subDt);
        const f = -stiffness * (spring.x - 1) - damping * spring.v;
        spring.v += (f / MASS) * subDt;
        spring.x += spring.v * subDt;
      }
      easeVal = easeInOutCubic(simTime / DURATION_EASE);
      historyEase.push({ t: simTime, x: easeVal });
      historySpring.push({ t: simTime, x: spring.x });
    }

    ctx.clearRect(0, 0, W, H);

    // Layout split: Upper 44% racing tracks, Lower 56% displacement curve graph
    const splitY = Math.round(H * 0.44);
    const trackLeft = 58;
    const trackRight = W - 64;
    const trackSpan = Math.max(80, trackRight - trackLeft);
    const yEase = Math.round(splitY * 0.36);
    const ySpring = Math.round(splitY * 0.78);

    // Start (0.0) & Target (1.0) guide rails
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(trackLeft, 12);
    ctx.lineTo(trackLeft, splitY - 10);
    ctx.stroke();

    ctx.strokeStyle = "rgba(16,185,129,0.45)";
    ctx.beginPath();
    ctx.moveTo(trackRight, 12);
    ctx.lineTo(trackRight, splitY - 10);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = "600 9.5px ui-monospace,SFMono-Regular,Menlo,monospace";
    ctx.fillStyle = "#71717a";
    ctx.textAlign = "center";
    ctx.fillText("START", trackLeft, 11);
    ctx.fillStyle = "#34d399";
    ctx.fillText("TARGET 1.0", trackRight, 11);

    // Track lines
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(trackLeft, yEase);
    ctx.lineTo(W - 18, yEase);
    ctx.moveTo(trackLeft, ySpring);
    ctx.lineTo(W - 18, ySpring);
    ctx.stroke();

    // Track row labels
    ctx.textAlign = "left";
    ctx.fillStyle = "#34d399";
    ctx.font = "700 10px Inter,system-ui,sans-serif";
    ctx.fillText("EASE", 12, yEase + 3);
    ctx.fillStyle = "#38bdf8";
    ctx.fillText("SPRING", 12, ySpring + 3);
    ctx.restore();

    // Ease progress bar + orb
    const orbEaseX = trackLeft + easeVal * trackSpan;
    ctx.save();
    const gradE = ctx.createLinearGradient(trackLeft, 0, orbEaseX, 0);
    gradE.addColorStop(0, "rgba(16,185,129,0.08)");
    gradE.addColorStop(1, "rgba(16,185,129,0.85)");
    ctx.strokeStyle = gradE;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(trackLeft, yEase);
    ctx.lineTo(orbEaseX, yEase);
    ctx.stroke();
    ctx.restore();
    drawOrb(orbEaseX, yEase, "#34d399", "#10b981", easeVal.toFixed(2));

    // Spring coil + overshoot halo + orb
    const orbSpringX = Math.max(trackLeft - 14, Math.min(W - 16, trackLeft + spring.x * trackSpan));
    drawCoil(trackLeft, orbSpringX - 10, ySpring, 12, 5.5);
    if (spring.x > 1.02) {
      ctx.save();
      ctx.strokeStyle = "rgba(56,189,248,0.45)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(orbSpringX, ySpring, 15 + Math.min(6, (spring.x - 1) * 18), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    drawOrb(orbSpringX, ySpring, "#7dd3fc", "#0284c7", spring.x.toFixed(2));

    // Divider line
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(12, splitY);
    ctx.lineTo(W - 12, splitY);
    ctx.stroke();
    ctx.restore();

    // Live Displacement Curve Graph x(t) vs t
    const gL = 46, gR = W - 18, gT = splitY + 18, gB = H - 22;
    const gW = Math.max(60, gR - gL);
    const gH = Math.max(50, gB - gT);
    const yMin = -0.1, yMax = 1.55;
    const gx = (t) => gL + (t / WINDOW_SEC) * gW;
    const gy = (val) => gB - ((val - yMin) / (yMax - yMin)) * gH;

    // Graph grid & Y ticks
    ctx.save();
    ctx.font = "500 9.5px ui-monospace,SFMono-Regular,Menlo,monospace";
    [0, 0.5, 1.0, 1.5].forEach((tickVal) => {
      const py = gy(tickVal);
      ctx.strokeStyle = tickVal === 1.0 ? "rgba(16,185,129,0.38)" : "rgba(255,255,255,0.065)";
      ctx.setLineDash(tickVal === 1.0 ? [5, 4] : [2, 4]);
      ctx.beginPath();
      ctx.moveTo(gL, py);
      ctx.lineTo(gR, py);
      ctx.stroke();
      ctx.fillStyle = tickVal === 1.0 ? "#34d399" : "#71717a";
      ctx.textAlign = "right";
      ctx.fillText(tickVal.toFixed(1), gL - 6, py + 3);
    });
    ctx.setLineDash([]);

    // X axis labels
    ctx.fillStyle = "#71717a";
    ctx.textAlign = "center";
    [0, 0.5, 1.0, 1.5, 2.0].forEach((sec) => {
      ctx.fillText(sec.toFixed(1) + "s", gx(sec), gB + 13);
    });

    // Graph title tag
    ctx.textAlign = "left";
    ctx.fillStyle = "#a1a1aa";
    ctx.font = "600 10px Inter,system-ui,sans-serif";
    ctx.fillText("LIVE DISPLACEMENT CURVE x(t)", gL + 4, gT - 5);
    ctx.restore();

    function plotSeries(arr, color, glow){
      if (arr.length < 2) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2;
      ctx.lineJoin = "round";
      ctx.shadowColor = glow;
      ctx.shadowBlur = 9;
      ctx.beginPath();
      ctx.moveTo(gx(arr[0].t), gy(arr[0].x));
      for (let i = 1; i < arr.length; i++) {
        ctx.lineTo(gx(arr[i].t), gy(arr[i].x));
      }
      ctx.stroke();
      const last = arr[arr.length - 1];
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(gx(last.t), gy(last.x), 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    plotSeries(historyEase, "#10b981", "rgba(16,185,129,0.75)");
    plotSeries(historySpring, "#38bdf8", "rgba(56,189,248,0.85)");
  }

  resetSim();
  requestAnimationFrame(tick);
})();
</script>
</body>
</html>`;

/* ============================================================================
 * PRESET 2: THREE.JS 3D SUBDIVISION & MESH TOPOLOGY SCENE
 * ============================================================================ */

const THREE_SUBDIV_CUBE_JS = `
camera.position.set(0, 2.15, 6.2);
camera.lookAt(0, 0.1, 0);

// 1. Studio floor accent rings over the stage grid
const floorRing = new THREE.Mesh(
  new THREE.RingGeometry(2.55, 2.66, 64),
  new THREE.MeshBasicMaterial({
    color: 0x10b981,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.35
  })
);
floorRing.rotation.x = -Math.PI / 2;
floorRing.position.y = -1.56;
group.add(floorRing);

// 2. Left Object: Base Control Cage Cube + Glowing Emerald Wireframe + Corner Vertices
const leftAssembly = new THREE.Group();
leftAssembly.position.set(-1.62, 0.12, 0);
group.add(leftAssembly);

const cubeGeo = new THREE.BoxGeometry(1.48, 1.48, 1.48, 2, 2, 2);
const cubeFill = new THREE.Mesh(
  cubeGeo,
  new THREE.MeshStandardMaterial({
    color: 0x064e3b,
    emissive: 0x059669,
    emissiveIntensity: 0.25,
    roughness: 0.28,
    metalness: 0.72,
    transparent: true,
    opacity: 0.62
  })
);
leftAssembly.add(cubeFill);

const cubeWire = new THREE.Mesh(
  new THREE.BoxGeometry(1.505, 1.505, 1.505, 2, 2, 2),
  new THREE.MeshBasicMaterial({
    color: 0x34d399,
    wireframe: true,
    transparent: true,
    opacity: 0.9
  })
);
leftAssembly.add(cubeWire);

const innerCube = new THREE.Mesh(
  new THREE.BoxGeometry(0.62, 0.62, 0.62),
  new THREE.MeshStandardMaterial({
    color: 0x10b981,
    emissive: 0x34d399,
    emissiveIntensity: 0.85,
    roughness: 0.15,
    metalness: 0.85
  })
);
leftAssembly.add(innerCube);

// 8 glowing control-cage corner vertices
const cornerGeo = new THREE.SphereGeometry(0.068, 14, 14);
const cornerMat = new THREE.MeshBasicMaterial({ color: 0xa7f3d0 });
[-0.75, 0.75].forEach((x) => {
  [-0.75, 0.75].forEach((y) => {
    [-0.75, 0.75].forEach((z) => {
      const v = new THREE.Mesh(cornerGeo, cornerMat);
      v.position.set(x, y, z);
      leftAssembly.add(v);
    });
  });
});

// 3. Right Object: Smooth Subdivided Icosahedron Mesh + Geodesic Topology Shell
const rightAssembly = new THREE.Group();
rightAssembly.position.set(1.62, 0.12, 0);
group.add(rightAssembly);

const smoothMat = new THREE.MeshStandardMaterial({
  color: 0x0ea5e9,
  emissive: 0x065f46,
  emissiveIntensity: 0.48,
  roughness: 0.18,
  metalness: 0.82
});
const smoothMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1.04, 2), smoothMat);
rightAssembly.add(smoothMesh);

const geoShell = new THREE.Mesh(
  new THREE.IcosahedronGeometry(1.065, 2),
  new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    wireframe: true,
    transparent: true,
    opacity: 0.42
  })
);
rightAssembly.add(geoShell);

// 4. Orbiting Luminous Rings + Photon Satellites
const ring1 = new THREE.Mesh(
  new THREE.TorusGeometry(2.55, 0.022, 16, 96),
  new THREE.MeshBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.65 })
);
ring1.rotation.x = Math.PI * 0.42;
ring1.rotation.y = 0.25;
group.add(ring1);

const ring2 = new THREE.Mesh(
  new THREE.TorusGeometry(2.15, 0.018, 16, 96),
  new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.52 })
);
ring2.rotation.x = -Math.PI * 0.36;
ring2.rotation.z = 0.35;
group.add(ring2);

const photon1 = new THREE.Mesh(
  new THREE.SphereGeometry(0.085, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0x6ee7b7 })
);
const photon2 = new THREE.Mesh(
  new THREE.SphereGeometry(0.075, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0x7dd3fc })
);
ring1.add(photon1);
ring2.add(photon2);

// 5. Morph Particle Stream connecting Cage -> Subdivided Mesh
const particleCount = 24;
const pPositions = new Float32Array(particleCount * 3);
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute("position", new THREE.BufferAttribute(pPositions, 3));
const pMat = new THREE.PointsMaterial({
  color: 0x34d399,
  size: 0.09,
  transparent: true,
  opacity: 0.85
});
const bridgeParticles = new THREE.Points(pGeo, pMat);
group.add(bridgeParticles);

onFrame((t) => {
  // Gentle breathing & counter-rotation
  const breath = Math.sin(t * 1.45);
  leftAssembly.position.y = 0.14 + breath * 0.12;
  leftAssembly.rotation.y = t * 0.45;
  leftAssembly.rotation.x = Math.sin(t * 0.6) * 0.2;
  innerCube.rotation.y = -t * 1.1;
  innerCube.rotation.z = t * 0.85;

  rightAssembly.position.y = 0.14 - breath * 0.12;
  rightAssembly.rotation.y = -t * 0.48;
  rightAssembly.rotation.z = Math.cos(t * 0.55) * 0.16;
  const s = 1 + Math.sin(t * 2.1) * 0.025;
  rightAssembly.scale.set(s, s, s);
  smoothMat.emissiveIntensity = 0.42 + Math.sin(t * 2.2) * 0.16;

  // Orbit photons along rings
  ring1.rotation.z = t * 0.25;
  ring2.rotation.y = -t * 0.32;
  photon1.position.set(Math.cos(t * 1.35) * 2.55, Math.sin(t * 1.35) * 2.55, 0);
  photon2.position.set(Math.cos(-t * 1.65) * 2.15, Math.sin(-t * 1.65) * 2.15, 0);

  // Flowing subdivision bridge particles
  const posAttr = pGeo.getAttribute("position");
  for (let i = 0; i < particleCount; i++) {
    const phase = ((i / particleCount) + t * 0.28) % 1;
    const x = -0.82 + phase * 1.64;
    const y = 0.14 + Math.sin(phase * Math.PI) * 0.36 + Math.sin(t * 3 + i) * 0.04;
    const z = Math.cos(phase * Math.PI * 2 + t * 2) * 0.16;
    posAttr.setXYZ(i, x, y, z);
  }
  posAttr.needsUpdate = true;
});
`.trim();

/* ============================================================================
 * PRESET 3: MERMAID ARCHITECTURE FLOWCHART
 * ============================================================================ */

const MERMAID_FLOW_CODE = `flowchart LR
  A["Voice PTT<br/>Ctrl+Space · VAD"] --> B["Screen Capture<br/>WDA · Zero-Copy"]
  B --> C["WinRT OCR<br/>+ CV Icon Det."]
  C --> D["SoM #ID Grounded<br/>Vision LLM"]
  D --> E["Rough.js<br/>Whiteboard"]
  D --> F["Live Viz Stage<br/>HTML · 3D · Chart"]
  D --> G["Piper TTS<br/>Streaming Voice"]

  classDef emerald fill:#064e3b,stroke:#10b981,stroke-width:2px,color:#ecfdf5;
  classDef cyan fill:#083344,stroke:#38bdf8,stroke-width:2px,color:#e0f2fe;
  classDef amber fill:#451a03,stroke:#f59e0b,stroke-width:2px,color:#fef3c7;

  class A,E,F emerald;
  class B,C,D cyan;
  class G amber;`;

/* ============================================================================
 * PRESET 4: INTERACTIVE CHART TELEMETRY SPEC
 * ============================================================================ */

const INTERACTIVE_CHART_JSON = JSON.stringify(
  {
    type: "line",
    subtitle: "Normalized displacement x(t) · Target = 1.00 (Hover for exact telemetry)",
    xLabel: "Elapsed Time",
    yLabel: "Displacement x(t)",
    labels: [
      "0ms",
      "80ms",
      "160ms",
      "240ms",
      "320ms",
      "400ms",
      "480ms",
      "560ms",
      "640ms",
      "720ms",
      "800ms",
      "880ms",
      "960ms",
      "1040ms",
      "1120ms",
      "1200ms",
    ],
    datasets: [
      {
        label: "Cubic Ease-In-Out",
        color: "#10b981",
        data: [
          0.0, 0.02, 0.08, 0.19, 0.35, 0.54, 0.72, 0.86, 0.94, 0.98, 1.0, 1.0,
          1.0, 1.0, 1.0, 1.0,
        ],
      },
      {
        label: "Damped Spring (k=180, c=11)",
        color: "#38bdf8",
        data: [
          0.0, 0.16, 0.48, 0.86, 1.14, 1.22, 1.14, 1.01, 0.94, 0.96, 1.01, 1.02,
          1.0, 0.99, 1.0, 1.0,
        ],
      },
    ],
  },
  null,
  2
);

/**
 * Curated HeyClicky-grade interactive Live Visualization Showcase presets.
 */
export const VIZ_PRESETS: Record<string, OverlayVizEvent> = {
  spring_vs_easing: {
    id: "preset-spring-vs-easing",
    kind: "html",
    title: "Ease-In-Out vs Spring Physics",
    code: SPRING_VS_EASING_HTML,
    width: 580,
    height: 420,
  },
  three_subdiv_cube: {
    id: "preset-three-subdiv-cube",
    kind: "three",
    title: "Interactive 3D Subdivision & Mesh Topology",
    code: THREE_SUBDIV_CUBE_JS,
    width: 540,
    height: 420,
  },
  mermaid_flow: {
    id: "preset-mermaid-flow",
    kind: "mermaid",
    title: "Sticky Real-Time Visual Grounding Architecture",
    code: MERMAID_FLOW_CODE,
    width: 580,
    height: 400,
  },
  interactive_chart: {
    id: "preset-interactive-chart",
    kind: "chart",
    title: "Easing Curve & Spring Response Telemetry",
    code: INTERACTIVE_CHART_JSON,
    width: 560,
    height: 390,
  },
};
