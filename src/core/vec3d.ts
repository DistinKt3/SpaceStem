/**
 * Float64 3-vectors and 3x3 matrices for simulation-space math. JavaScript numbers are IEEE-754 doubles, so all
 * CPU-side positions keep ~15.9 significant digits. Methods mutate `this` and return it to avoid allocation in
 * hot paths; use `clone()` when a copy is needed.
 */
export class Vec3d {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}

  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  copy(v: Readonly<Vec3d>): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }
  clone(): Vec3d {
    return new Vec3d(this.x, this.y, this.z);
  }
  add(v: Readonly<Vec3d>): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }
  sub(v: Readonly<Vec3d>): this {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }
  /** this = a - b */
  subVectors(a: Readonly<Vec3d>, b: Readonly<Vec3d>): this {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    return this;
  }
  addScaled(v: Readonly<Vec3d>, s: number): this {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }
  scale(s: number): this {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }
  dot(v: Readonly<Vec3d>): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  cross(v: Readonly<Vec3d>): this {
    const { x, y, z } = this;
    this.x = y * v.z - z * v.y;
    this.y = z * v.x - x * v.z;
    this.z = x * v.y - y * v.x;
    return this;
  }
  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }
  length(): number {
    return Math.hypot(this.x, this.y, this.z);
  }
  normalize(): this {
    const l = this.length();
    return l > 0 ? this.scale(1 / l) : this;
  }
  distanceTo(v: Readonly<Vec3d>): number {
    return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z);
  }
  lerp(v: Readonly<Vec3d>, t: number): this {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    return this;
  }
  applyMat3(m: Readonly<Mat3d>): this {
    const e = m.e;
    const { x, y, z } = this;
    this.x = e[0]! * x + e[1]! * y + e[2]! * z;
    this.y = e[3]! * x + e[4]! * y + e[5]! * z;
    this.z = e[6]! * x + e[7]! * y + e[8]! * z;
    return this;
  }
  /** Multiply by the transpose (the inverse, for rotation matrices). */
  applyMat3Transpose(m: Readonly<Mat3d>): this {
    const e = m.e;
    const { x, y, z } = this;
    this.x = e[0]! * x + e[3]! * y + e[6]! * z;
    this.y = e[1]! * x + e[4]! * y + e[7]! * z;
    this.z = e[2]! * x + e[5]! * y + e[8]! * z;
    return this;
  }
  toArray(out: number[] | Float64Array = [], offset = 0): number[] | Float64Array {
    out[offset] = this.x;
    out[offset + 1] = this.y;
    out[offset + 2] = this.z;
    return out;
  }
}

/** Row-major 3x3 matrix. */
export class Mat3d {
  readonly e = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  identity(): this {
    this.e.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    return this;
  }
  copy(m: Readonly<Mat3d>): this {
    this.e.set(m.e);
    return this;
  }
  /** this = a * b */
  multiplyMatrices(a: Readonly<Mat3d>, b: Readonly<Mat3d>): this {
    const A = a.e;
    const B = b.e;
    const r = new Float64Array(9);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        r[i * 3 + j] = A[i * 3]! * B[j]! + A[i * 3 + 1]! * B[3 + j]! + A[i * 3 + 2]! * B[6 + j]!;
      }
    }
    this.e.set(r);
    return this;
  }
  /** Rotation about the x axis by angle (radians), active (rotates vectors). */
  rotationX(a: number): this {
    const c = Math.cos(a);
    const s = Math.sin(a);
    this.e.set([1, 0, 0, 0, c, -s, 0, s, c]);
    return this;
  }
  rotationZ(a: number): this {
    const c = Math.cos(a);
    const s = Math.sin(a);
    this.e.set([c, -s, 0, s, c, 0, 0, 0, 1]);
    return this;
  }
  transpose(): this {
    const e = this.e;
    let t = e[1]!;
    e[1] = e[3]!;
    e[3] = t;
    t = e[2]!;
    e[2] = e[6]!;
    e[6] = t;
    t = e[5]!;
    e[5] = e[7]!;
    e[7] = t;
    return this;
  }
}
