// Status Bar — ported from WirePod.app Swift wrapper
// Self-injecting: include this script on any page and the bar appears.

// Fallback getBatteryPercentage if battery.js not loaded
if (typeof getBatteryPercentage === 'undefined') {
  window.getBatteryPercentage = function(v) {
    if (!v) return 70;
    if (v >= 4.1) return 100;
    if (v >= 3.85) return 80 + 20 * Math.log10(1 + ((v-3.85)/0.25) * 9);
    if (v >= 3.5) return 80 * Math.log10(1 + ((v-3.5)/0.35) * 9);
    return 0;
  };
}

(function() {
  // Inject HTML
  var bar = document.createElement('div');
  bar.id = 'wpStatusBar';
  bar.innerHTML =
    '<div class="sb-group">' +
      '<span class="sb-dot green" id="sbServerDot"></span>' +
      '<span class="sb-val" id="sbServerLabel">Wire-Pod</span>' +
      '<span class="sb-label" id="sbUptime">--</span>' +
    '</div>' +
    '<div class="sb-group">' +
      '<div class="sb-sep"></div>' +
      '<span class="sb-dot gray" id="sbRobotDot"></span>' +
      '<span class="sb-val" id="sbRobotESN">--</span>' +
      '<span class="sb-label" id="sbRobotIP"></span>' +
      '<div class="sb-sep"></div>' +
      '<span class="sb-batt" id="sbBattery">--</span>' +
      '<span class="sb-label" id="sbVoltage"></span>' +
      '<span class="sb-charging" id="sbCharging"></span>' +
      '<div class="sb-sep"></div>' +
      '<div class="sb-wifi" id="sbWifi" title="WiFi RSSI">' +
        '<div class="sb-wifi-bar" style="height:3px"></div>' +
        '<div class="sb-wifi-bar" style="height:6px"></div>' +
        '<div class="sb-wifi-bar" style="height:9px"></div>' +
        '<div class="sb-wifi-bar" style="height:12px"></div>' +
      '</div>' +
      '<span class="sb-label" id="sbWifiDb"></span>' +
    '</div>' +
    '<div class="sb-group">' +
      '<button class="sb-btn" onclick="location.reload()" title="Reload page"><i class="fa-solid fa-rotate-right"></i></button>' +
      '<button class="sb-btn danger" onclick="wpRestartServer()" title="Restart server"><i class="fa-solid fa-power-off"></i></button>' +
    '</div>';
  document.body.insertBefore(bar, document.body.firstChild);

  var _serial = null;

  function fmt(s) {
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
    return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
  }

  function setWifiBars(rssi) {
    // rssi is negative dBm, e.g. -45 = excellent, -80 = poor
    var bars = document.querySelectorAll('#sbWifi .sb-wifi-bar');
    var level = 0;
    if (rssi > -50) level = 4;
    else if (rssi > -60) level = 3;
    else if (rssi > -70) level = 2;
    else if (rssi > -85) level = 1;
    for (var i = 0; i < bars.length; i++) {
      bars[i].className = 'sb-wifi-bar' + (i < level ? ' active' : '');
    }
    document.getElementById('sbWifiDb').textContent = rssi ? (rssi + 'dB') : '';
  }

  async function pollServer() {
    try {
      var r = await fetch('/api-sdk/server_status');
      var d = await r.json();
      document.getElementById('sbUptime').textContent = fmt(d.uptime_sec);
      document.getElementById('sbServerDot').className = 'sb-dot green';

      var hasActive = d.robots && d.robots.length > 0;
      if (hasActive) {
        _serial = d.robots[0].esn;
        document.getElementById('sbRobotESN').textContent = _serial;
        document.getElementById('sbRobotIP').textContent = d.robots[0].ip;
        document.getElementById('sbRobotDot').className = 'sb-dot green';
      }
      // Discover from config if no active connection
      if (!_serial) {
        try {
          var info = await fetch('/api-sdk/get_sdk_info');
          var sd = await info.json();
          if (sd.robots && sd.robots.length > 0) {
            _serial = sd.robots[0].esn;
            document.getElementById('sbRobotESN').textContent = _serial;
            document.getElementById('sbRobotIP').textContent = sd.robots[0].ip_address;
            document.getElementById('sbRobotDot').className = 'sb-dot yellow';
          }
        } catch(e2) {}
      }
      if (!_serial) {
        document.getElementById('sbRobotESN').textContent = '--';
        document.getElementById('sbRobotIP').textContent = '';
        document.getElementById('sbRobotDot').className = 'sb-dot gray';
        document.getElementById('sbBattery').textContent = '--';
        document.getElementById('sbVoltage').textContent = '';
        document.getElementById('sbCharging').textContent = '';
        setWifiBars(null);
      }

      // WiFi RSSI (if endpoint available)
      if (d.wifi_rssi) setWifiBars(d.wifi_rssi);

    } catch(e) {
      document.getElementById('sbServerDot').className = 'sb-dot red';
      document.getElementById('sbUptime').textContent = 'offline';
    }
  }

  async function pollBatt() {
    if (!_serial) return;
    try {
      var r = await fetch('/api-sdk/get_battery?serial=' + _serial, {
        method: 'POST', signal: AbortSignal.timeout(10000)
      });
      var d = await r.json();
      var pct = typeof getBatteryPercentage === 'function'
        ? getBatteryPercentage(d.battery_volts) : '?';
      var el = document.getElementById('sbBattery');
      el.textContent = pct + '%';
      el.className = 'sb-batt' + (pct < 20 ? ' low' : pct < 50 ? ' mid' : '');
      document.getElementById('sbVoltage').textContent =
        d.battery_volts ? d.battery_volts.toFixed(2) + 'V' : '';
      document.getElementById('sbCharging').textContent =
        d.is_on_charger_platform ? '\u26A1' : '';
      document.getElementById('sbRobotDot').className = 'sb-dot green';
    } catch(e) {
      document.getElementById('sbRobotDot').className = 'sb-dot yellow';
      document.getElementById('sbBattery').textContent = '??';
    }
  }

  pollServer(); pollBatt();
  setInterval(pollServer, 10000);
  setInterval(pollBatt, 15000);
})();

function wpRestartServer() {
  if (!confirm('Restart Wire-Pod server?')) return;
  fetch('/api-sdk/restart_server').then(function() {
    document.getElementById('sbServerDot').className = 'sb-dot yellow';
    document.getElementById('sbUptime').textContent = 'restarting...';
    setTimeout(function() { location.reload(); }, 3000);
  }).catch(function() {});
}
