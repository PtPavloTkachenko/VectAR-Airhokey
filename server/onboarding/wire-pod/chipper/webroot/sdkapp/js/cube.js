// Cube Debug - Three.js 3D visualization + polling
// ============================================================
// Vector coordinate system: X=forward, Y=left, Z=up (mm)
// Three.js coordinate system: X=right, Y=up, Z=toward camera
//
// Mapping: Three(x, y, z) = Vector(x, z, -y)
//   Vector X (forward)  -> Three.js +X
//   Vector Y (left)     -> Three.js -Z
//   Vector Z (up)       -> Three.js +Y
//
// Quaternion remap (Z-up -> Y-up):
//   Three.Quaternion(vec_q1, vec_q3, -vec_q2, vec_q0)
// ============================================================

var cubeStreamRunning = false;
var cubeScene, cubeCamera, cubeRenderer;
var cubeMesh, robotMesh, robotArrow, chargerMesh;
var cubePollingInterval = null;
var cubeAnimFrameId = null;
var lastCubePoseTime = 0;
var lastChargerPoseTime = 0;
var prevCubeX = null, prevCubeY = null, prevCubeZ = null;
var prevChargerX = null, prevChargerY = null, prevChargerZ = null;

function startCubeSection() {
  fetch("/api-sdk/begin_cube_stream?serial=" + esn, { method: "POST" });
  cubeStreamRunning = true;
  lastCubePoseTime = 0;
  lastChargerPoseTime = 0;
  prevCubeX = null;
  prevChargerX = null;
  initCubeScene();
  startCubePolling();
  renderCubeLoop();
}

function stopCubeSection() {
  cubeStreamRunning = false;
  if (cubePollingInterval) {
    clearInterval(cubePollingInterval);
    cubePollingInterval = null;
  }
  if (cubeAnimFrameId) {
    cancelAnimationFrame(cubeAnimFrameId);
    cubeAnimFrameId = null;
  }
  fetch("/api-sdk/stop_cube_stream?serial=" + esn, { method: "POST" });
}

function initCubeScene() {
  var canvas = document.getElementById("cubeCanvas");
  if (!canvas || !window.THREE) return;

  cubeScene = new THREE.Scene();
  cubeScene.background = new THREE.Color(0x1e1e1e);

  cubeCamera = new THREE.PerspectiveCamera(50, canvas.width / canvas.height, 1, 5000);
  cubeCamera.position.set(300, 400, 300);
  cubeCamera.lookAt(0, 0, 0);

  cubeRenderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
  cubeRenderer.setSize(canvas.width, canvas.height);

  // Grid floor (1000mm, 20 divisions = 50mm each)
  var grid = new THREE.GridHelper(1000, 20, 0x444444, 0x333333);
  cubeScene.add(grid);

  // Axes helper — Red=X(forward), Green=Y(up), Blue=Z(Vector -Y)
  var axes = new THREE.AxesHelper(150);
  cubeScene.add(axes);

  // Forward label (X axis = Vector forward)
  var fwdLabelGeo = new THREE.ConeGeometry(6, 18, 4);
  var fwdLabelMat = new THREE.MeshBasicMaterial({ color: 0xff4444 });
  var fwdLabel = new THREE.Mesh(fwdLabelGeo, fwdLabelMat);
  fwdLabel.position.set(170, 0, 0);
  fwdLabel.rotation.z = -Math.PI / 2;
  cubeScene.add(fwdLabel);

  // ——— Cube wireframe (44mm) ———
  var cubeGeo = new THREE.BoxGeometry(44, 44, 44);
  var cubeMat = new THREE.MeshBasicMaterial({ color: 0x33ed6d, wireframe: true });
  cubeMesh = new THREE.Mesh(cubeGeo, cubeMat);
  cubeScene.add(cubeMesh);

  // ——— Robot body (100x60x50mm — length x height x width) ———
  var robotGeo = new THREE.BoxGeometry(100, 60, 50);
  var robotMat = new THREE.MeshBasicMaterial({ color: 0x3399ff, wireframe: true });
  robotMesh = new THREE.Mesh(robotGeo, robotMat);
  cubeScene.add(robotMesh);

  // Forward arrow on robot (red, +X local = forward)
  var arrowDir = new THREE.Vector3(1, 0, 0);
  robotArrow = new THREE.ArrowHelper(arrowDir, new THREE.Vector3(0, 0, 0), 80, 0xff3333, 15, 10);
  robotMesh.add(robotArrow);

  // "Eyes" — two small spheres at the front to make forward obvious
  var eyeGeo = new THREE.SphereGeometry(4, 8, 8);
  var eyeMat = new THREE.MeshBasicMaterial({ color: 0x00ccff });
  var eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(50, 15, 12);
  robotMesh.add(eyeL);
  var eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeR.position.set(50, 15, -12);
  robotMesh.add(eyeR);

  // ——— Charger dock (flat box, initially hidden until tracked) ———
  var chargerGeo = new THREE.BoxGeometry(80, 8, 100);
  var chargerMat = new THREE.MeshBasicMaterial({ color: 0xff8800, wireframe: true, transparent: true, opacity: 0.15 });
  chargerMesh = new THREE.Mesh(chargerGeo, chargerMat);
  chargerMesh.position.set(0, 4, 0);
  cubeScene.add(chargerMesh);
  // Charger marker (small triangle pointing forward)
  var chMarkerGeo = new THREE.ConeGeometry(8, 16, 3);
  var chMarkerMat = new THREE.MeshBasicMaterial({ color: 0xff8800 });
  var chMarker = new THREE.Mesh(chMarkerGeo, chMarkerMat);
  chMarker.position.set(48, 6, 0);
  chMarker.rotation.z = -Math.PI / 2;
  chargerMesh.add(chMarker);

  // Ambient + directional light
  cubeScene.add(new THREE.AmbientLight(0xffffff, 0.5));
  var dirLight = new THREE.DirectionalLight(0xffffff, 0.3);
  dirLight.position.set(200, 400, 100);
  cubeScene.add(dirLight);
}

function renderCubeLoop() {
  if (!cubeStreamRunning) return;
  if (cubeRenderer && cubeScene && cubeCamera) {
    cubeRenderer.render(cubeScene, cubeCamera);
  }
  cubeAnimFrameId = requestAnimationFrame(renderCubeLoop);
}

function startCubePolling() {
  // Poll at 100ms (10 Hz) for smoother robot movement
  cubePollingInterval = setInterval(function () {
    if (!cubeStreamRunning) return;
    fetch("/api-sdk/cube_status?serial=" + esn)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        updateCubeInfoPanel(data);
        updateCubeRawData(data);
        updateCube3D(data);
      })
      .catch(function () {});
  }, 100);
}

var upAxisNames = {
  0: "INVALID",
  1: "X_NEG", 2: "X_POS",
  3: "Y_NEG", 4: "Y_POS",
  5: "Z_NEG", 6: "Z_POS"
};

function updateCubeInfoPanel(d) {
  var el;
  el = document.getElementById("cubeConnected");
  if (el) el.textContent = d.connected ? "Yes" : "No";
  el = document.getElementById("cubeFactoryId");
  if (el) el.textContent = d.factory_id || "-";
  el = document.getElementById("cubeObjectId");
  if (el) el.textContent = d.object_id || "0";
  el = document.getElementById("cubeBattery");
  if (el) el.textContent = (d.battery_volts > 0 ? d.battery_volts.toFixed(2) + "V" : "-") +
    " (" + (d.battery_level === 1 ? "Normal" : "Low") + ")";
  el = document.getElementById("cubeMoving");
  if (el) el.textContent = d.is_moving ? "Yes" : "No";
  el = document.getElementById("cubeUpAxis");
  if (el) el.textContent = upAxisNames[d.up_axis] || d.up_axis;
  el = document.getElementById("cubeLastTapped");
  if (el) el.textContent = d.last_tapped || "0";

  // Cube freshness indicator
  el = document.getElementById("cubeFreshness");
  if (el) {
    if (lastCubePoseTime === 0) {
      el.textContent = "No data yet";
      el.style.color = "#888";
    } else {
      var age = (Date.now() - lastCubePoseTime) / 1000;
      if (age < 2) {
        el.textContent = "Live";
        el.style.color = "#33ed6d";
      } else if (age < 10) {
        el.textContent = age.toFixed(0) + "s ago";
        el.style.color = "#ffcc00";
      } else {
        el.textContent = age.toFixed(0) + "s ago (stale)";
        el.style.color = "#ff4444";
      }
    }
  }

  // Charger freshness indicator
  el = document.getElementById("chargerFreshness");
  if (el) {
    if (lastChargerPoseTime === 0) {
      el.textContent = "No data yet";
      el.style.color = "#888";
    } else {
      var chAge = (Date.now() - lastChargerPoseTime) / 1000;
      if (chAge < 2) {
        el.textContent = "Live";
        el.style.color = "#ff8800";
      } else if (chAge < 30) {
        el.textContent = chAge.toFixed(0) + "s ago";
        el.style.color = "#ffcc00";
      } else {
        el.textContent = chAge.toFixed(0) + "s ago (stale)";
        el.style.color = "#ff4444";
      }
    }
  }
}

function updateCubeRawData(d) {
  var el;
  el = document.getElementById("cubePoseRaw");
  if (el) el.textContent = "x=" + d.cube_x.toFixed(1) + " y=" + d.cube_y.toFixed(1) + " z=" + d.cube_z.toFixed(1);
  el = document.getElementById("cubeQuatRaw");
  if (el) el.textContent = "q0=" + d.cube_q0.toFixed(3) + " q1=" + d.cube_q1.toFixed(3) +
    " q2=" + d.cube_q2.toFixed(3) + " q3=" + d.cube_q3.toFixed(3);
  el = document.getElementById("robotPoseRaw");
  if (el) el.textContent = "x=" + d.robot_x.toFixed(1) + " y=" + d.robot_y.toFixed(1) + " z=" + d.robot_z.toFixed(1);
  el = document.getElementById("robotQuatRaw");
  if (el) el.textContent = "q0=" + d.robot_q0.toFixed(3) + " q1=" + d.robot_q1.toFixed(3) +
    " q2=" + d.robot_q2.toFixed(3) + " q3=" + d.robot_q3.toFixed(3);
  el = document.getElementById("robotHeadingRaw");
  if (el) el.textContent = "yaw=" + (d.robot_angle_rad * 180 / Math.PI).toFixed(1) + "\u00B0" +
    " head=" + (d.head_angle_rad * 180 / Math.PI).toFixed(1) + "\u00B0" +
    " lift=" + d.lift_height_mm.toFixed(1) + "mm";
  el = document.getElementById("chargerPoseRaw");
  if (el) {
    if (d.charger_visible) {
      el.textContent = "x=" + d.charger_x.toFixed(1) + " y=" + d.charger_y.toFixed(1) + " z=" + d.charger_z.toFixed(1);
    } else {
      el.textContent = "not seen yet";
    }
  }
}

// Remap Vector quaternion (Z-up) to Three.js quaternion (Y-up)
function vecQuatToThree(q0, q1, q2, q3) {
  // Vector: q0=w, q1=x, q2=y, q3=z (Z-up)
  // Three.js: (x, y, z, w) (Y-up)
  // Axis remap: Vec.X->Thr.X, Vec.Z->Thr.Y, Vec.Y->Thr.-Z
  return new THREE.Quaternion(q1, q3, -q2, q0);
}

function updateCube3D(d) {
  if (!cubeMesh || !robotMesh || !window.THREE) return;

  // ——— Cube position ———
  // Mapping: Three(x, y, z) = Vector(x, z, -y)
  cubeMesh.position.set(d.cube_x, d.cube_z, -d.cube_y);

  // Detect if cube pose actually changed (new observation from camera)
  if (prevCubeX !== d.cube_x || prevCubeY !== d.cube_y || prevCubeZ !== d.cube_z) {
    lastCubePoseTime = Date.now();
    prevCubeX = d.cube_x;
    prevCubeY = d.cube_y;
    prevCubeZ = d.cube_z;
  }

  // Cube staleness -> opacity
  var cubeAge = (Date.now() - lastCubePoseTime) / 1000;
  if (lastCubePoseTime === 0) {
    cubeMesh.material.opacity = 0.15;
    cubeMesh.material.transparent = true;
  } else if (cubeAge < 2) {
    cubeMesh.material.opacity = 1.0;
    cubeMesh.material.transparent = false;
  } else {
    cubeMesh.material.opacity = Math.max(0.2, 1.0 - (cubeAge - 2) * 0.08);
    cubeMesh.material.transparent = true;
  }

  // ——— Cube rotation (quaternion) ———
  cubeMesh.setRotationFromQuaternion(vecQuatToThree(d.cube_q0, d.cube_q1, d.cube_q2, d.cube_q3));

  // ——— Robot position ———
  // +30 on Y to lift center of robot box above the floor
  robotMesh.position.set(d.robot_x, d.robot_z + 30, -d.robot_y);

  // ——— Robot rotation (full quaternion — shows pitch on slopes!) ———
  var hasRobotQuat = (d.robot_q0 !== 0 || d.robot_q1 !== 0 || d.robot_q2 !== 0 || d.robot_q3 !== 0);
  if (hasRobotQuat) {
    robotMesh.setRotationFromQuaternion(vecQuatToThree(d.robot_q0, d.robot_q1, d.robot_q2, d.robot_q3));
  } else {
    // Fallback to yaw-only if quaternion not available
    robotMesh.rotation.set(0, d.robot_angle_rad, 0);
  }

  // ——— Charger position (tracked via observed object) ———
  if (chargerMesh && d.charger_visible) {
    // Detect if charger pose changed
    if (prevChargerX !== d.charger_x || prevChargerY !== d.charger_y || prevChargerZ !== d.charger_z) {
      lastChargerPoseTime = Date.now();
      prevChargerX = d.charger_x;
      prevChargerY = d.charger_y;
      prevChargerZ = d.charger_z;
    }

    chargerMesh.position.set(d.charger_x, d.charger_z + 4, -d.charger_y);
    chargerMesh.setRotationFromQuaternion(vecQuatToThree(d.charger_q0, d.charger_q1, d.charger_q2, d.charger_q3));

    // Charger staleness -> opacity
    var chAge = (Date.now() - lastChargerPoseTime) / 1000;
    if (chAge < 5) {
      chargerMesh.material.opacity = 1.0;
      chargerMesh.material.transparent = false;
    } else {
      chargerMesh.material.opacity = Math.max(0.3, 1.0 - (chAge - 5) * 0.03);
      chargerMesh.material.transparent = true;
    }
  }
}

// ——— Button handlers ———

function cubeConnect() {
  fetch("/api-sdk/connect_cube?serial=" + esn, { method: "POST" })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) alert("Connect error: " + data.error);
    })
    .catch(function (e) { alert("Connect failed: " + e); });
}

function cubeDisconnect() {
  fetch("/api-sdk/disconnect_cube?serial=" + esn, { method: "POST" })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) alert("Disconnect error: " + data.error);
    })
    .catch(function (e) { alert("Disconnect failed: " + e); });
}

function cubeFlash() {
  fetch("/api-sdk/flash_cube?serial=" + esn, { method: "POST" })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) alert("Flash error: " + data.error);
    })
    .catch(function (e) { alert("Flash failed: " + e); });
}

function setCubeLights() {
  var c1 = document.getElementById("ledColor1").value.replace("#", "");
  var c2 = document.getElementById("ledColor2").value.replace("#", "");
  var c3 = document.getElementById("ledColor3").value.replace("#", "");
  var c4 = document.getElementById("ledColor4").value.replace("#", "");
  var url = "/api-sdk/set_cube_lights?serial=" + esn +
    "&c1=" + c1 + "&c2=" + c2 + "&c3=" + c3 + "&c4=" + c4;
  fetch(url, { method: "POST" })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) alert("Set lights error: " + data.error);
    })
    .catch(function (e) { alert("Set lights failed: " + e); });
}
