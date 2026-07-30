/**
 * WSClient – WebSocket link to the Mac game bridge (port 8777).
 * Protocol: JSON text frames with discriminator `t` (see game_bridge/protocol.py).
 * Reconnects with backoff; exposes typed callbacks; app-level ping/pong.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger";
import { GameConfig } from "./GameConfig";

const log = new NativeLogger("WSClient");

export interface PoseMsg {
  t: "pose"; x: number; y: number; deg: number; vy: number; drv?: number;
  ts: number; seq: number;
  head?: number;   // head angle, radians
  lift?: number;   // lift height, mm
}

export class WSClient {
  private socket: WebSocket | null = null;
  private sendQueue: string[] = [];
  private backoffS = 1.0;
  private lastPingSentAt = 0;
  private lastPongAt = 0;
  private timeS = 0;
  public connected = false;

  // callbacks
  public onWelcome: (robot: string) => void = () => {};
  public onPose: (p: PoseMsg) => void = () => {};
  public onAnimDone: (name: string) => void = () => {};
  public onSay: (text: string) => void = () => {};
  public onDelocalized: (reason: string) => void = () => {};
  public onRelocalized: () => void = () => {};
  public onRobotStatus: (s: any) => void = () => {};
  public onDisconnected: () => void = () => {};
  public onLlmRequest: (m: any) => void = () => {};  // Gemini voice agent: carry req to RSG

  constructor(private internetModule: InternetModule) {}

  connect() {
    log.i("Connecting to " + GameConfig.WS_URL);
    try {
      this.socket = this.internetModule.createWebSocket(GameConfig.WS_URL);
    } catch (e) {
      log.e("createWebSocket failed: " + e);
      this.scheduleReconnect();
      return;
    }
    this.socket.onopen = () => {
      log.i("WS open");
      this.connected = true;
      this.backoffS = 1.0;
      this.lastPongAt = this.timeS;
      this.sendJson({ t: "hello", role: "lens", proto: 1 });
      while (this.sendQueue.length > 0) {
        this.socket!.send(this.sendQueue.shift()!);
      }
    };
    this.socket.onmessage = (event: WebSocketMessageEvent) => {
      if (typeof event.data !== "string") {
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      this.route(msg);
    };
    this.socket.onclose = () => {
      log.w("WS closed");
      this.handleDrop();
    };
    this.socket.onerror = () => {
      log.w("WS error");
      this.handleDrop();
    };
  }

  private route(msg: any) {
    switch (msg.t) {
      case "welcome":
        this.onWelcome(msg.robot);
        break;
      case "pose":
        this.onPose(msg as PoseMsg);
        break;
      case "say":
        this.onSay(msg.text);
        break;
      case "anim_done":
        this.onAnimDone(msg.name);
        break;
      case "relocalized":
        this.onRelocalized();
        break;
      case "delocalized":
        this.onDelocalized(msg.reason);
        break;
      case "robot_status":
        this.onRobotStatus(msg);
        break;
      case "pong":
        this.lastPongAt = this.timeS;
        break;
      case "llm_request":
        this.onLlmRequest(msg);
        break;
    }
  }

  private handleDrop() {
    const wasConnected = this.connected;
    this.connected = false;
    this.socket = null;
    if (wasConnected) {
      this.onDisconnected();
    }
    this.scheduleReconnect();
  }

  private reconnectAt = -1;
  private scheduleReconnect() {
    this.reconnectAt = this.timeS + this.backoffS;
    this.backoffS = Math.min(5.0, this.backoffS * 2);
  }

  /** Call every frame from the controller. */
  tick(dt: number) {
    this.timeS += dt;
    if (!this.connected) {
      if (this.reconnectAt >= 0 && this.timeS >= this.reconnectAt) {
        this.reconnectAt = -1;
        this.connect();
      }
      return;
    }
    if (this.timeS - this.lastPingSentAt > GameConfig.PING_INTERVAL_S) {
      this.lastPingSentAt = this.timeS;
      this.sendJson({ t: "ping", ts: this.timeS });
    }
    if (this.timeS - this.lastPongAt > GameConfig.PONG_TIMEOUT_S) {
      log.w("Pong timeout — dropping socket");
      try {
        this.socket?.close();
      } catch (e) { /* noop */ }
      this.handleDrop();
    }
  }

  sendJson(obj: any) {
    const text = JSON.stringify(obj);
    if (this.connected && this.socket) {
      try {
        this.socket.send(text);
      } catch (e) {
        log.w("send failed: " + e);
      }
    } else if (obj.t === "place_confirm" || obj.t === "event") {
      // queue only critical messages; puck/ping are ephemeral
      this.sendQueue.push(text);
    }
  }
}
