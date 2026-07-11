import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const CELL = 1; // one grid cell = 1 world unit (Kenney urban kit native scale)

// ----------------------------------------------------------------------------
// Scene / renderer / lighting
// ----------------------------------------------------------------------------
export function createEngine(container, opts={}){
  const mobile = !!opts.mobile;
  const renderer = new THREE.WebGLRenderer({ antialias:!mobile, powerPreference:'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(mobile ? 1 : Math.min(devicePixelRatio, 2)); // cap fill-rate on phones
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = mobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.04;
  container.appendChild(renderer.domElement);
  renderer.domElement.tabIndex = 0;

  const scene = new THREE.Scene();
  const skyTop = new THREE.Color(0x87b6ff), skyBot = new THREE.Color(0xd9ecff);
  scene.background = skyBot.clone();
  scene.fog = new THREE.Fog(0xcfe3ff, 60, 190);

  // gradient sky dome
  const skyGeo = new THREE.SphereGeometry(400, 24, 12);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite:false,
    uniforms:{ top:{value:skyTop}, bot:{value:skyBot} },
    vertexShader:`varying vec3 vp; void main(){ vp=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader:`varying vec3 vp; uniform vec3 top; uniform vec3 bot;
      void main(){ float h=clamp((normalize(vp).y*0.5+0.5),0.0,1.0); gl_FragColor=vec4(mix(bot,top,pow(h,0.8)),1.0);}`
  });
  const sky = new THREE.Mesh(skyGeo, skyMat); sky.frustumCulled = false; scene.add(sky);

  // lighting
  const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x55603f, 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d6, 2.0);
  sun.position.set(34, 52, 22);
  sun.castShadow = true;
  sun.shadow.mapSize.set(mobile?1024:2048, mobile?1024:2048);
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 220;
  const S = 60;
  sun.shadow.camera.left=-S; sun.shadow.camera.right=S; sun.shadow.camera.top=S; sun.shadow.camera.bottom=-S;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
  scene.add(sun); scene.add(sun.target);
  const fill = new THREE.DirectionalLight(0xbcd0ff, 0.35);
  fill.position.set(-30, 24, -18); scene.add(fill);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth/window.innerHeight, 0.5, 600);
  const god = new GodCamera(camera, renderer.domElement);

  window.addEventListener('resize', ()=>{
    camera.aspect = window.innerWidth/window.innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, scene, camera, god, sun, hemi, fill, skyMat };
}

// ----------------------------------------------------------------------------
// God-view orbit camera. Handles RIGHT-drag (rotate), MIDDLE / space-drag (pan),
// wheel (zoom), WASD/QE keys. LEFT button is left for the build tools.
// ----------------------------------------------------------------------------
export class GodCamera {
  constructor(camera, dom){
    this.cam = camera; this.dom = dom;
    this.target = new THREE.Vector3(0, 0, 0);
    this.yaw = Math.PI * 0.22;
    this.pitch = THREE.MathUtils.degToRad(50); // angle below horizon
    this.dist = 46;
    this.minDist = 6; this.maxDist = 130;
    this.minPitch = THREE.MathUtils.degToRad(20);
    this.maxPitch = THREE.MathUtils.degToRad(82);
    this.keys = new Set(); this.space = false;
    this._drag = null;
    this._bind();
    this.update(0);
  }
  _bind(){
    const d = this.dom;
    d.addEventListener('contextmenu', e=>e.preventDefault());
    d.addEventListener('pointerdown', e=>{
      const rotate = e.button===2;
      const pan = e.button===1 || (e.button===0 && this.space);
      if (!rotate && !pan) return;
      this._drag = { x:e.clientX, y:e.clientY, mode: rotate?'rot':'pan', id:e.pointerId };
      d.setPointerCapture(e.pointerId);
    });
    d.addEventListener('pointermove', e=>{
      if (!this._drag || e.pointerId!==this._drag.id) return;
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      this._drag.x = e.clientX; this._drag.y = e.clientY;
      if (this._drag.mode==='rot'){
        this.yaw   -= dx * 0.005;
        this.pitch = THREE.MathUtils.clamp(this.pitch - dy*0.005, this.minPitch, this.maxPitch);
      } else {
        this._panScreen(dx, dy);
      }
    });
    const end = e=>{ if (this._drag && e.pointerId===this._drag.id){ try{d.releasePointerCapture(e.pointerId);}catch(_){} this._drag=null; } };
    d.addEventListener('pointerup', end);
    d.addEventListener('pointercancel', end);
    d.addEventListener('wheel', e=>{
      e.preventDefault();
      const f = Math.exp(e.deltaY * 0.0012);
      this.dist = THREE.MathUtils.clamp(this.dist * f, this.minDist, this.maxDist);
    }, { passive:false });
    window.addEventListener('keydown', e=>{
      if (e.code==='Space'){ this.space = true; }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', e=>{
      if (e.code==='Space'){ this.space = false; }
      this.keys.delete(e.code);
    });
    window.addEventListener('blur', ()=>{ this.keys.clear(); this.space=false; });
  }
  _panScreen(dx, dy){
    // move target in the ground plane relative to camera yaw
    const s = this.dist * 0.0016;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.target.addScaledVector(right, -dx*s);
    this.target.addScaledVector(fwd, dy*s);
  }
  update(dt){
    // keyboard pan / rotate
    const move = this.dist * dt * 1.1;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const k = this.keys;
    if (k.has('KeyW')||k.has('ArrowUp'))    this.target.addScaledVector(fwd, move);
    if (k.has('KeyS')||k.has('ArrowDown'))  this.target.addScaledVector(fwd, -move);
    if (k.has('KeyA')||k.has('ArrowLeft'))  this.target.addScaledVector(right, -move);
    if (k.has('KeyD')||k.has('ArrowRight')) this.target.addScaledVector(right, move);
    if (k.has('KeyQ')) this.yaw += dt*1.4;
    if (k.has('KeyE')) this.yaw -= dt*1.4;

    const r = this.dist;
    const cosP = Math.cos(this.pitch);
    const off = new THREE.Vector3(
      Math.sin(this.yaw)*cosP, Math.sin(this.pitch), Math.cos(this.yaw)*cosP
    ).multiplyScalar(r);
    this.cam.position.copy(this.target).add(off);
    this.cam.lookAt(this.target);
  }
}

// ----------------------------------------------------------------------------
// Model library: load each GLB once, clone instances on demand.
// ----------------------------------------------------------------------------
export class ModelLibrary {
  constructor(){
    this.loader = new GLTFLoader();
    this.cache = new Map();       // id -> Promise<Group template>
    this.templates = new Map();   // id -> Group (resolved template, for sync clone)
    this.byId = new Map();        // id -> manifest entry
  }
  register(models){ for (const m of models) this.byId.set(m.id, m); }

  load(id){
    if (this.cache.has(id)) return this.cache.get(id);
    const entry = this.byId.get(id);
    if (!entry) return Promise.reject(new Error('unknown model '+id));
    const p = new Promise((resolve, reject)=>{
      this.loader.load(entry.file, gltf=>{
        const root = gltf.scene;
        root.traverse(o=>{
          if (o.isMesh){
            o.castShadow = true; o.receiveShadow = true;
            const mats = Array.isArray(o.material)?o.material:[o.material];
            for (const mat of mats){
              if (mat.map){
                mat.map.magFilter = THREE.NearestFilter;
                mat.map.minFilter = THREE.NearestFilter;
                mat.map.generateMipmaps = false;
                mat.map.anisotropy = 1;
                mat.map.colorSpace = THREE.SRGBColorSpace;
                mat.map.needsUpdate = true;
              }
              mat.metalness = Math.min(mat.metalness ?? 0, 0.1);
              mat.roughness = Math.max(mat.roughness ?? 1, 0.7);
            }
          }
        });
        this.templates.set(id, root);
        resolve(root);
      }, undefined, reject);
    });
    this.cache.set(id, p);
    return p;
  }
  // preload many, report progress
  async preload(ids, onProgress){
    let done = 0;
    await Promise.all(ids.map(id=>this.load(id).then(()=>{ done++; onProgress && onProgress(done, ids.length); })
      .catch(e=>{ console.warn('load fail', id, e); done++; onProgress && onProgress(done, ids.length); })));
  }
  isLoaded(id){ return this.templates.has(id); }
  // synchronous clone of an already-loaded template (clone shares geometry + materials)
  instance(id){
    const tpl = this.templates.get(id);
    if (!tpl) return null;
    return tpl.clone(true);
  }
}
