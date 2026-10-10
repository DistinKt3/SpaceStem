/**
 * Depth partitioning (the baseline depth strategy, works on every backend).
 *
 * Each visible renderable occupies a camera-space depth interval [near, far]. Overlapping intervals merge into groups;
 * a group whose far/near ratio exceeds maxRatio is split geometrically into sub-ranges. Partitions render far to near
 * with the depth buffer cleared between them, so each partition gets the full depth precision for its own range.
 * Objects spanning a seam are drawn in every partition they overlap; the near/far clip planes cut them cleanly.
 */
export interface DepthInterval<T> {
  near: number;
  far: number;
  item: T;
}

export interface Partition<T> {
  near: number;
  far: number;
  items: T[];
}

export function planPartitions<T>(
  intervals: readonly DepthInterval<T>[],
  maxRatio: number,
  minNear: number,
): Partition<T>[] {
  if (intervals.length === 0) return [];
  const sorted = intervals
    .map((iv) => ({ near: Math.max(iv.near, minNear), far: Math.max(iv.far, Math.max(iv.near, minNear) * 1.0001), item: iv.item }))
    .sort((a, b) => a.near - b.near);

  // Merge overlapping intervals into groups.
  const groups: { near: number; far: number; members: DepthInterval<T>[] }[] = [];
  for (const iv of sorted) {
    const last = groups[groups.length - 1];
    if (last && iv.near <= last.far) {
      last.far = Math.max(last.far, iv.far);
      last.members.push(iv);
    } else {
      groups.push({ near: iv.near, far: iv.far, members: [iv] });
    }
  }

  // Split groups whose range is too deep for the depth buffer, then emit far to near.
  const out: Partition<T>[] = [];
  for (let g = groups.length - 1; g >= 0; g--) {
    const grp = groups[g]!;
    const ratio = grp.far / grp.near;
    const pieces = Number.isFinite(maxRatio) && ratio > maxRatio ? Math.ceil(Math.log(ratio) / Math.log(maxRatio)) : 1;
    const step = Math.pow(ratio, 1 / pieces);
    for (let p = pieces - 1; p >= 0; p--) {
      const near = grp.near * Math.pow(step, p);
      const far = p === pieces - 1 ? grp.far : grp.near * Math.pow(step, p + 1);
      const items = grp.members.filter((m) => m.near < far && m.far > near).map((m) => m.item);
      if (items.length > 0) out.push({ near, far, items });
    }
  }
  return out;
}
