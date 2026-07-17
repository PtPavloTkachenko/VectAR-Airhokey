"""Vector RTS BLE onboarding (Mac-native, bleak + pynacl).

wire-pod's Go BLE stack is linux-only (its darwin backend is dead), so VectAR
does the BLE onboarding natively in Python here, and leaves cert/token minting
to the vendored wire-pod engine (which runs fine on macOS).

Protocol reversed in docs/vector-ble-protocol.md; ground-truth cross-checked
against wire-pod's setup/ble.go + the digital-dream-labs/vector-bluetooth Go
library.
"""
