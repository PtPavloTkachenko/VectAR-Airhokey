// sensors.js — Sensor Dashboard for Wire-Pod sdkapp
// ============================================================

var sensorStreamRunning = false;
var sensorPollInterval = null;
var navMapPollInterval = null;
var eventLogPollInterval = null;
var lastEventTime = 0;

// Three.js objects for sensor 3D view
var sScene, sCamera, sRenderer, sControls;
var sRobotMesh, sChargerMesh, sCubeMesh;
var sNavFloorMesh = null;
var sCliffGroup = null;
var sNavFloorTexture = null;
var s3DAnimFrameId = null;
var _lastSensorData = null;
var sTrail = [];
var sTrailLine = null;

// Face overlay state
var _lastFaces = [];
var _faceOverlayFadeTimer = null;

// Expression names for display
var EXPR_NAMES = ["unknown", "neutral", "happy", "surprise", "angry", "sad"];
var EXPR_COLORS = ["#666", "#aaa", "#33ed6d", "#ffaa00", "#ff4444", "#3399ff"];

// ============= LIFECYCLE =============

function startSensorSection() {
  if (sensorStreamRunning) return;
  sensorStreamRunning = true;
  lastEventTime = 0;
  sTrail = [];
  _lastFaces = [];

  // Start backend streams
  fetch("/api-sdk/begin_sensor_stream?serial=" + esn, { method: "POST" });

  // Start camera feed (may take a moment if robot is sleeping)
  var camImg = document.getElementById("sensorCamFeed");
  if (camImg) {
    var camStatus = document.getElementById("sCamStatus");
    if (camStatus) camStatus.textContent = "Connecting to camera...";
    camImg.onload = function() {
      syncFaceOverlaySize();
      if (camStatus) camStatus.textContent = "";
    };
    camImg.onerror = function() {
      if (camStatus) camStatus.textContent = "Camera unavailable (robot may be sleeping)";
    };
    camImg.src = "/cam-stream?serial=" + esn + "&t=" + Date.now();
  }

  // Init 3D scene
  initSensor3D();

  // Start polling
  sensorPollInterval = setInterval(pollSensors, 200);
  navMapPollInterval = setInterval(pollNavMap, 1000);
  eventLogPollInterval = setInterval(pollEventLog, 500);

  renderSensor3DLoop();
}

function stopSensorSection() {
  sensorStreamRunning = false;

  if (sensorPollInterval) { clearInterval(sensorPollInterval); sensorPollInterval = null; }
  if (navMapPollInterval) { clearInterval(navMapPollInterval); navMapPollInterval = null; }
  if (eventLogPollInterval) { clearInterval(eventLogPollInterval); eventLogPollInterval = null; }
  if (s3DAnimFrameId) { cancelAnimationFrame(s3DAnimFrameId); s3DAnimFrameId = null; }
  if (_faceOverlayFadeTimer) { clearTimeout(_faceOverlayFadeTimer); _faceOverlayFadeTimer = null; }

  var camImg = document.getElementById("sensorCamFeed");
  if (camImg) camImg.src = "";

  // Reset 3D navmap state
  sNavFloorTexture = null;

  fetch("/api-sdk/stop_sensor_stream?serial=" + esn, { method: "POST" });
}

// ============= SENSOR POLLING =============

function pollSensors() {
  if (!sensorStreamRunning) return;
  fetch("/api-sdk/sensor_status?serial=" + esn)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      _lastSensorData = d;
      updateSensorGauges(d);
      updateSensor3D(d);
      // Handle face detection overlay
      if (d.faces && d.faces.length > 0) {
        _lastFaces = d.faces;
        drawFaceOverlay(d.faces);
        updateExpressionHistogram(d.faces[0]);
        // Auto-clear after 1s if no new face data
        if (_faceOverlayFadeTimer) clearTimeout(_faceOverlayFadeTimer);
        _faceOverlayFadeTimer = setTimeout(function() {
          _lastFaces = [];
          clearFaceOverlay();
          clearExpressionHistogram();
        }, 1500);
      }
    })
    .catch(function() {});
}

function updateSensorGauges(d) {
  // Proximity
  setText("sProxDist", d.prox_distance_mm || 0);
  var proxBar = document.getElementById("sProxBar");
  if (proxBar) {
    var pct = Math.min(100, ((d.prox_distance_mm || 0) / 400) * 100);
    proxBar.style.width = pct + "%";
    proxBar.style.background = pct < 25 ? "#ff4444" : pct < 50 ? "#ff8800" : "#33ed6d";
  }
  setText("sProxObj", d.prox_found_object ? "YES" : "no");
  setText("sProxQual", ff(d.prox_signal_quality));

  // Touch
  setText("sTouchVal", d.touch_raw_value || 0);
  setText("sTouched", d.is_being_touched ? "YES" : "no");

  // IMU
  setText("sAccel", "x=" + ff(d.accel_x) + " y=" + ff(d.accel_y) + " z=" + ff(d.accel_z));
  setText("sGyro", "x=" + ff(d.gyro_x) + " y=" + ff(d.gyro_y) + " z=" + ff(d.gyro_z));

  // Motors
  setText("sLWheel", ff(d.left_wheel_speed_mmps));
  setText("sRWheel", ff(d.right_wheel_speed_mmps));
  setText("sHead", ff(d.head_angle_rad * 180 / Math.PI) + "\u00B0");
  setText("sLift", ff(d.lift_height_mm) + "mm");

  // Position
  setText("sPosX", ff(d.robot_x));
  setText("sPosY", ff(d.robot_y));
  setText("sAngle", ff(d.robot_angle_rad * 180 / Math.PI) + "\u00B0");

  // Stimulation
  setText("sStimVal", ff(d.stim_value));
  var stimBar = document.getElementById("sStimBar");
  if (stimBar) {
    stimBar.style.width = Math.min(100, Math.max(0, (d.stim_value || 0) * 100)) + "%";
  }

  // Status flags
  var flagsEl = document.getElementById("sStatusFlags");
  if (flagsEl) {
    var flags = [
      ["charger", d.is_on_charger],
      ["charging", d.is_charging],
      ["moving", d.is_moving],
      ["pickup", d.is_picked_up],
      ["cliff", d.is_cliff_detected],
      ["held", d.is_being_held],
      ["anim", d.is_animating],
      ["path", d.is_pathing],
      ["button", d.is_button_pressed],
      ["fall", d.is_falling],
      ["carry", d.is_carrying_block],
      ["wheels", d.are_wheels_moving],
      ["calm", d.is_calm_power_mode],
    ];
    flagsEl.innerHTML = "";
    for (var i = 0; i < flags.length; i++) {
      var span = document.createElement("span");
      span.className = "status-flag " + (flags[i][1] ? "on" : "off");
      span.textContent = flags[i][0];
      flagsEl.appendChild(span);
    }
  }

  // Face
  setText("sFaceId", d.face_id || "-");
  setText("sFaceName", d.face_name || "-");
  setText("sFaceExpr", d.face_expression || "-");

  // Face label on camera
  var faceLabel = document.getElementById("sFaceLabel");
  if (faceLabel) {
    if (d.faces && d.faces.length > 0) {
      var f = d.faces[0];
      faceLabel.textContent = (f.name || "unknown") + " — " + (f.expression || "?");
    }
  }

  // Cube
  if (d.cube_visible) {
    setText("sCubePos", "x=" + ff(d.cube_x) + " y=" + ff(d.cube_y) + " z=" + ff(d.cube_z));
  } else {
    setText("sCubePos", "not visible");
  }

  // Charger
  if (d.charger_visible) {
    setText("sChargerPos", "x=" + ff(d.charger_x) + " y=" + ff(d.charger_y));
  } else {
    setText("sChargerPos", "not visible");
  }
}

// ============= FACE DETECTION OVERLAY =============

function syncFaceOverlaySize() {
  var img = document.getElementById("sensorCamFeed");
  var canvas = document.getElementById("faceOverlayCanvas");
  if (!img || !canvas) return;
  // Match canvas to actual camera image dimensions
  var w = img.naturalWidth || 640;
  var h = img.naturalHeight || 480;
  canvas.width = w;
  canvas.height = h;
}

function drawFaceOverlay(faces) {
  var canvas = document.getElementById("faceOverlayCanvas");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");

  // Sync canvas to camera resolution
  var img = document.getElementById("sensorCamFeed");
  if (img && img.naturalWidth > 0 && canvas.width !== img.naturalWidth) syncFaceOverlaySize();

  var cw = canvas.width;
  var ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  // Debug: show canvas/image dimensions
  ctx.font = "10px monospace";
  ctx.fillStyle = "rgba(255,255,0,0.8)";
  ctx.fillText("canvas:" + cw + "x" + ch + " img:" + (img ? img.naturalWidth + "x" + img.naturalHeight : "?"), 4, 12);

  for (var i = 0; i < faces.length; i++) {
    var f = faces[i];

    // Draw bounding box — coordinates are in camera pixel space
    var rect = f.img_rect;
    if (rect && (rect[2] > 0 || rect[3] > 0)) {
      // Debug: show raw coordinates
      ctx.fillStyle = "rgba(255,255,0,0.8)";
      ctx.font = "10px monospace";
      ctx.fillText("rect:[" + rect[0].toFixed(0) + "," + rect[1].toFixed(0) + "," + rect[2].toFixed(0) + "," + rect[3].toFixed(0) + "]", 4, 24);

      ctx.strokeStyle = "#e237e6";
      ctx.lineWidth = 2;
      ctx.strokeRect(rect[0], rect[1], rect[2], rect[3]);

      // Label above bounding box
      var label = (f.name || "?") + " " + (f.expression || "?");
      ctx.font = "bold 14px monospace";
      ctx.fillStyle = "#e237e6";
      ctx.fillText(label, rect[0], rect[1] - 5);
    }

    // Draw landmarks
    drawLandmarkPoints(ctx, f.left_eye, "#00ccff", 3);
    drawLandmarkPoints(ctx, f.right_eye, "#00ccff", 3);
    drawLandmarkPoints(ctx, f.nose, "#33ed6d", 3);
    drawLandmarkPoints(ctx, f.mouth, "#ff8800", 3);

    // Connect eye points with lines
    drawLandmarkLines(ctx, f.left_eye, "#00ccff88");
    drawLandmarkLines(ctx, f.right_eye, "#00ccff88");
    drawLandmarkLines(ctx, f.mouth, "#ff880088");
  }
}

function drawLandmarkPoints(ctx, points, color, radius) {
  if (!points || points.length === 0) return;
  ctx.fillStyle = color;
  for (var i = 0; i < points.length; i++) {
    ctx.beginPath();
    ctx.arc(points[i][0], points[i][1], radius, 0, 2 * Math.PI);
    ctx.fill();
  }
}

function drawLandmarkLines(ctx, points, color) {
  if (!points || points.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (var i = 1; i < points.length; i++) {
    ctx.lineTo(points[i][0], points[i][1]);
  }
  ctx.stroke();
}

function clearFaceOverlay() {
  var canvas = document.getElementById("faceOverlayCanvas");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  var faceLabel = document.getElementById("sFaceLabel");
  if (faceLabel) faceLabel.textContent = "";
}

function updateExpressionHistogram(face) {
  var el = document.getElementById("sExprHisto");
  if (!el) return;
  var vals = face.expression_values;
  if (!vals || vals.length === 0) {
    el.innerHTML = "";
    return;
  }
  var html = '<div style="display:flex; gap:2px; align-items:flex-end; height:40px; justify-content:center;">';
  for (var i = 0; i < vals.length && i < EXPR_NAMES.length; i++) {
    var pct = vals[i] || 0;
    var barH = Math.max(1, pct * 0.38);
    html += '<div style="display:flex; flex-direction:column; align-items:center; width:50px;">';
    html += '<div style="width:30px; height:' + barH + 'px; background:' + EXPR_COLORS[i] + '; border-radius:2px 2px 0 0;"></div>';
    html += '<div style="font-size:8px; color:' + EXPR_COLORS[i] + '; margin-top:1px;">' + EXPR_NAMES[i].substr(0,4) + '</div>';
    if (pct > 0) {
      html += '<div style="font-size:8px; color:#888;">' + pct + '%</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  el.innerHTML = html;
}

function clearExpressionHistogram() {
  var el = document.getElementById("sExprHisto");
  if (el) el.innerHTML = "";
}

// ============= NAV MAP =============

var NAV_COLORS = {
  0: "#222222", 1: "#33ed6d", 2: "#226644", 3: "#ff8800",
  4: "#ff4444", 5: "#cc3333", 6: "#ff6666", 7: "#ffaa00",
  8: "#3399ff", 9: "#444444"
};

function pollNavMap() {
  if (!sensorStreamRunning) return;
  fetch("/api-sdk/nav_map_status?serial=" + esn)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      renderNavMap2D(d);
      updateNavMap3D(d);
    })
    .catch(function() {});
}

// --- NavMap accumulation state ---
var _navAccumCanvas = null;
var _navAccumCtx = null;
var _navLastOriginId = null;
var _navLastCenter = null; // "cx,cy,sz" to detect map bounds change
var _navAccumCount = 0;    // total accumulated updates

function renderNavMap2D(d) {
  var canvas = document.getElementById("navMapCanvas");
  if (!canvas || !d.leaves) return;
  var ctx = canvas.getContext("2d");
  var sz = 512; // fixed canvas resolution
  if (canvas.width !== sz) { canvas.width = sz; canvas.height = sz; }

  // Init off-screen accumulation canvas (persistent memory)
  if (!_navAccumCanvas) {
    _navAccumCanvas = document.createElement("canvas");
    _navAccumCanvas.width = sz;
    _navAccumCanvas.height = sz;
    _navAccumCtx = _navAccumCanvas.getContext("2d");
    _navAccumCtx.fillStyle = "#111";
    _navAccumCtx.fillRect(0, 0, sz, sz);
  }

  // Reset accumulation on origin change or map bounds change
  var mapKey = d.origin_id + "," + d.center_x + "," + d.center_y + "," + d.size_mm;
  if (mapKey !== _navLastCenter) {
    _navAccumCtx.fillStyle = "#111";
    _navAccumCtx.fillRect(0, 0, sz, sz);
    _navLastCenter = mapKey;
    _navAccumCount = 0;
  }

  var halfSize = d.size_mm / 2;
  // World coords to canvas pixels
  function w2c(wx, wy) {
    return [(wx - d.center_x + halfSize) / d.size_mm * sz,
            (d.center_y + halfSize - wy) / d.size_mm * sz];
  }

  // Accumulate: draw ONLY non-zero leaves onto persistent canvas
  // Zero (unknown) leaves do NOT erase previously known data
  for (var i = 0; i < d.leaves.length; i++) {
    var lf = d.leaves[i];
    if (lf.c === 0) continue; // skip unknown — keep old data
    _navAccumCtx.fillStyle = NAV_COLORS[lf.c] || "#222";
    var tl = w2c(lf.x - lf.sz / 2, lf.y + lf.sz / 2);
    var pxSz = lf.sz / d.size_mm * sz;
    _navAccumCtx.fillRect(tl[0], tl[1], pxSz, pxSz);
  }
  _navAccumCount++;

  // Blit accumulated map to visible canvas
  ctx.drawImage(_navAccumCanvas, 0, 0);

  // Draw robot, charger, cube ON TOP of accumulated map
  if (_lastSensorData) {
    var rp = w2c(_lastSensorData.robot_x || 0, _lastSensorData.robot_y || 0);

    // Robot dot + arrow
    ctx.beginPath();
    ctx.arc(rp[0], rp[1], 4, 0, 2 * Math.PI);
    ctx.fillStyle = "#00ccff";
    ctx.fill();
    var angle = _lastSensorData.robot_angle_rad || 0;
    ctx.beginPath();
    ctx.moveTo(rp[0], rp[1]);
    ctx.lineTo(rp[0] + Math.cos(angle) * 14, rp[1] - Math.sin(angle) * 14);
    ctx.strokeStyle = "#00ffff";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Charger — when charging, use robot pos as charger pos (strongest signal)
    var chX, chY, chShow = false;
    if (_lastSensorData.is_charging) {
      chX = _lastSensorData.robot_x || 0;
      chY = _lastSensorData.robot_y || 0;
      chShow = true;
    } else if (_lastSensorData.charger_visible) {
      chX = _lastSensorData.charger_x || 0;
      chY = _lastSensorData.charger_y || 0;
      chShow = true;
    }
    if (chShow) {
      var cp = w2c(chX, chY);
      ctx.fillStyle = "#ffaa00";
      ctx.font = "14px sans-serif";
      ctx.fillText("\u26A1", cp[0] - 5, cp[1] + 5);
    }

    // Cube
    if (_lastSensorData.cube_visible) {
      var bp = w2c(_lastSensorData.cube_x || 0, _lastSensorData.cube_y || 0);
      ctx.strokeStyle = "#00ff00";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bp[0] - 4, bp[1] - 4, 8, 8);
    }
  }

  // Legend with accumulation info
  var nLeaves = d.leaves ? d.leaves.length : 0;
  ctx.fillStyle = "#888";
  ctx.font = "10px monospace";
  ctx.fillText(nLeaves + " leaves | " + ff(d.size_mm) + "mm | " + _navAccumCount + " frames accumulated", 4, sz - 4);
}

// ============= 3D NAVMAP + CLIFFS =============

function updateNavMap3D(d) {
  if (!sNavFloorMesh || !window.THREE || !_navAccumCanvas) return;

  // Update floor texture from accumulated 2D canvas
  if (!sNavFloorTexture) {
    sNavFloorTexture = new THREE.CanvasTexture(_navAccumCanvas);
    sNavFloorTexture.minFilter = THREE.NearestFilter;
    sNavFloorTexture.magFilter = THREE.NearestFilter;
    sNavFloorMesh.material.map = sNavFloorTexture;
    sNavFloorMesh.material.needsUpdate = true;
  }
  sNavFloorTexture.needsUpdate = true;

  // Scale and position floor to match world coordinates
  // Three.js: x=Vector.x, z=-Vector.y
  var sizeMm = d.size_mm || 2048;
  sNavFloorMesh.scale.set(sizeMm, sizeMm, 1);
  sNavFloorMesh.position.x = d.center_x || 0;
  sNavFloorMesh.position.z = -(d.center_y || 0);
  sNavFloorMesh.visible = true;

  // Update cliff markers (rebuild every 5 frames to save CPU)
  if (_navAccumCount % 5 !== 0) return;

  // Clear old cliff markers
  while (sCliffGroup.children.length > 0) {
    var c = sCliffGroup.children[0];
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
    sCliffGroup.remove(c);
  }

  if (!d.leaves) return;

  // Build 3D markers for cliffs and obstacles
  var cliffGeo = new THREE.BoxGeometry(1, 20, 1);
  var cliffMat = new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true, opacity: 0.5 });
  var obstGeo = new THREE.BoxGeometry(1, 10, 1);
  var obstMat = new THREE.MeshBasicMaterial({ color: 0xff3333, transparent: true, opacity: 0.4 });

  var markerCount = 0;
  for (var i = 0; i < d.leaves.length; i++) {
    var lf = d.leaves[i];
    if (markerCount > 300) break;

    if (lf.c === 7) {
      // Cliff — tall orange marker
      var cm = new THREE.Mesh(cliffGeo, cliffMat);
      cm.position.set(lf.x, 10, -lf.y);
      cm.scale.set(lf.sz, 1, lf.sz);
      sCliffGroup.add(cm);
      markerCount++;
    } else if (lf.c >= 3 && lf.c <= 6) {
      // Obstacle — shorter red marker
      var om = new THREE.Mesh(obstGeo, obstMat);
      om.position.set(lf.x, 5, -lf.y);
      om.scale.set(lf.sz, 1, lf.sz);
      sCliffGroup.add(om);
      markerCount++;
    }
  }
}

// ============= EVENT LOG =============

function pollEventLog() {
  if (!sensorStreamRunning) return;
  fetch("/api-sdk/event_log?serial=" + esn + "&since=" + lastEventTime)
    .then(function(r) { return r.json(); })
    .then(function(events) {
      if (!events || events.length === 0) return;
      var logEl = document.getElementById("eventLogConsole");
      if (!logEl) return;
      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        var line = document.createElement("div");
        var ts = new Date(e.time).toLocaleTimeString([], {hour12: false});
        line.className = "evt-" + e.type;
        line.textContent = "[" + ts + "] " + e.message;
        logEl.appendChild(line);
        lastEventTime = Math.max(lastEventTime, e.time);
      }
      logEl.scrollTop = logEl.scrollHeight;
      while (logEl.childNodes.length > 300) {
        logEl.removeChild(logEl.firstChild);
      }
    })
    .catch(function() {});
}

// ============= 3D VIEW =============

function initSensor3D() {
  var canvas = document.getElementById("sensor3DCanvas");
  if (!canvas || !window.THREE) return;
  if (sRenderer) return; // already initialized

  sScene = new THREE.Scene();
  sScene.background = new THREE.Color(0x111118);

  sCamera = new THREE.PerspectiveCamera(50, canvas.width / canvas.height, 1, 10000);
  sCamera.position.set(100, 500, 400);
  sCamera.lookAt(0, 0, 0);

  sRenderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
  sRenderer.setSize(canvas.width, canvas.height);

  // Grid floor — 2500mm to cover full navmap range
  var grid = new THREE.GridHelper(2500, 50, 0x333333, 0x1a1a1a);
  sScene.add(grid);
  sScene.add(new THREE.AxesHelper(50));

  // Robot body — blue wireframe box with eyes
  var robotGeo = new THREE.BoxGeometry(100, 50, 60);
  var robotMat = new THREE.MeshBasicMaterial({ color: 0x3399ff, wireframe: true });
  sRobotMesh = new THREE.Mesh(robotGeo, robotMat);
  sScene.add(sRobotMesh);

  // Robot eyes
  var eyeGeo = new THREE.SphereGeometry(4, 8, 8);
  var eyeMat = new THREE.MeshBasicMaterial({ color: 0x00ccff });
  var eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(50, 12, 14);
  sRobotMesh.add(eyeL);
  var eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeR.position.set(50, 12, -14);
  sRobotMesh.add(eyeR);

  // Forward arrow
  var arrowDir = new THREE.Vector3(1, 0, 0);
  var arrow = new THREE.ArrowHelper(arrowDir, new THREE.Vector3(), 70, 0xff3333, 12, 8);
  sRobotMesh.add(arrow);

  // Charger dock — orange
  var chGeo = new THREE.BoxGeometry(80, 8, 100);
  var chMat = new THREE.MeshBasicMaterial({ color: 0xff8800, wireframe: true, transparent: true, opacity: 0.4 });
  sChargerMesh = new THREE.Mesh(chGeo, chMat);
  sChargerMesh.visible = false;
  sScene.add(sChargerMesh);

  // Cube — green wireframe
  var cubeGeo = new THREE.BoxGeometry(44, 44, 44);
  var cubeMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true, transparent: true, opacity: 0.5 });
  sCubeMesh = new THREE.Mesh(cubeGeo, cubeMat);
  sCubeMesh.visible = false;
  sScene.add(sCubeMesh);

  // NavMap floor plane (textured from 2D canvas)
  var navFloorGeo = new THREE.PlaneGeometry(1, 1);
  var navFloorMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, side: THREE.DoubleSide });
  sNavFloorMesh = new THREE.Mesh(navFloorGeo, navFloorMat);
  sNavFloorMesh.rotation.x = -Math.PI / 2; // lay flat
  sNavFloorMesh.position.y = 0.5;
  sNavFloorMesh.visible = false;
  sScene.add(sNavFloorMesh);

  // Cliff markers group (raised orange walls at cliff edges)
  sCliffGroup = new THREE.Group();
  sScene.add(sCliffGroup);

  // Ambient light
  sScene.add(new THREE.AmbientLight(0xffffff, 0.5));

  // Trail line
  var trailGeo = new THREE.BufferGeometry();
  var trailMat = new THREE.LineBasicMaterial({ color: 0x00cccc, transparent: true, opacity: 0.5 });
  sTrailLine = new THREE.Line(trailGeo, trailMat);
  sScene.add(sTrailLine);
}

function renderSensor3DLoop() {
  if (!sensorStreamRunning) return;
  if (sRenderer && sScene && sCamera) {
    sRenderer.render(sScene, sCamera);
  }
  s3DAnimFrameId = requestAnimationFrame(renderSensor3DLoop);
}

// Quaternion conversion: Vector (Z-up) -> Three.js (Y-up)
// Same as cube.js vecQuatToThree
function sVecQuatToThree(q0, q1, q2, q3) {
  return new THREE.Quaternion(q1, q3, -q2, q0);
}

function updateSensor3D(d) {
  if (!sRobotMesh || !window.THREE) return;

  // Mapping: Three(x, y, z) = Vector(x, z, -y)
  sRobotMesh.position.set(d.robot_x, (d.robot_z || 0) + 25, -(d.robot_y || 0));

  // Robot rotation — use quaternion if available, fallback to yaw
  var hasQuat = (d.robot_q0 !== 0 || d.robot_q1 !== 0 || d.robot_q2 !== 0 || d.robot_q3 !== 0);
  if (hasQuat) {
    sRobotMesh.setRotationFromQuaternion(sVecQuatToThree(d.robot_q0, d.robot_q1, d.robot_q2, d.robot_q3));
  } else {
    sRobotMesh.rotation.set(0, d.robot_angle_rad || 0, 0);
  }

  // Charger — when charging, robot position IS charger position (strongest signal)
  if (d.is_charging) {
    sChargerMesh.visible = true;
    sChargerMesh.position.set(d.robot_x, 4, -(d.robot_y || 0));
    sChargerMesh.material.opacity = 0.6;
  } else if (d.charger_visible) {
    sChargerMesh.visible = true;
    sChargerMesh.position.set(d.charger_x, 4, -(d.charger_y || 0));
    sChargerMesh.material.opacity = 0.3; // dimmer — position may be stale
  } else {
    sChargerMesh.visible = false;
  }

  // Cube
  if (d.cube_visible) {
    sCubeMesh.visible = true;
    sCubeMesh.position.set(d.cube_x, (d.cube_z || 0) + 22, -(d.cube_y || 0));
  } else {
    sCubeMesh.visible = false;
  }

  // Trail
  sTrail.push(new THREE.Vector3(d.robot_x, 1, -(d.robot_y || 0)));
  if (sTrail.length > 200) sTrail.shift();
  if (sTrailLine && sTrail.length > 1) {
    var geo = new THREE.BufferGeometry().setFromPoints(sTrail);
    sTrailLine.geometry.dispose();
    sTrailLine.geometry = geo;
  }

  // Camera follows robot loosely
  var targetX = d.robot_x || 0;
  var targetZ = -(d.robot_y || 0);
  sCamera.position.x += (targetX + 200 - sCamera.position.x) * 0.02;
  sCamera.position.z += (targetZ + 300 - sCamera.position.z) * 0.02;
  sCamera.lookAt(targetX, 0, targetZ);
}

// ============= HELPERS =============

function setText(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = (val !== undefined && val !== null) ? val : "-";
}

function ff(val) {
  return (val || 0).toFixed(1);
}
