/**
 * Streams cube-face imagery tiles (tools/pipeline/textures.py) on demand and hands out per-tile materials.
 * Level 0 (6 tiles) is loaded up front so every chunk always has imagery; finer tiles load near the camera and the
 * least recently used ones are evicted to bound GPU memory.
 *
 * The body's surface material is built once (makeMaterial, with tileAlbedo as its albedo). Each tile's material is a
 * clone that shares its node graph and only names the tile (setTileSource), so three builds the nodes and compiles the
 * GPU program once per body instead of once per tile.
 */
import * as THREE from 'three/webgpu';
import { dataUrl } from '../data/assets';
import { setTileSource } from './materials/planetShading';

interface Tile {
  key: string;
  level: number;
  face: number;
  x: number;
  y: number;
  state: 'loading' | 'ready' | 'failed';
  texture?: THREE.Texture;
  material?: THREE.Material;
  lastUsed: number;
}

export class TileSet {
  private readonly tiles = new Map<string, Tile>();
  private readonly loader = new THREE.TextureLoader();
  private inflight = 0;
  private frame = 0;
  /** The body's surface material; never drawn itself, tiles draw clones of it. */
  private template: THREE.Material | undefined;
  static MAX_INFLIGHT = 6;

  constructor(
    readonly body: string,
    readonly maxLevel: number,
    /** Builds the body's surface material with tileAlbedo(tex, level, x, y); called once, for the first tile. */
    private readonly makeMaterial: (tex: THREE.Texture, level: number, x: number, y: number) => THREE.Material,
    private readonly maxTiles = 96,
    private readonly anisotropy = 8,
  ) {}

  async init(): Promise<void> {
    await Promise.all([0, 1, 2, 3, 4, 5].map((f) => this.load(0, f, 0, 0)));
  }

  private key(level: number, face: number, x: number, y: number): string {
    return `${level}/${face}/${x}_${y}`;
  }

  /** A tile's material: a clone of the template that shares its compiled shader and binds this tile's imagery. */
  private tileMaterial(tex: THREE.Texture, level: number, x: number, y: number): THREE.Material {
    this.template ??= this.makeMaterial(tex, level, x, y);
    const m = this.template.clone();
    setTileSource(m, tex, level, x, y);
    return m;
  }

  private load(level: number, face: number, x: number, y: number): Promise<void> {
    const key = this.key(level, face, x, y);
    const t: Tile = { key, level, face, x, y, state: 'loading', lastUsed: this.frame };
    this.tiles.set(key, t);
    this.inflight++;
    return new Promise((resolve) => {
      this.loader.load(
        dataUrl(`tiles/${this.body}/${level}/${face}/${x}_${y}.webp`),
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = this.anisotropy;
          tex.wrapS = THREE.ClampToEdgeWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          t.texture = tex;
          t.material = this.tileMaterial(tex, level, x, y);
          t.state = 'ready';
          this.inflight--;
          resolve();
        },
        undefined,
        () => {
          t.state = 'failed';
          this.inflight--;
          resolve();
        },
      );
    });
  }

  /** Call once per frame before materialFor(). */
  beginFrame(): void {
    this.frame++;
  }

  /** Best loaded material for a chunk; requests the ideal tile if missing. */
  materialFor(face: number, chunkLevel: number, ix: number, iy: number): THREE.Material {
    const want = Math.min(this.maxLevel, Math.max(0, chunkLevel - 1));
    for (let L = want; L >= 0; L--) {
      const shift = chunkLevel - L;
      const x = ix >> shift;
      const y = iy >> shift;
      const key = this.key(L, face, x, y);
      const t = this.tiles.get(key);
      if (t?.state === 'ready') {
        t.lastUsed = this.frame;
        return t.material!;
      }
      if (!t && L === want && this.inflight < TileSet.MAX_INFLIGHT) void this.load(L, face, x, y);
      if (t) t.lastUsed = this.frame;
    }
    // Level 0 is always loaded after init().
    return this.tiles.get(this.key(0, face, 0, 0))!.material!;
  }

  /** Evict least recently used tiles beyond the budget (never level 0, never ones used this frame). */
  endFrame(): void {
    if (this.tiles.size <= this.maxTiles) return;
    const old = [...this.tiles.values()]
      .filter((t) => t.level > 0 && t.state === 'ready' && t.lastUsed < this.frame - 2)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    let excess = this.tiles.size - this.maxTiles;
    for (const t of old) {
      if (excess-- <= 0) break;
      t.texture?.dispose();
      t.material?.dispose();
      this.tiles.delete(t.key);
    }
  }

  get stats(): { loaded: number; inflight: number } {
    return { loaded: this.tiles.size, inflight: this.inflight };
  }
}
