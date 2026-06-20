// Seeded RNG + value noise for procedural generation.

export function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStringToSeed(str){
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// 2D value noise with smooth interpolation, seeded.
export class ValueNoise2D {
  constructor(seed){
    this.perm = new Uint16Array(512);
    const rnd = mulberry32(seed);
    const p = new Uint16Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--){
      const j = (rnd() * (i + 1)) | 0;
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  _grad(ix, iy){
    const h = this.perm[(this.perm[ix & 255] + iy) & 255];
    return (h / 255) * 2 - 1; // -1..1
  }
  // smooth value noise in 0..1
  get(x, y){
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const u = fx*fx*(3-2*fx), v = fy*fy*(3-2*fy);
    const a = this._grad(ix, iy);
    const b = this._grad(ix+1, iy);
    const c = this._grad(ix, iy+1);
    const d = this._grad(ix+1, iy+1);
    const top = a + u*(b-a);
    const bot = c + u*(d-c);
    return (top + v*(bot-top)) * 0.5 + 0.5;
  }
  // fractal brownian motion, 0..1
  fbm(x, y, oct = 4, lac = 2, gain = 0.5){
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++){
      sum += amp * this.get(x*freq, y*freq);
      norm += amp; amp *= gain; freq *= lac;
    }
    return sum / norm;
  }
}
