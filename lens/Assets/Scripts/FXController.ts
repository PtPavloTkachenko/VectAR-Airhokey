/**
 * FXController – SFX playback for game events. AudioComponents are created
 * in code on a dedicated child object; tracks come from GeneratedSFX WAVs
 * (portable: plain AudioComponent + requireAsset, no packages).
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger";

const log = new NativeLogger("FXController");

// hit_paddle + bounce_wall are GONE from the lens: collision sounds play
// FROM THE ROBOT (short on-robot Wwise clips over the bridge, DECISIONS #27)
const TRACKS = {
  goal_score: requireAsset("../GeneratedSFX/goal_score.wav") as AudioTrackAsset,
  goal_concede: requireAsset("../GeneratedSFX/goal_concede.wav") as AudioTrackAsset,
  countdown_blip: requireAsset("../GeneratedSFX/countdown_blip.wav") as AudioTrackAsset,
  game_win: requireAsset("../GeneratedSFX/game_win.wav") as AudioTrackAsset,
  cap_strike: requireAsset("../GeneratedSFX/cap_strike.wav") as AudioTrackAsset,
  puck_spawn: requireAsset("../GeneratedSFX/puck_spawn.wav") as AudioTrackAsset,
  button_press: requireAsset("../GeneratedSFX/button_press.wav") as AudioTrackAsset,
  mallet_grab: requireAsset("../GeneratedSFX/mallet_grab.wav") as AudioTrackAsset,
  ui_on: requireAsset("../GeneratedSFX/ui_on.wav") as AudioTrackAsset,
  wall_zap: requireAsset("../GeneratedSFX/wall_zap.wav") as AudioTrackAsset,
};

const MUSIC = requireAsset("../GeneratedSFX/bg_music_loop.wav") as AudioTrackAsset;

export type SfxName = keyof typeof TRACKS;

// rapid-fire sounds get 2 components so overlapping plays don't cut off
// (Phone Defense AudioController pattern)
const POOL_SIZES: { [k: string]: number } = {
  wall_zap: 2, cap_strike: 2, countdown_blip: 2,
};

export class FXController {
  private components: Map<SfxName, AudioComponent[]> = new Map();
  private rr: Map<SfxName, number> = new Map();
  private music: AudioComponent | null = null;
  private musicTarget = 0;
  private musicVol = 0;

  constructor(parent: SceneObject) {
    // PREFER the editor-authored AudioBank (scene-built components play
    // reliably; runtime-created ones were silent in the 5.22 preview)
    let bank: SceneObject | null = null;
    for (let i = 0; i < parent.getChildrenCount(); i++) {
      if (parent.getChild(i).name === "AudioBank") {
        bank = parent.getChild(i);
        break;
      }
    }
    if (bank) {
      const byName: Map<string, AudioComponent> = new Map();
      for (let i = 0; i < bank.getChildrenCount(); i++) {
        const ch = bank.getChild(i);
        const comp = ch.getComponent(
          "Component.AudioComponent") as AudioComponent;
        if (comp) {
          byName.set(ch.name, comp);
        }
      }
      for (const name of Object.keys(TRACKS) as SfxName[]) {
        const pool: AudioComponent[] = [];
        const a = byName.get("sfx_" + name);
        const b = byName.get("sfx_" + name + "_2");
        if (a) { pool.push(a); }
        if (b) { pool.push(b); }
        this.components.set(name, pool);
        this.rr.set(name, 0);
      }
      this.music = byName.get("music_bg") || null;
      log.i("SFX from scene AudioBank (" + byName.size + " components)");
      return;
    }
    log.e("AudioBank missing in scene — no audio!");
  }

  playMusic(volume: number = 0.35) {
    if (this.music) {
      this.musicTarget = volume;
      this.musicVol = 0;
      this.music.volume = 0;
      this.music.play(-1); // seamless loop, fades in via tick()
    }
  }

  /** Music volume ramp (call from the game's update). */
  tick(dt: number) {
    if (this.music && this.musicVol < this.musicTarget) {
      this.musicVol = Math.min(this.musicTarget, this.musicVol + dt * 0.16);
      this.music.volume = this.musicVol;
    }
  }

  stopMusic() {
    this.music?.stop(false);
  }

  /** Min interval per sound (s) — rapid gameplay must not machine-gun. */
  private static COOLDOWN: { [k: string]: number } = {
    wall_zap: 0.25,
    cap_strike: 0.2, ui_on: 0.3, mallet_grab: 0.4,
    countdown_blip: 0.2, button_press: 0.3,
  };
  private lastPlay: Map<string, number> = new Map();
  private nowS = 0;

  /** call from GameController.update — powers the cooldowns */
  tickTime(dt: number) {
    this.nowS += dt;
  }

  play(name: SfxName, volume: number = 1.0) {
    const pool = this.components.get(name);
    if (!pool || pool.length === 0) {
      return;
    }
    const cd = FXController.COOLDOWN[name] || 0.08;
    const last = this.lastPlay.get(name) || -99;
    if (this.nowS - last < cd) {
      return; // spam-guard: drop the extra trigger
    }
    this.lastPlay.set(name, this.nowS);
    const idx = (this.rr.get(name) || 0) % pool.length;
    this.rr.set(name, idx + 1);
    try {
      const comp = pool[idx];
      comp.volume = volume;
      comp.play(1);
    } catch (e) {
      log.w("play " + name + " failed: " + e);
    }
  }
}
