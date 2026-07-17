/**
 * LLMProxy — the lens as the Mac game-server's Gemini TRANSPORT, through the
 * Remote Service Gateway (Bring-Alive token, NO Mac API key). Same mechanic as
 * vector-sense-515 / the VectAR brain, slimmed to the one-shot path:
 *
 *   server --llm_request{req,system,contents}--> LLMProxy --> RSG Gemini.models()
 *          <--llm_response{req,text}--                     <--
 *
 * All thinking stays on the Mac; the lens only carries the request to Gemini.
 * Wire: GameController news one LLMProxy(ws), then routes incoming "llm_request".
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger";
import { GoogleGenAI } from "RemoteServiceGateway.lspkg/HostedExternal/GoogleGenAI";
import {
  AvaliableApiTypes,
  RemoteServiceGatewayCredentials,
} from "RemoteServiceGateway.lspkg/RemoteServiceGatewayCredentials";
import { GameConfig } from "./GameConfig";
import { WSClient } from "./WSClient";

const log = new NativeLogger("LLMProxy");

export class LLMProxy {
  constructor(private ws: WSClient) {
    // RSG 2.0.0 BUG: setApiToken() only implements the Snap case — Google/OpenAI
    // fall through as no-ops, so googleToken stays "" ("api-token cannot be empty").
    RemoteServiceGatewayCredentials.setApiToken(
      AvaliableApiTypes.Google, GameConfig.RSG_GOOGLE_TOKEN);   // no-op in 2.0.0 (kept for older RSG)
    // The real fix: set the static that getApiToken reads (what the Credentials
    // component sets on onAwake). private-static is compile-time only -> cast through any.
    (RemoteServiceGatewayCredentials as any).googleToken = GameConfig.RSG_GOOGLE_TOKEN;
    log.i("RSG transport armed (" + GameConfig.LLM_MODEL + ")");
  }

  /** server -> Gemini. m = {req, model?, system?, contents:[{role,text}],
   *  temperature?, maxTokens?} */
  onLlmRequest(m: any) {
    const req = m.req;
    const contents: any[] = [];
    for (const c of m.contents || []) {
      if (c.text) {
        contents.push({ role: c.role || "user", parts: [{ text: c.text }] });
      }
    }
    if (contents.length === 0) {
      this.ws.sendJson({ t: "llm_response", req, error: "empty_request" });
      return;
    }
    const body: any = {
      contents,
      generationConfig: {
        temperature: m.temperature !== undefined ? m.temperature : 0.85,
        maxOutputTokens: m.maxTokens || 40,
        thinkingConfig: { thinkingBudget: 0 }, // no chain-of-thought = low latency
      },
    };
    if (m.system) {
      body.systemInstruction = { parts: [{ text: m.system }] };
    }
    GoogleGenAI.Gemini.models({
      model: m.model || GameConfig.LLM_MODEL,
      type: "generateContent",
      body,
    })
      .then((response: any) => {
        const parts = response?.candidates?.[0]?.content?.parts || [];
        let text = "";
        for (const p of parts) {
          if (p.text) { text += p.text + " "; }
        }
        log.i("llm " + req + " -> " + text.trim());
        this.ws.sendJson({ t: "llm_response", req, text: text.trim() });
      })
      .catch((error: any) => {
        log.w("llm " + req + " failed: " + error);
        this.ws.sendJson({ t: "llm_response", req, error: "" + error });
      });
  }
}
