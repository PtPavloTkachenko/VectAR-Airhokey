// Standalone Vector BLE Wi-Fi setup tool.
//
// Reuses wire-pod's built-in BLE onboarding (pkg/wirepod/setup) to:
//   1. scan for Vectors over Bluetooth LE,
//   2. pair with the PIN shown on Vector's face,
//   3. list the Wi-Fi networks Vector can see, and
//   4. join one with a password — all without touching connman by hand.
//
// Build (macOS has a CoreBluetooth backend, Linux uses HCI):
//   go build -tags inbuiltble -o vector-ble-setup ./cmd/blesetup
// Run near the robot, then open http://localhost:8090
package main

import (
	"fmt"
	"net/http"

	"github.com/kercre123/wire-pod/chipper/pkg/logger"
	botsetup "github.com/kercre123/wire-pod/chipper/pkg/wirepod/setup"
	"github.com/kercre123/wire-pod/chipper/pkg/vars"
)

const port = "8090"

func main() {
	// vars.Init sets up config paths the BLE handler reads (data dir etc.)
	vars.Init()

	// registers /api-ble/ — the real handler only when built with
	// -tags inbuiltble, otherwise a stub that reports BLE unavailable.
	botsetup.RegisterBLEAPI()

	http.HandleFunc("/", pageHandler)
	http.HandleFunc("/js/ble.js", jsHandler)

	logger.Println("Vector BLE Wi-Fi setup listening on :" + port)
	fmt.Println("\n  Vector BLE Wi-Fi Setup")
	fmt.Println("  ----------------------")
	fmt.Println("  1. Put Vector on the charger, double-press the button (a key appears).")
	fmt.Println("  2. Open http://localhost:" + port + " in a browser.")
	fmt.Println("  3. Scan -> pair with the PIN -> pick a Wi-Fi -> enter the password.\n")

	if err := http.ListenAndServe(":"+port, nil); err != nil {
		logger.Println("server error: " + err.Error())
	}
}

func jsHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript")
	http.ServeFile(w, r, "webroot/js/ble.js")
}

// Minimal host page: ble.js drives the whole flow into #botAuth. We provide
// the DOM anchors it expects and kick it off on load.
func pageHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, page)
}

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vector Wi-Fi Setup (BLE)</title>
<style>
  :root { --bg:#0f1411; --fg:#dff5e6; --accent:#58e07c; --card:#151d18; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    display:flex; justify-content:center; padding:32px 16px; }
  .wrap { width:100%; max-width:460px; }
  h1 { font-size:20px; letter-spacing:.5px; margin:0 0 4px; }
  .sub { color:#7fa886; font-size:13px; margin:0 0 20px; }
  #section-botauth { background:var(--card); border:1px solid #22302a;
    border-radius:12px; padding:20px; }
  #botAuth p { line-height:1.5; margin:8px 0; }
  button { background:var(--accent); color:#05140a; border:none;
    border-radius:8px; padding:10px 16px; font-size:14px; font-weight:600;
    cursor:pointer; margin:6px 6px 6px 0; }
  button:hover { filter:brightness(1.08); }
  input { background:#0b120e; color:var(--fg); border:1px solid #2c3e35;
    border-radius:8px; padding:10px 12px; font-size:15px; width:100%;
    margin:8px 0; }
  a { color:var(--accent); }
  .desc { color:#7fa886; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Vector Wi-Fi Setup</h1>
    <p class="sub">Configure Vector's Wi-Fi over Bluetooth — no companion app needed.</p>
    <div id="section-botauth">
      <div id="botAuth"></div>
      <div id="disconnectButton"></div>
    </div>
  </div>
<script src="/js/ble.js"></script>
<script>
  // ble.js expects these section ids to exist for its toggleSections helper;
  // stub the ones we don't render so it never throws, then start the flow.
  ["section-intents","section-log","section-version","section-uicustomizer"]
    .forEach(function(id){
      if(!document.getElementById(id)){
        var d=document.createElement("div"); d.id=id; d.style.display="none";
        document.body.appendChild(d);
      }
    });
  window.addEventListener("load", function(){ checkBLECapability(); });
</script>
</body>
</html>`
