/**
 * VoiceTalk — the glasses mic for the in-game chat. Keeps one ASR session open
 * while the game runs; every silence-finalized phrase is sent to the server as
 * {t:"utter", text}. The server asks Gemini (via LLMProxy/RSG) and Vector replies
 * with his onboard voice. ASR pattern lifted verbatim from vector-sense-515.
 *
 * Wire: GameController does `this.voice = new VoiceTalk(this.ws)` and calls
 * `this.voice.tick(dt)` every frame. Device-only (editor substitutes canned lines).
 * NOTE: an open ASR session suspends camera frames — with YOLO vision-fix ON you
 * need Extended Permissions (Project Settings). Fine for this local demo lens.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger";
import { WSClient } from "./WSClient";
import { GameConfig } from "./GameConfig";

const log = new NativeLogger("VoiceTalk");

const CANNED = [
  "hey vector how are you",
  "what do you see around you",
  "tell me something fun",
];

export class VoiceTalk {
  private asr: any = null;
  private isEditor = false;
  private open = false;
  private retryT = 0;
  private editorT = 0;
  private cannedIdx = 0;

  constructor(private ws: WSClient) {
    this.isEditor = global.deviceInfoSystem.isEditor();
    if (!this.isEditor) {
      try {
        this.asr = require("LensStudio:AsrModule");
      } catch (e) {
        log.w("AsrModule unavailable: " + e);
      }
    }
  }

  /** Call every frame. Keeps the ASR session alive; each finalized phrase -> utter. */
  tick(dt: number) {
    // Voice is active only when an RSG token is present (the single switch).
    if (!GameConfig.RSG_GOOGLE_TOKEN) {
      return;
    }
    if (this.isEditor) {
      this.editorT += dt;
      if (this.editorT > 30) {
        this.editorT = 0;
        this.send(CANNED[this.cannedIdx++ % CANNED.length]);
      }
      return;
    }
    if (!this.open) {
      this.retryT -= dt;
      if (this.retryT <= 0) {
        this.retryT = 4.0; // don't hammer restarts on persistent errors
        this.open = this.openSession();
      }
    }
  }

  private openSession(): boolean {
    if (!this.asr) {
      return false;
    }
    try {
      const o = (AsrModule as any).AsrTranscriptionOptions.create();
      o.silenceUntilTerminationMs = 900;
      o.mode = (AsrModule as any).AsrMode.HighAccuracy;
      o.onTranscriptionUpdateEvent.add((e: any) => {
        if (e.isFinal) {
          const t = (e.text || "").trim();
          if (t.length > 1) {
            this.send(t);
          }
        }
      });
      o.onTranscriptionErrorEvent.add((code: any) => {
        log.w("ASR error: " + code);
        this.open = false; // tick reopens after retryT
      });
      this.asr.startTranscribing(o);
      log.i("ASR listening");
      return true;
    } catch (e) {
      log.e("ASR start failed: " + e);
      return false;
    }
  }

  private send(text: string) {
    log.i("heard: " + text);
    this.ws.sendJson({ t: "utter", text });
  }
}
