/**
 * field (mm, 2D) <-> lens world (cm, 3D) conversions, anchored to the
 * fieldRoot SceneObject placed on the table.
 *
 * Mapping: field +X -> fieldRoot local +X, field +Y -> fieldRoot local -Z
 * (keeps the plane normal at local +Y and the frame right-handed).
 * Heading deg CCW about +Y; 0 deg = field +X.
 */
export class FieldMath {
  constructor(private fieldRoot: SceneObject) {}

  get rootTransform(): Transform {
    return this.fieldRoot.getTransform();
  }

  fieldToLocal(xMm: number, yMm: number, heightCm: number = 0): vec3 {
    return new vec3(xMm / 10, heightCm, -yMm / 10);
  }

  fieldToWorld(xMm: number, yMm: number, heightCm: number = 0): vec3 {
    const local = this.fieldToLocal(xMm, yMm, heightCm);
    return this.rootTransform.getWorldTransform().multiplyPoint(local);
  }

  worldToField(world: vec3): vec2 {
    const inv = this.rootTransform.getInvertedWorldTransform();
    const local = inv.multiplyPoint(world);
    return new vec2(local.x * 10, -local.z * 10);
  }

  /** Field position PLUS height above the board (all mm). */
  worldToField3(world: vec3): vec3 {
    const inv = this.rootTransform.getInvertedWorldTransform();
    const local = inv.multiplyPoint(world);
    return new vec3(local.x * 10, -local.z * 10, local.y * 10);
  }

  /** Rotation for a field heading (deg CCW, 0 = +X) as a local quat. */
  headingToLocalRotation(deg: number): quat {
    return quat.angleAxis((deg * Math.PI) / 180, vec3.up());
  }
}
