/**
 * IntroAssembler – nothing pops into existence: the circuit board ASSEMBLES
 * itself. Registered items animate in staggered — scale-pop with overshoot,
 * drop-from-above, or grow (draw-in). Objects are hidden until their cue.
 */
export type IntroMode = "pop" | "drop" | "grow";

interface Item {
  obj: SceneObject;
  delay: number;
  mode: IntroMode;
  dur: number;
  baseScale: vec3;
  basePos: vec3;
  started: boolean;
  done: boolean;
}

export class IntroAssembler {
  private items: Item[] = [];
  private t = -1; // -1 = idle

  add(obj: SceneObject, delay: number, mode: IntroMode, dur: number = 0.55) {
    this.items.push({
      obj, delay, mode, dur,
      baseScale: obj.getTransform().getLocalScale(),
      basePos: obj.getTransform().getLocalPosition(),
      started: false,
      done: false,
    });
  }

  /** Hide all registered items without starting the timeline (pre-intro). */
  hideAll() {
    for (const it of this.items) {
      it.obj.enabled = false;
    }
  }

  /** Hide everything and start the assembly timeline. */
  play() {
    for (const it of this.items) {
      it.started = false;
      it.done = false;
      it.obj.enabled = false;
    }
    this.t = 0;
  }

  get playing(): boolean {
    return this.t >= 0;
  }

  tick(dt: number) {
    if (this.t < 0) {
      return;
    }
    this.t += dt;
    let allDone = true;
    for (const it of this.items) {
      if (it.done) continue;
      allDone = false;
      const local = this.t - it.delay;
      if (local < 0) continue;
      if (!it.started) {
        it.started = true;
        it.obj.enabled = true;
      }
      const k = Math.min(1, local / it.dur);
      const tr = it.obj.getTransform();
      if (it.mode === "pop") {
        // 2D soft appear: smooth 0 -> 1, no overshoot (fade-in surrogate)
        const s = 1 - (1 - k) * (1 - k) * (1 - k);
        tr.setLocalScale(it.baseScale.uniformScale(Math.max(0.01, s)));
      } else if (it.mode === "drop") {
        // 3D: pure vertical descent from above its OWN position
        // (no scaling — grouped children would converge to the pivot)
        const e = 1 - (1 - k) * (1 - k) * (1 - k); // ease-out cubic
        const y = it.basePos.y + (1 - e) * 11;
        tr.setLocalPosition(new vec3(it.basePos.x, y, it.basePos.z));
      } else { // grow: draw in along local X
        const e = 1 - (1 - k) * (1 - k);
        tr.setLocalScale(new vec3(
          Math.max(0.01, it.baseScale.x * e), it.baseScale.y, it.baseScale.z));
      }
      if (k >= 1) {
        tr.setLocalScale(it.baseScale);
        tr.setLocalPosition(it.basePos);
        it.done = true;
      }
    }
    if (allDone) {
      this.t = -1;
    }
  }
}
