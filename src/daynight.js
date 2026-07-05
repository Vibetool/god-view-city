import * as THREE from 'three';

// Day/night cycle. One in-game day = 24 real minutes (so 1 real second = 1 game
// minute). Drives the sun direction, sky gradient, fog, ambient light and exposure.

const DAY_SECONDS = 24 * 60;          // full day length in real seconds
export const RATES = [1, 6, 30, 0];   // 1× / 6× / 30× / paused (0)

// keyframes ordered by sun elevation e (-1 = below horizon .. +1 = zenith)
const KEY = [
  { e:-1.00, top:0x05060d, bot:0x0a0f1e, sun:0x2f3c66, si:0.00, hi:0.20, fi:0.30, ex:0.82, hs:0x18203c },
  { e:-0.16, top:0x0e1630, bot:0x243056, sun:0x40507f, si:0.00, hi:0.28, fi:0.34, ex:0.90, hs:0x2a3a66 },
  { e: 0.00, top:0x33406e, bot:0xff8a44, sun:0xff7a30, si:1.15, hi:0.50, fi:0.30, ex:1.00, hs:0xffb07a },
  { e: 0.22, top:0x5a8ad2, bot:0xfdd9ad, sun:0xffd39a, si:1.90, hi:0.75, fi:0.28, ex:1.03, hs:0xd2e2ff },
  { e: 1.00, top:0x4a86d8, bot:0xcfe6ff, sun:0xfff4dc, si:2.30, hi:0.95, fi:0.30, ex:1.05, hs:0xdcecff },
];

const lerp = (a,b,t)=> a + (b-a)*t;

export class DayNight {
  constructor(eng, startHour = 8){
    this.eng = eng;
    this.time = (startHour/24) % 1;   // 0..1 fraction of the day
    this.rateIdx = 0;                 // index into RATES
    // preallocated colours to avoid per-frame allocation
    this._top = new THREE.Color(); this._bot = new THREE.Color();
    this._sun = new THREE.Color(); this._hs = new THREE.Color();
    this._a = new THREE.Color(); this._b = new THREE.Color();
    this._dir = new THREE.Vector3();
    this._k = { si:0, hi:0, fi:0, ex:0 }; // reused scalar holder (no per-frame alloc)
    this.apply(new THREE.Vector3());
  }
  get rate(){ return RATES[this.rateIdx]; }
  get paused(){ return this.rate === 0; }
  cycleRate(){ this.rateIdx = (this.rateIdx + 1) % RATES.length; return this.rate; }

  get hours(){ return this.time * 24; }
  hhmm(){
    const h = this.hours | 0;
    const m = ((this.hours - h) * 60) | 0;
    return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
  }
  icon(){
    const h = this.hours;
    return h<5.5?'🌙': h<7.5?'🌅': h<17.5?'☀️': h<19.5?'🌇':'🌙';
  }

  _sample(e){
    e = Math.max(-1, Math.min(1, e));
    let i = 0; while (i < KEY.length-1 && e > KEY[i+1].e) i++;
    const a = KEY[i], b = KEY[Math.min(i+1, KEY.length-1)];
    const t = a===b ? 0 : (e - a.e) / (b.e - a.e);
    this._top.copy(this._a.setHex(a.top)).lerp(this._b.setHex(b.top), t);
    this._bot.copy(this._a.setHex(a.bot)).lerp(this._b.setHex(b.bot), t);
    this._sun.copy(this._a.setHex(a.sun)).lerp(this._b.setHex(b.sun), t);
    this._hs .copy(this._a.setHex(a.hs )).lerp(this._b.setHex(b.hs ), t);
    this._k.si = lerp(a.si,b.si,t); this._k.hi = lerp(a.hi,b.hi,t);
    this._k.fi = lerp(a.fi,b.fi,t); this._k.ex = lerp(a.ex,b.ex,t);
    return this._k;
  }

  update(dt, target){
    if (!this.paused) this.time = (this.time + dt/DAY_SECONDS * this.rate) % 1;
    this.apply(target);
  }

  apply(target){
    const { sun, hemi, fill, skyMat, scene, renderer } = this.eng;
    const ang = (this.time - 0.25) * Math.PI * 2;   // sunrise at t=0.25
    const e = Math.sin(ang);                          // elevation -1..1
    this._dir.set(Math.cos(ang), Math.sin(ang), 0.32).normalize();
    const k = this._sample(e);

    // directional sun (goes dark at night; hemi + fill keep things visible)
    sun.color.copy(this._sun);
    sun.intensity = k.si;
    sun.position.copy(target).addScaledVector(this._dir, 80);
    sun.target.position.copy(target); sun.target.updateMatrixWorld();

    // sky dome + background + horizon fog
    skyMat.uniforms.top.value.copy(this._top);
    skyMat.uniforms.bot.value.copy(this._bot);
    if (scene.background) scene.background.copy(this._bot);
    if (scene.fog) scene.fog.color.copy(this._bot);

    // ambient sky light + gentle fill (fill also stands in for moonlight at night)
    hemi.intensity = k.hi;
    hemi.color.copy(this._hs);
    fill.intensity = k.fi;

    renderer.toneMappingExposure = k.ex;
  }
}
