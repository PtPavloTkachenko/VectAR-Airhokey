package processreqs

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/kercre123/wire-pod/chipper/pkg/logger"
	"github.com/kercre123/wire-pod/chipper/pkg/vars"
	sr "github.com/kercre123/wire-pod/chipper/pkg/wirepod/speechrequest"
)

// RouteSTT routes to the configured STT provider
func RouteSTT(req sr.SpeechRequest) (string, error) {
	switch vars.APIConfig.STT.TranscribeWith {
	case "gemini":
		return geminiAudioSTT(req)
	default:
		return sttHandler(req)
	}
}

// geminiAudioSTT uses Google Gemini for audio transcription
func geminiAudioSTT(req sr.SpeechRequest) (string, error) {
	logger.Println("(Bot " + req.Device + ", Gemini Audio) Processing...")

	// Read audio until end of speech
	req.DetectEndOfSpeech()
	for {
		_, err := req.GetNextStreamChunk()
		if err != nil {
			return "", err
		}
		speechIsDone, _ := req.DetectEndOfSpeech()
		if speechIsDone {
			break
		}
	}

	if len(req.DecodedMicData) == 0 {
		return "", fmt.Errorf("no audio data captured")
	}

	// Convert PCM to WAV for Gemini
	wavData := pcmToWAV(req.DecodedMicData, 16000, 16, 1)

	// Get API key and model from Knowledge config
	apiKey := vars.APIConfig.Knowledge.Key
	if apiKey == "" {
		return "", fmt.Errorf("Google API key not configured")
	}
	model := vars.APIConfig.Knowledge.Model
	if model == "" {
		model = "gemini-2.0-flash"
	}

	transcribed, err := callGeminiAudioSTT(wavData, apiKey, model)
	if err != nil {
		return "", err
	}

	transcribed = strings.ToLower(strings.TrimSpace(transcribed))
	logger.Println("Bot " + req.Device + " Gemini transcribed: " + transcribed)
	return transcribed, nil
}

// pcmToWAV converts raw PCM bytes to WAV format
func pcmToWAV(pcm []byte, sampleRate, bitsPerSample, channels int) []byte {
	dataSize := len(pcm)
	byteRate := sampleRate * channels * bitsPerSample / 8
	blockAlign := channels * bitsPerSample / 8

	buf := new(bytes.Buffer)
	buf.WriteString("RIFF")
	binary.Write(buf, binary.LittleEndian, uint32(36+dataSize))
	buf.WriteString("WAVE")
	buf.WriteString("fmt ")
	binary.Write(buf, binary.LittleEndian, uint32(16))
	binary.Write(buf, binary.LittleEndian, uint16(1))
	binary.Write(buf, binary.LittleEndian, uint16(channels))
	binary.Write(buf, binary.LittleEndian, uint32(sampleRate))
	binary.Write(buf, binary.LittleEndian, uint32(byteRate))
	binary.Write(buf, binary.LittleEndian, uint16(blockAlign))
	binary.Write(buf, binary.LittleEndian, uint16(bitsPerSample))
	buf.WriteString("data")
	binary.Write(buf, binary.LittleEndian, uint32(dataSize))
	buf.Write(pcm)

	return buf.Bytes()
}

// callGeminiAudioSTT sends audio to Gemini API for transcription
func callGeminiAudioSTT(wavData []byte, apiKey, model string) (string, error) {
	endpoint := vars.APIConfig.Knowledge.Endpoint
	if endpoint == "" {
		endpoint = "https://generativelanguage.googleapis.com/v1beta"
	}

	url := fmt.Sprintf("%s/models/%s:generateContent?key=%s",
		strings.TrimRight(endpoint, "/"), model, apiKey)

	audioB64 := base64.StdEncoding.EncodeToString(wavData)

	sttLang := vars.APIConfig.STT.Language
	if sttLang == "" {
		sttLang = "en-US"
	}
	langName := sttLang
	switch {
	case strings.HasPrefix(sttLang, "en"):
		langName = "English"
	case strings.HasPrefix(sttLang, "uk"):
		langName = "Ukrainian"
	case strings.HasPrefix(sttLang, "ru"):
		langName = "Russian"
	case strings.HasPrefix(sttLang, "de"):
		langName = "German"
	case strings.HasPrefix(sttLang, "fr"):
		langName = "French"
	case strings.HasPrefix(sttLang, "es"):
		langName = "Spanish"
	case strings.HasPrefix(sttLang, "it"):
		langName = "Italian"
	case strings.HasPrefix(sttLang, "pt"):
		langName = "Portuguese"
	case strings.HasPrefix(sttLang, "zh"):
		langName = "Chinese"
	case strings.HasPrefix(sttLang, "ko"):
		langName = "Korean"
	case strings.HasPrefix(sttLang, "pl"):
		langName = "Polish"
	case strings.HasPrefix(sttLang, "tr"):
		langName = "Turkish"
	case strings.HasPrefix(sttLang, "vi"):
		langName = "Vietnamese"
	case strings.HasPrefix(sttLang, "nl"):
		langName = "Dutch"
	}

	body := map[string]interface{}{
		"contents": []map[string]interface{}{
			{
				"parts": []map[string]interface{}{
					{
						"inline_data": map[string]interface{}{
							"mime_type": "audio/wav",
							"data":     audioB64,
						},
					},
					{
						"text": "Transcribe this audio exactly as spoken in " + langName + ". Return ONLY the transcribed text, nothing else. No quotes, no explanations.",
					},
				},
			},
		},
		"generationConfig": map[string]interface{}{
			"temperature":     0.0,
			"maxOutputTokens": 256,
		},
	}

	jsonBody, err := json.Marshal(body)
	if err != nil {
		return "", err
	}

	httpReq, err := http.NewRequest("POST", url, bytes.NewReader(jsonBody))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("gemini audio API error: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("gemini audio API error %d: %s", resp.StatusCode, string(respBody))
	}

	var gemResp struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}

	if err := json.Unmarshal(respBody, &gemResp); err != nil {
		return "", fmt.Errorf("gemini audio parse error: %w", err)
	}

	if len(gemResp.Candidates) == 0 || len(gemResp.Candidates[0].Content.Parts) == 0 {
		return "", fmt.Errorf("gemini returned no transcription")
	}

	return gemResp.Candidates[0].Content.Parts[0].Text, nil
}
