#!/bin/bash
# Wire-Pod start script for macOS
# Publishes wirepod.local via mDNS so robot finds us automatically

cd "$(dirname "$0")/chipper"
source source.sh

export DYLD_LIBRARY_PATH="$HOME/.vosk/libvosk:$DYLD_LIBRARY_PATH"
export CGO_ENABLED=1
export CGO_CFLAGS="-I$HOME/.vosk/libvosk"
export CGO_LDFLAGS="-L$HOME/.vosk/libvosk -lvosk -ldl -lpthread"

MAC_IP=$(ipconfig getifaddr en0 2>/dev/null)

# Publish wirepod.local via mDNS (so robot can find us)
echo "Publishing wirepod.local -> $MAC_IP via mDNS..."
dns-sd -P "Wire-Pod" _wirepod._tcp local 443 wirepod.local "$MAC_IP" &
MDNS_PID=$!

# Clean up mDNS on exit
cleanup() {
    echo ""
    echo "Stopping mDNS advertisement..."
    kill $MDNS_PID 2>/dev/null
    wait $MDNS_PID 2>/dev/null
    exit 0
}
trap cleanup EXIT INT TERM

echo ""
echo "========================================="
echo "  Wire-Pod is starting..."
echo "  Web UI:  http://$MAC_IP:8080"
echo "  Chipper: wirepod.local:443"
echo "========================================="
echo ""

./chipper
