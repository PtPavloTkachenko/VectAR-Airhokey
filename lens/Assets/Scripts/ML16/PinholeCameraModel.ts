/**
 * PinholeCameraModel — wraps the device camera intrinsics (focal length, principal point,
 * resolution) so a 2D detection can be unprojected into a 3D ray in the *device camera's*
 * frame. This is what makes placement correct: the device camera the ML model sees has a
 * different FOV and a physical offset from the render/eye camera, so unprojecting through
 * the render camera (screenSpaceToWorldSpace) lands objects offset. Ported from the
 * Spectacles SnapML / phone-defense examples.
 */
export class PinholeCameraModel {
  public readonly resolution: vec2;
  public readonly focalLength: vec2;
  public readonly principalPoint: vec2;

  constructor(resolution: vec2, focalLength: vec2, principalPoint: vec2) {
    this.resolution = resolution;
    this.focalLength = focalLength;
    this.principalPoint = principalPoint;
  }

  static create(device: DeviceCamera): PinholeCameraModel {
    // DeviceCamera principal point is CV convention (x right, y down, integer pixel centers);
    // convert to GL convention (x right, y up, half-pixel centers).
    const pp = device.principalPoint.add(new vec2(0.5, 0.5));
    pp.y = device.resolution.y - pp.y;
    return new PinholeCameraModel(device.resolution, device.focalLength, pp);
  }

  projectToUV(pos: vec3): vec2 {
    const dir = new vec2(pos.x, pos.y).uniformScale(1 / -pos.z);
    return dir.mult(this.focalLength).add(this.principalPoint).div(this.resolution);
  }

  unprojectFromUV(uv: vec2, depth: number): vec3 {
    const dir = uv.mult(this.resolution).sub(this.principalPoint).div(this.focalLength);
    return new vec3(dir.x, dir.y, -1).uniformScale(depth);
  }

  get fov(): number {
    return Math.atan(this.resolution.y / 2 / this.focalLength.y) * 2;
  }

  get aspect(): number {
    const size = this.resolution.div(this.focalLength);
    return size.x / size.y;
  }
}

export default PinholeCameraModel;
