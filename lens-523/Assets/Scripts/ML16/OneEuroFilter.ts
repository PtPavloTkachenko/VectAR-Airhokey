/**
 * OneEuroFilter — standalone port from SpectaclesInteractionKit.
 *
 * Original algorithm: Géry Casiez, BSD License.
 * http://cristal.univ-lille.fr/~casiez/1euro/
 *
 * Used here to smooth the detected coffee-cup world position so the placed cube
 * stays stable when the cup is still, yet tracks quickly when the cup moves.
 *   - minCutoff  : lower  = more smoothing (more lag) when slow / still
 *   - beta       : higher = snappier response to fast motion (less lag)
 */

const minimumDt = 1.0 / 120.0;

function SafelyClampPeriod(dt: number): number {
  return Math.max(dt, minimumDt);
}

export class LowPassFilter {
  y: number;
  s: number;
  a = 0;
  initialized = false;

  constructor(alpha: number, initval = 0) {
    this.y = this.s = initval;
    this.setAlpha(alpha);
  }

  private setAlpha(alpha: number) {
    if (alpha <= 0.0) alpha = minimumDt;
    if (alpha > 1.0) alpha = 1.0;
    this.a = alpha;
  }

  filter(value: number) {
    let result: number;
    if (this.initialized) {
      result = this.a * value + (1.0 - this.a) * this.s;
    } else {
      result = value;
      this.initialized = true;
    }
    this.y = value;
    this.s = result;
    return result;
  }

  filterWithAlpha(value: number, alpha: number) {
    this.setAlpha(alpha);
    return this.filter(value);
  }

  hasLastRawValue() {
    return this.initialized;
  }
  lastRawValue() {
    return this.y;
  }
  reset() {
    this.initialized = false;
  }
}

export type OneEuroFilterConfig = {
  frequency: number;
  minCutoff: number;
  beta: number;
  dcutoff: number;
};

abstract class OneEuroFilterBase {
  x: LowPassFilter;
  dx: LowPassFilter;

  lasttime: number | undefined;
  lastcutoff: number | undefined;

  frequency!: number;
  minCutoff!: number;
  beta!: number;
  dcutoff!: number;

  constructor(config: OneEuroFilterConfig) {
    this.setFrequency(config.frequency);
    this.setMinCutoff(config.minCutoff);
    this.setBeta(config.beta);
    this.setDerivateCutoff(config.dcutoff);
    this.x = new LowPassFilter(this.alpha(config.minCutoff));
    this.dx = new LowPassFilter(this.alpha(config.dcutoff));
    this.lasttime = undefined;
    this.lastcutoff = undefined;
  }

  alpha(cutoff: number) {
    const te = 1.0 / this.frequency;
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / te);
  }

  reset() {
    this.x.reset();
    this.dx.reset();
    this.lasttime = undefined;
    this.lastcutoff = undefined;
  }

  private setFrequency(f: number) {
    this.frequency = f > 0 ? f : 1;
  }
  private setMinCutoff(mc: number) {
    this.minCutoff = mc > 0 ? mc : 0.001;
  }
  private setBeta(b: number) {
    this.beta = b;
  }
  private setDerivateCutoff(dc: number) {
    this.dcutoff = dc > 0 ? dc : 0.001;
  }
}

export class OneEuroFilterVec3 extends OneEuroFilterBase {
  y: LowPassFilter;
  dy: LowPassFilter;
  z: LowPassFilter;
  dz: LowPassFilter;
  speed: LowPassFilter;

  constructor(config: OneEuroFilterConfig) {
    super(config);
    this.y = new LowPassFilter(this.alpha(config.minCutoff));
    this.dy = new LowPassFilter(this.alpha(config.dcutoff));
    this.z = new LowPassFilter(this.alpha(config.minCutoff));
    this.dz = new LowPassFilter(this.alpha(config.dcutoff));
    this.speed = new LowPassFilter(this.alpha(config.dcutoff), 0);
  }

  override reset(): void {
    super.reset();
    this.y.reset();
    this.dy.reset();
    this.z.reset();
    this.dz.reset();
    this.speed.reset();
  }

  filter(value: vec3, timestamp: number): vec3 {
    if (this.lasttime !== undefined && timestamp !== undefined) {
      this.frequency = 1.0 / SafelyClampPeriod(timestamp - this.lasttime);
    }
    this.lasttime = timestamp;

    const dValueX = this.x.hasLastRawValue() ? (value.x - this.x.lastRawValue()) * this.frequency : 0.0;
    const dValueY = this.y.hasLastRawValue() ? (value.y - this.y.lastRawValue()) * this.frequency : 0.0;
    const dValueZ = this.z.hasLastRawValue() ? (value.z - this.z.lastRawValue()) * this.frequency : 0.0;

    const edValueXyzNorm = Math.sqrt(dValueX * dValueX + dValueY * dValueY + dValueZ * dValueZ);
    const newSpeed = this.speed.filterWithAlpha(edValueXyzNorm, this.alpha(this.dcutoff));

    const cutoff = this.minCutoff + this.beta * Math.abs(newSpeed);
    this.lastcutoff = cutoff;

    const xOut = this.x.filterWithAlpha(value.x, this.alpha(cutoff));
    const yOut = this.y.filterWithAlpha(value.y, this.alpha(cutoff));
    const zOut = this.z.filterWithAlpha(value.z, this.alpha(cutoff));
    return new vec3(xOut, yOut, zOut);
  }
}
