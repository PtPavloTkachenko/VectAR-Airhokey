/**
 * ScoreUI v2 – everything lies ON the field plane like PCB silkscreen print:
 * - score digits + labels flat past Vector's goal line (readable from player)
 * - status line flat on the player's near edge
 * - START / REPLAY buttons: glow plates slightly extruded above the surface
 *   with flat labels; pressed by pinching over them (hit-test by field rect)
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger";
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { GameConfig } from "./GameConfig";
import { GlowKit } from "./GlowKit";

const log = new NativeLogger("ScoreUI");

const MM = 0.1;

interface PlaneButton {
  root: SceneObject;
  plate: SceneObject | null;
  glowParts: SceneObject[];
  cxMm: number;
  cyMm: number;
  halfWMm: number;
  halfHMm: number;
  onPress: () => void;
  cooldown: number;
  pressT: number;
  lit: boolean;
  armed: boolean;
}

export class ScoreUI {
  private scoreText: Text;
  private statusText: Text;
  private labelText: Text;
  private popT = 1.0;
  private buttons: PlaneButton[] = [];

  constructor(private fieldRoot: SceneObject, private glow: GlowKit,
              chipModel: ObjectPrefab | undefined,
              private font: Font | undefined,
              private builder: any,
              private buttonModel?: ObjectPrefab) {
    const hl = (GameConfig.FIELD_L / 2) * MM;

    // --- score block: on a 3D CHIP GAUGE at the field side ---
    const hw = (GameConfig.FIELD_W / 2) * MM;
    const chipPos = new vec3(0, 0, -(hw + 7)); // opposite field center
    if (chipModel) {
      const chip = chipModel.instantiate(this.fieldRoot);
      chip.name = "ScoreChip";
      chip.getTransform().setLocalPosition(
        new vec3(chipPos.x, -0.13, chipPos.z)); // pins touch the board
      // GLB prefabs carry a root scale of 100 — normalize (1 unit = 1 cm)
      chip.getTransform().setLocalScale(new vec3(0.55, 0.55, 0.55));
      // long side ACROSS the player's view (player is opposite Vector)
      chip.getTransform().setLocalRotation(
        quat.angleAxis(Math.PI / 2, vec3.up()));

      // chip Y-up from Blender Z-up handled by GLB exporter (export_yup)
      if (builder && builder.materializeChip) {
        builder.materializeChip(chip);
      }
    }
    const scorePanel = this.flatTextObject(
      "ScoreBlock", new vec3(chipPos.x, 0.75, chipPos.z));
    this.labelText = this.addText(scorePanel, "LabelText",
      new vec3(0, -1.05, 0), 13, new vec3(0.25, 1, 0.45));
    this.labelText.text = "YOU   :   VECTOR";
    this.scoreText = this.addText(scorePanel, "ScoreText",
      new vec3(0, 0, 0), 46, new vec3(0.45, 1, 0.55));
    this.scoreText.text = "0 : 0";

    // --- status line: flat, near edge on the player side ---
    const statusPanel = this.flatTextObject(
      "StatusBlock", new vec3(chipPos.x, 0.75, chipPos.z));
    this.statusText = this.addText(statusPanel, "StatusText",
      new vec3(0, 1.12, 0), 12, new vec3(0.85, 1, 0.9));
    this.statusText.text = "";
  }

  /** Object lying on the plane; +z of local = toward player reading side. */
  private flatTextObject(name: string, pos: vec3): SceneObject {
    const obj = global.scene.createSceneObject(name);
    obj.setParent(this.fieldRoot);
    const tr = obj.getTransform();
    tr.setLocalPosition(pos);
    // lay flat on the plane, text top pointing AWAY from the player
    // (+X) so the player reads it upright
    // flat on the board, reads correctly from the player side
    // (empirical winner of the 4-way lookAt sweep — candidate B)
    tr.setLocalRotation(quat.lookAt(new vec3(0, 1, 0), new vec3(1, 0, 0)));
    return obj;
  }

  private addText(parent: SceneObject, name: string, localPos: vec3,
                  size: number, rgb: vec3): Text {
    const obj = global.scene.createSceneObject(name);
    obj.setParent(parent);
    obj.getTransform().setLocalPosition(localPos);
    const t = obj.createComponent("Component.Text") as Text;
    t.size = size;
    t.textFill.color = new vec4(rgb.x, rgb.y, rgb.z, 1);
    if (this.font) {
      t.font = this.font; // VT323 — CRT lamp display vibe
    }
    return t;
  }

  /** Extruded glow-plate button on the plane. w/h in cm, pos in field mm. */
  addButton(name: string, label: string, cxMm: number, cyMm: number,
            onPress: () => void): PlaneButton {
    const root = global.scene.createSceneObject("Btn" + name);
    root.setParent(this.fieldRoot);
    const local = new vec3(cxMm * MM, 0, -cyMm * MM);
    root.getTransform().setLocalPosition(local);

    const w = 11, h = 7;
    // the BUTTON ITSELF is the light: its glow parts toggle with lit state
    const plate: SceneObject | null = null;
    const glowParts: SceneObject[] = [];
    if (this.buttonModel) {
      const btn3d = this.buttonModel.instantiate(root);
      btn3d.name = name + "Btn3D";
      btn3d.getTransform().setLocalScale(new vec3(1, 1, 1)); // GLB root x100
      if (this.builder && this.builder.materializeChip) {
        this.builder.materializeChip(btn3d);
      }
      const collect = (o: SceneObject) => {
        if (o.name.indexOf("glow_") === 0) {
          glowParts.push(o); // dim = ring off; solid cap stays VISIBLE
        }
        for (let i = 0; i < o.getChildrenCount(); i++) {
          collect(o.getChild(i));
        }
      };
      collect(btn3d);
    }
    const textObj = global.scene.createSceneObject(name + "Label");
    textObj.setParent(root);
    const ttr = textObj.getTransform();
    ttr.setLocalPosition(new vec3(0, 2.14, 0)); // flush with the cap top
    const btnLie = quat.angleAxis(-Math.PI / 2, vec3.right());
    const btnYaw = quat.lookAt(new vec3(0, 1, 0), new vec3(1, 0, 0)); // same as chip text
    ttr.setLocalRotation(btnYaw);
    const t = textObj.createComponent("Component.Text") as Text;
    if (this.font) {
      t.font = this.font; // VT323 — analog CRT look, same as the display
    }
    t.text = label;
    t.size = 42;
    t.textFill.color = new vec4(0.45, 1, 0.55, 1); // phosphor green

    // REAL SIK interactable: works with DIRECT (poke/pinch near) and
    // INDIRECT (ray + pinch) out of the box
    const col = root.createComponent("Physics.ColliderComponent") as ColliderComponent;
    const shape = Shape.createBoxShape();
    shape.size = new vec3(7, 4, 7);
    col.shape = shape;
    col.fitVisual = false;


    const btn: PlaneButton = {
      root, plate, glowParts, cxMm, cyMm,
      halfWMm: (w / 2) * 100 / 10, // cm -> mm
      halfHMm: (h / 2) * 100 / 10,
      onPress, cooldown: 0, pressT: 99, lit: false, armed: false,
    };
    this.buttons.push(btn);
    root.enabled = false;
    return btn;
  }

  private pressFromInteractable(name: string) {
    for (const b of this.buttons) {
      if (b.root.name === "Btn" + name && b.root.enabled && b.lit
          && b.cooldown <= 0) {
        b.cooldown = 1.0;
        b.pressT = 0;
        this.setButtonLit(b, true);
        log.i("Button pressed (interactable)");
        b.onPress();
        return;
      }
    }
  }

  setButtonVisible(btn: PlaneButton, visible: boolean) {
    btn.root.enabled = visible;
  }

  /** lit = the button's own glow ring + cap shine; dim = they go dark */
  setButtonLit(btn: PlaneButton, lit: boolean) {
    btn.lit = lit; // unlit = press-proof (no accidental triggers)
    for (const g of btn.glowParts) {
      g.enabled = lit;
    }
  }

  /** PALM PRESS (Phone Defense style, no SIK): hand hovers over the
   * button and comes DOWN onto it. Must lift/leave to re-arm. */
  tickButtons(dt: number, palm: vec3 | null) {
    for (const b of this.buttons) {
      b.cooldown = Math.max(0, b.cooldown - dt);
      if (!b.root.enabled) {
        continue;
      }
      const over = palm !== null &&
        Math.abs(palm.x - b.cxMm) < b.halfWMm + 15 &&
        Math.abs(palm.y - b.cyMm) < b.halfHMm + 15;
      const low = palm !== null && palm.z < 55; // hand near the board
      if (!over || (palm !== null && palm.z > 95)) {
        b.armed = true; // left the button or lifted high -> re-armed
      }
      if (b.lit && b.armed && over && low && b.cooldown <= 0) {
        b.armed = false;
        b.cooldown = 1.0;
        b.pressT = 0;
        this.setButtonLit(b, true);
        log.i("Button PALM-pressed");
        b.onPress();
      }
    }
    // physical press dip animation
    for (const b of this.buttons) {
      if (b.pressT < 0.3) {
        b.pressT += dt;
        const k = Math.min(1, b.pressT / 0.3);
        const dip = Math.sin(k * Math.PI) * 0.35;
        b.root.getTransform().setLocalScale(new vec3(1, 1 - dip, 1));
      }
    }
  }

  setScore(player: number, vector: number) {
    this.scoreText.text = player + " : " + vector;
    this.popT = 0;
  }

  setStatus(text: string) {
    this.statusText.text = text;
  }

  tick(dt: number) {
    if (this.popT < 1.0) {
      this.popT = Math.min(1.0, this.popT + dt * 1.8);
      // CRT brightness surge: white-hot flash decaying to phosphor green
      const k = 1 - this.popT;
      const base = new vec3(0.45, 1, 0.55);
      this.scoreText.textFill.color = new vec4(
        base.x + (1 - base.x) * k,
        base.y,
        base.z + (1 - base.z) * k,
        1);
    }
  }
}
