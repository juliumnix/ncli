const THREE = window.THREE;
const WOOD = 0x8b5a2b;
const METAL = 0x6a7078;
const CLAMP = 0x4a86d4;
const BG = 0x0f0f11;

const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

function sceneSource() {
  try {
    return decodeURIComponent(String(location.hash || "").replace(/^#/, "")).trim() || "ncli3d.desk()";
  } catch {
    return "ncli3d.desk()";
  }
}

function desk() {
  return mountDesk();
}

function box() {
  return mountBox();
}

function mountWorld() {
  const host = document.getElementById("ncli3d") || document.body;
  host.replaceChildren();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 40);
  const renderer = new THREE.WebGLRenderer({ antialias: !reduced(), alpha: false });
  renderer.setClearColor(BG, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.appendChild(renderer.domElement);
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  const target = new THREE.Vector3(0, 0.2, 0);
  const sph = new THREE.Spherical(2.4, 1.12, 0.78);
  let paused = false;
  let flying = null;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const clock = new THREE.Clock();

  function placeCam() {
    camera.position.setFromSpherical(sph).add(target);
    camera.lookAt(target);
  }

  function captureSph(pos, look) {
    target.copy(look);
    sph.setFromVector3(pos.clone().sub(target));
    sph.makeSafe();
    placeCam();
  }

  function resize() {
    const w = Math.max(window.innerWidth || 0, host.clientWidth || 0, 64);
    const h = Math.max(window.innerHeight || 0, host.clientHeight || 0, 64);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, true);
  }

  function applyCam(cam, instant) {
    if (instant || reduced()) {
      captureSph(cam.pos, cam.target);
      flying = null;
      return;
    }
    flying = {
      fromPos: camera.position.clone(),
      fromTarget: target.clone(),
      toPos: cam.pos.clone(),
      toTarget: cam.target.clone(),
      t: 0,
      dur: 0.85,
    };
  }

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.focus();
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    sph.theta -= (e.clientX - lastX) * 0.005;
    sph.phi = Math.min(Math.max(sph.phi + (e.clientY - lastY) * 0.005, 0.12), Math.PI - 0.12);
    lastX = e.clientX;
    lastY = e.clientY;
    flying = null;
    placeCam();
  });
  canvas.addEventListener("pointerup", () => {
    dragging = false;
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      const zoom = e.ctrlKey || e.metaKey || document.activeElement === canvas;
      if (!zoom) {
        parent.postMessage({ type: "ncli-3d", op: "wheel", deltaY: e.deltaY, deltaX: e.deltaX }, "*");
        return;
      }
      e.preventDefault();
      sph.radius = Math.min(Math.max(sph.radius + e.deltaY * 0.002, 0.55), 6);
      flying = null;
      placeCam();
    },
    { passive: false },
  );

  function tick() {
    requestAnimationFrame(tick);
    if (paused) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    if (flying) {
      flying.t += dt / flying.dur;
      const u = flying.t >= 1 ? 1 : 1 - (1 - flying.t) ** 3;
      const pos = flying.fromPos.clone().lerp(flying.toPos, u);
      const look = flying.fromTarget.clone().lerp(flying.toTarget, u);
      captureSph(pos, look);
      if (flying.t >= 1) flying = null;
    }
    renderer.render(scene, camera);
  }

  resize();
  new ResizeObserver(resize).observe(host);
  window.addEventListener("resize", resize);
  window.addEventListener("message", (ev) => {
    if (ev.source !== parent) return;
    const d = ev.data;
    if (!d || d.type !== "ncli-3d") return;
    if (d.op === "pause") paused = true;
    if (d.op === "resume") {
      paused = false;
      clock.getDelta();
    }
  });
  placeCam();
  renderer.render(scene, camera);
  tick();

  function announce(kind, buttons) {
    parent.postMessage(
      {
        type: "ncli-3d",
        op: "ready",
        kind,
        buttons,
        engine: canvas.getAttribute("data-engine") || "",
        triangles: renderer.info?.render?.triangles ?? 0,
      },
      "*",
    );
  }

  return { host, scene, camera, renderer, canvas, applyCam, announce };
}

function addLights(scene) {
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  scene.add(new THREE.HemisphereLight(0xd8e2f0, 0x3a3028, 0.85));
  const key = new THREE.DirectionalLight(0xfff4e6, 1.15);
  key.position.set(1.6, 2.4, 1.3);
  scene.add(key);
}

function mountDesk() {
  const world = mountWorld();
  addLights(world.scene);
  const parts = addDesk(world.scene);
  const cameras = {
    whole: { pos: new THREE.Vector3(1.7, 1.25, 1.7), target: new THREE.Vector3(0, 0.2, 0) },
    clamp: { pos: new THREE.Vector3(0.18, 0.48, 0.62), target: new THREE.Vector3(0, 0.34, -0.28) },
    under: { pos: new THREE.Vector3(0.25, -0.7, 0.85), target: new THREE.Vector3(0, 0.08, 0) },
  };
  const ui = paintDeskUi(world.host);
  ui.cams.whole.classList.add("on");
  world.applyCam(cameras.whole, true);
  for (const [id, btn] of Object.entries(ui.cams)) {
    btn.addEventListener("click", () => {
      for (const b of Object.values(ui.cams)) b.classList.remove("on");
      btn.classList.add("on");
      world.applyCam(cameras[id], false);
    });
  }
  for (const [id, btn] of Object.entries(ui.parts)) {
    btn.addEventListener("click", () => {
      parts[id].visible = !parts[id].visible;
      btn.classList.toggle("off", !parts[id].visible);
    });
  }
  world.renderer.render(world.scene, world.camera);
  world.announce("desk", [...world.host.querySelectorAll("button")].map((b) => b.textContent));
  return world;
}

function mountBox() {
  const world = mountWorld();
  addLights(world.scene);
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.7, 0.7),
    new THREE.MeshLambertMaterial({ color: 0xc45c4a }),
  );
  mesh.position.y = 0.2;
  world.scene.add(mesh);
  const hint = document.createElement("div");
  hint.className = "n3-hint";
  hint.textContent = "cubo vermelho";
  world.host.append(hint);
  world.applyCam(
    { pos: new THREE.Vector3(1.4, 1.1, 1.4), target: new THREE.Vector3(0, 0.2, 0) },
    true,
  );
  world.renderer.render(world.scene, world.camera);
  world.announce("box", ["cubo vermelho"]);
  return world;
}

function addDesk(scene) {
  const wood = new THREE.Mesh(
    new THREE.BoxGeometry(1.24, 0.05, 0.72),
    new THREE.MeshLambertMaterial({ color: WOOD }),
  );
  wood.position.y = 0.32;
  wood.name = "wood";
  scene.add(wood);

  const metalMat = new THREE.MeshLambertMaterial({ color: METAL });
  const metal = new THREE.Group();
  metal.name = "metal";
  for (const [x, z] of [
    [-0.52, -0.28],
    [0.52, -0.28],
    [-0.52, 0.28],
    [0.52, 0.28],
  ]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.32, 0.05), metalMat);
    leg.position.set(x, 0.16, z);
    metal.add(leg);
  }
  const rail = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.035, 0.035), metalMat);
  rail.position.set(0, 0.08, 0);
  metal.add(rail);
  scene.add(metal);

  const clampMat = new THREE.MeshLambertMaterial({ color: CLAMP });
  const clamp = new THREE.Group();
  clamp.name = "clamp";
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.025, 0.14), clampMat);
  plate.position.set(0, 0.36, -0.28);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.2, 0.04), clampMat);
  arm.position.set(0, 0.47, -0.28);
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.045, 0.05), clampMat);
  jaw.position.set(0, 0.3, -0.28);
  clamp.add(plate, arm, jaw);
  scene.add(clamp);
  return { wood, metal, clamp };
}

function paintDeskUi(host) {
  const cams = document.createElement("div");
  cams.className = "n3-cams";
  const camBtns = {
    clamp: btn(cams, "grampo de perto"),
    under: btn(cams, "por baixo"),
    whole: btn(cams, "mesa inteira"),
  };
  const partBar = document.createElement("div");
  partBar.className = "n3-parts";
  const partBtns = {
    wood: partBtn(partBar, "Tampo", "#8b5a2b"),
    metal: partBtn(partBar, "Estrutura", "#8a9098"),
    clamp: partBtn(partBar, "Grampo", "#4a86d4"),
  };
  const hint = document.createElement("div");
  hint.className = "n3-hint";
  hint.textContent = "arraste para girar · Ctrl+scroll para zoom";
  host.append(cams, partBar, hint);
  return { cams: camBtns, parts: partBtns };
}

function btn(parent, label) {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  parent.append(el);
  return el;
}

function partBtn(parent, label, color) {
  const el = document.createElement("button");
  el.type = "button";
  el.innerHTML = `<i style="background:${color}"></i>${label}`;
  parent.append(el);
  return el;
}

function boot() {
  if (!THREE) {
    parent.postMessage({ type: "ncli-3d", op: "ready", kind: "error", buttons: [], engine: "", triangles: 0 }, "*");
    return;
  }
  window.ncli3d = { desk, box };
  const src = sceneSource();
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const el = document.createElement("script");
  el.src = url;
  el.onload = () => URL.revokeObjectURL(url);
  el.onerror = () => {
    URL.revokeObjectURL(url);
    desk();
  };
  document.head.appendChild(el);
}

boot();
