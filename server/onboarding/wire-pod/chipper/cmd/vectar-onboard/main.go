// vectar-onboard — VectAR Air-Hockey's trimmed wire-pod entry point.
//
// This is the ONLY file VectAR adds to the vendored wire-pod tree. It boots
// wire-pod's real onboarding engine (BLE pairing, Wi-Fi provisioning, cert
// generation, /session-certs, and the jdocs + token servers used to mint the
// SDK guid) but supplies a NO-OP speech-to-text backend, so none of the heavy
// voice models (vosk/whisper) are needed. The VectAR game server launches this
// binary and drives its HTTP APIs from its own web console.
//
// wire-pod © Kerigan Creighton, MIT — see ../../LICENSE. When updating the
// vendored wire-pod, re-add this single file (see ../../../VENDOR.md).
package main

import (
	"github.com/kercre123/wire-pod/chipper/pkg/initwirepod"
	sr "github.com/kercre123/wire-pod/chipper/pkg/wirepod/speechrequest"
)

// no-op STT: onboarding never processes voice, so we never load a model.
func sttInit() error { return nil }

func sttHandler(req sr.SpeechRequest) (string, error) { return "", nil }

func main() {
	initwirepod.StartFromProgramInit(sttInit, sttHandler, "none")
}
