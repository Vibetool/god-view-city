import * as THREE from 'three';
import { CELL } from './engine.js';
import { mulberry32, ValueNoise2D, hashStringToSeed } from './noise.js';
import { buildBuilding, WALL_STYLES, ROOF_KINDS } from './buildings.js';

// Fixed global street grid. The buildable area's roads align to it, and it
// continues infinitely beyond the buildable area (drawn by a shader, driven on
// by cars). A cell is a road when its x-index OR z-index is a multiple of STEP.
export const ROAD_STEP = 7;
export function isRoadCellGlobal(gx, gz){
  return (((gx % ROAD_STEP) + ROAD_STEP) % ROAD_STEP) === 0
      || (((gz % ROAD_STEP) + ROAD_STEP) % ROAD_STEP) === 0;
}
// one-cell sidewalk ring just inside each block (matches the shader's onSide)
export function isSidewalkCellGlobal(gx, gz){
  if (isRoadCellGlobal(gx, gz)) return false;
  const rx = ((gx % ROAD_STEP) + ROAD_STEP) % ROAD_STEP;
  const rz = ((gz % ROAD_STEP) + ROAD_STEP) % ROAD_STEP;
  return rx===1 || rx===ROAD_STEP-1 || rz===1 || rz===ROAD_STEP-1;
}

// ground type -> model id (null = base grass / special)
export const GROUND_MODEL = {
  grass:    null,
  asphalt:  'road-asphalt-center',
  sidewalk: 'road-asphalt-pavement',
  dirt:     'road-dirt-pavement',
  dirtroad: 'road-dirt-center',
  water:    null, // special blue plane
};

function makeGrassTexture(){
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#6f9b3f'; x.fillRect(0,0,128,128);
  const cols = ['#789f44','#688f3a','#84a84e','#638a37','#7ba046'];
  for (let i=0;i<2600;i++){
    x.fillStyle = cols[(Math.random()*cols.length)|0];
    x.globalAlpha = 0.5;
    const px=(Math.random()*128)|0, py=(Math.random()*128)|0;
    x.fillRect(px,py,1+(Math.random()*2|0),1+(Math.random()*2|0));
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class World {
  constructor(scene, lib, grid = 64){
    this.scene = scene; this.lib = lib; this.GRID = grid;
    this.ground = new Map();     // key -> type
    this.groundMesh = new Map(); // key -> Object3D (non-grass overrides)
    this.objects = new Map();    // oid -> { oid, kind, id?, def?, rot, x, z, y, w, d, h, group }
    this._oid = 0;
    this.snap = false;           // free placement by default ("place where you click")
    this.blocked = new Map();    // cellKey -> count of static (non-driving) objects on it
    this.seed = 1;

    this.groundGroup = new THREE.Group();
    this.objectGroup = new THREE.Group();
    scene.add(this.groundGroup, this.objectGroup);

    // base grass plane — huge and camera-following, so the ground looks infinite
    // (its far edge always sits inside the fog). Objects are still confined to the
    // original grid; everything beyond the border is just open ground.
    const GROUND = 600;
    const tex = makeGrassTexture();
    tex.repeat.set(GROUND, GROUND);
    const mat = new THREE.MeshStandardMaterial({ map:tex, roughness:1, metalness:0 });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(GROUND, GROUND), mat);
    plane.rotation.x = -Math.PI/2; plane.receiveShadow = true; plane.position.y = 0;
    plane.name = 'baseGround';
    this.basePlane = plane;
    scene.add(plane);

    // infinite street-grid overlay. World-space (grid stays put as the plane
    // follows the camera); it aligns to isRoadCellGlobal so it continues the
    // buildable area's roads. Inside the grid, real road tiles sit on top of it.
    const gridMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uStep:{ value:ROAD_STEP }, uOff:{ value:grid/2 } },
      vertexShader: `varying vec3 vW;
        void main(){ vW=(modelMatrix*vec4(position,1.0)).xyz;
          gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      // outputs a fixed sRGB colour (ShaderMaterial bypasses tone/colour mgmt);
      // tuned to match the buildable area's asphalt + concrete tiles, with a
      // subtle per-cell variation so it doesn't look flat.
      fragmentShader: `varying vec3 vW; uniform float uStep; uniform float uOff;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
        void main(){
          float cx=floor(vW.x+uOff), cz=floor(vW.z+uOff);
          float rx=mod(cx, uStep), rz=mod(cz, uStep);
          bool onRoad = rx<0.5 || rz<0.5;                                       // road cell
          bool onSide = !onRoad && (rx<1.5||rx>uStep-1.5||rz<1.5||rz>uStep-1.5); // one-cell sidewalk ring
          float n = (hash(vec2(cx,cz))-0.5)*0.05;
          if (onRoad) gl_FragColor=vec4(vec3(0.165,0.165,0.160)+n, 1.0);
          else if (onSide) gl_FragColor=vec4(vec3(0.600,0.595,0.570)+n, 1.0);
          else discard;                                                         // block interior -> grass below
        }`
    });
    const gridPlane = new THREE.Mesh(new THREE.PlaneGeometry(GROUND, GROUND), gridMat);
    gridPlane.rotation.x = -Math.PI/2; gridPlane.position.y = 0.03;
    gridPlane.name = 'roadGrid'; gridPlane.renderOrder = 1;
    this.roadGrid = gridPlane;
    scene.add(gridPlane);

    // grid helper
    this.grid3 = new THREE.GridHelper(grid*CELL, grid, 0x2c3a22, 0x2c3a22);
    this.grid3.position.y = 0.015; this.grid3.material.opacity = 0.35; this.grid3.material.transparent = true;
    this.grid3.visible = false;
    scene.add(this.grid3);

    // streamed real road/sidewalk tiles around the camera, beyond the buildable
    // grid — so nearby outside area looks identical to inside (shader is the
    // far-distance fallback).
    this.streamGroup = new THREE.Group();
    scene.add(this.streamGroup);
    this.streamTiles = new Map();   // cellKey -> mesh
    this._streamKey = null;
  }

  key(gx,gz){ return gx + ',' + gz; }
  inBounds(gx,gz){ return gx>=0 && gz>=0 && gx<this.GRID && gz<this.GRID; }
  cellCenter(gx,gz){
    return new THREE.Vector3((gx - this.GRID/2 + 0.5)*CELL, 0, (gz - this.GRID/2 + 0.5)*CELL);
  }
  worldToCell(x,z){
    return { gx: Math.floor(x/CELL + this.GRID/2), gz: Math.floor(z/CELL + this.GRID/2) };
  }

  // ----- ground -----
  setGround(gx,gz,type){
    const k = this.key(gx,gz);
    const prev = this.groundMesh.get(k);
    if (prev){ this.groundGroup.remove(prev); this.groundMesh.delete(k); }
    if (!type || type==='grass'){ this.ground.delete(k); return; }
    this.ground.set(k, type);
    let mesh;
    if (type === 'water'){
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(CELL,CELL),
        new THREE.MeshStandardMaterial({ color:0x2f7bd6, roughness:0.25, metalness:0.1,
          transparent:true, opacity:0.86 }));
      m.rotation.x = -Math.PI/2; mesh = m;
    } else {
      const id = GROUND_MODEL[type];
      mesh = this.lib.instance(id);
      if (!mesh) return;
      mesh.traverse(o=>{ if(o.isMesh){ o.castShadow=false; o.receiveShadow=true; } });
    }
    const p = this.cellCenter(gx,gz);
    mesh.position.set(p.x, type==='water'?0.07:0.06, p.z); // above the shader grid layer
    this.groundGroup.add(mesh);
    this.groundMesh.set(k, mesh);
  }
  getGround(gx,gz){ return this.ground.get(this.key(gx,gz)) || 'grass'; }
  isAsphalt(gx,gz){
    // a user-painted override wins anywhere; otherwise the fixed global grid
    const t = this.ground.get(this.key(gx,gz));
    if (t !== undefined) return t==='asphalt';
    return isRoadCellGlobal(gx,gz);
  }
  // nearest cell of a given ground type to world point (x,z); returns {gx,gz} or null.
  // avoidBlocked skips cells carrying a static obstacle (used for car re-approach).
  nearestGround(x,z,type,avoidBlocked=false){
    let best=null, bd=Infinity;
    for (const [k,t] of this.ground){
      if (t!==type) continue;
      const [gx,gz]=k.split(',').map(Number);
      if (avoidBlocked && this.isBlocked(gx,gz)) continue;
      const c=this.cellCenter(gx,gz); const dx=c.x-x, dz=c.z-z, d=dx*dx+dz*dz;
      if (d<bd){ bd=d; best={gx,gz}; }
    }
    return best;
  }

  // ----- objects (free placement at any world position) -----
  buildObjectGroup(desc){
    let g;
    if (desc.kind === 'building'){
      g = buildBuilding(this.lib, desc.def);
    } else {
      g = this.lib.instance(desc.id);
    }
    return g || null;
  }
  // is this a self-driving vehicle (a truck with a cab, not a bare container)?
  isDrivable(rec){ return rec.kind==='model' && rec.id && rec.id.startsWith('truck') && !rec.id.endsWith('-cargo'); }

  // footprint + height of an object to be placed
  descMetrics(desc){
    if (desc.kind==='building'){
      const st = Math.max(1, Math.min(desc.def?.stories||2, 6));
      return { w:1, d:1, h: st + 0.5 };
    }
    const m = this.lib.byId.get(desc.id);
    return m ? { w:m.w||1, d:m.d||1, h:m.h||1 } : { w:1, d:1, h:1 };
  }
  // highest resting surface at (x,z): top of the tallest static object whose
  // footprint covers the point (rotation-aware box; moving vehicles don't count).
  supportHeightAt(x, z){
    let top = 0;
    for (const rec of this.objects.values()){
      if (this.isDrivable(rec)) continue;                 // a moving truck is not a surface
      const odd = ((rec.rot||0) & 1) === 1;               // 90°/270° swap footprint
      const ew = (odd ? (rec.d||1) : (rec.w||1)) / 2;
      const ed = (odd ? (rec.w||1) : (rec.d||1)) / 2;
      if (Math.abs(rec.x-x) <= ew && Math.abs(rec.z-z) <= ed){
        const t = (rec.y||0) + (rec.h||1);
        if (t > top) top = t;
      }
    }
    return top;
  }
  _markBlocked(rec, delta){
    if (this.isDrivable(rec)) return;           // moving vehicles don't block the road
    const c = this.worldToCell(rec.x, rec.z);
    const k = this.key(c.gx,c.gz);
    const n = (this.blocked.get(k)||0) + delta;
    if (n <= 0) this.blocked.delete(k); else this.blocked.set(k, n);
  }
  isBlocked(gx,gz){ return (this.blocked.get(this.key(gx,gz))||0) > 0; }

  // Add an object at an exact world (x,z). Snaps to cell center when snapping is on
  // (or forceSnap). It rests on top of whatever is already there (fixedY overrides).
  addObject(x, z, desc, rot=0, forceSnap=false, fixedY=null){
    if (this.snap || forceSnap){
      const c = this.worldToCell(x,z);
      const p = this.cellCenter(c.gx,c.gz); x = p.x; z = p.z;
    }
    const g = this.buildObjectGroup(desc);
    if (!g) return null;
    const m = this.descMetrics(desc);
    const y = (fixedY!=null) ? fixedY : this.supportHeightAt(x, z);
    g.position.set(x, y, z);
    g.rotation.y = rot * Math.PI/2;
    this.objectGroup.add(g);
    const oid = ++this._oid;
    const rec = { oid, kind:desc.kind, id:desc.id, def:desc.def, rot, x, z, y, w:m.w, d:m.d, h:m.h, group:g };
    g.userData.oid = oid;
    this.objects.set(oid, rec);
    this._markBlocked(rec, +1);
    return oid;
  }
  removeObject(oid){
    const rec = this.objects.get(oid);
    if (!rec) return false;
    this._markBlocked(rec, -1);
    this.objectGroup.remove(rec.group);
    disposeGroup(rec.group);
    this.objects.delete(oid);
    return true;
  }
  // Remove the object under (x,z): nearest first; for a true stack (same spot)
  // the topmost is removed first.
  removeNearest(x, z, radius=0.7){
    let best=null, bestD=Infinity, bestY=-1;
    for (const rec of this.objects.values()){
      const dx=rec.x-x, dz=rec.z-z, d=dx*dx+dz*dz;
      if (d > radius*radius) continue;
      const y = rec.y||0;
      if (!best || d < bestD || (d===bestD && y > bestY)){ best=rec; bestD=d; bestY=y; }
    }
    if (best) return this.removeObject(best.oid);
    return false;
  }

  setGridVisible(v){ this.grid3.visible = v; }
  // keep the infinite ground + street grid centered under the camera focus
  followGround(target){
    const x = target.x, z = target.z;
    if (this.basePlane){ this.basePlane.position.x = x; this.basePlane.position.z = z; }
    if (this.roadGrid){ this.roadGrid.position.x = x; this.roadGrid.position.z = z; }
    this.updateStream(target);
  }
  // stream real GLB road/sidewalk tiles in a window around the camera (outside
  // the buildable grid only; inside is handled by generate/user tiles).
  updateStream(target){
    const RAD = 16;
    const cc = this.worldToCell(target.x, target.z);
    const ck = cc.gx+','+cc.gz;
    if (ck === this._streamKey) return;           // camera hasn't crossed a cell
    this._streamKey = ck;
    const need = new Set();
    for (let dx=-RAD; dx<=RAD; dx++) for (let dz=-RAD; dz<=RAD; dz++){
      const gx=cc.gx+dx, gz=cc.gz+dz;
      if (this.inBounds(gx,gz)) continue;         // inside grid: real tiles already there
      let id=null;
      if (isRoadCellGlobal(gx,gz)) id='road-asphalt-center';
      else if (isSidewalkCellGlobal(gx,gz)) id='road-asphalt-pavement';
      if (!id) continue;                          // block interior -> basePlane grass
      const k=gx+','+gz; need.add(k);
      if (!this.streamTiles.has(k)){
        const m=this.lib.instance(id); if(!m) continue;
        m.traverse(o=>{ if(o.isMesh){ o.castShadow=false; o.receiveShadow=true; } });
        const p=this.cellCenter(gx,gz); m.position.set(p.x, 0.06, p.z);
        this.streamGroup.add(m); this.streamTiles.set(k,m);
      }
    }
    for (const [k,m] of this.streamTiles){
      if (!need.has(k)){ this.streamGroup.remove(m); this.streamTiles.delete(k); }
    }
  }

  clearAll(){
    for (const oid of [...this.objects.keys()]) this.removeObject(oid);
    for (const k of [...this.ground.keys()]){ const [gx,gz]=k.split(',').map(Number); this.setGround(gx,gz,'grass'); }
    this.blocked.clear();
  }

  // ----------------------------------------------------------------------
  // Procedural map generation
  // ----------------------------------------------------------------------
  generate(seedInput){
    const seed = (typeof seedInput === 'string')
      ? hashStringToSeed(seedInput) : (seedInput>>>0);
    this.seed = seed; this.seedStr = String(seedInput);
    this.clearAll();
    const rng = mulberry32(seed);
    const noise = new ValueNoise2D(seed);
    const N = this.GRID;
    const cx = N/2, cz = N/2;

    // 1) road grid — aligned to the fixed global street grid so it continues
    //    seamlessly into the infinite area beyond the buildable region
    const isRoad = (gx,gz)=> isRoadCellGlobal(gx,gz);
    const roadCells = [];
    for (let gx=0;gx<N;gx++) for (let gz=0;gz<N;gz++){
      if (isRoad(gx,gz)){ this.setGround(gx,gz,'asphalt'); roadCells.push([gx,gz]); }
    }
    // 2) sidewalks framing blocks
    const neigh = [[1,0],[-1,0],[0,1],[0,-1]];
    for (let gx=0;gx<N;gx++) for (let gz=0;gz<N;gz++){
      if (isRoad(gx,gz)) continue;
      let touch=false;
      for (const [dx,dz] of neigh){ const x=gx+dx,z=gz+dz; if(this.inBounds(x,z)&&isRoad(x,z)){touch=true;break;} }
      if (touch) this.setGround(gx,gz,'sidewalk');
    }

    const treeIds = ['tree-large','tree-small','tree-pine-large','tree-pine-small','tree-park-large','tree-park-pine-large'];
    const roadDirToRot = (gx,gz)=>{ // face nearest road: rot 0=+Z,1=+X,2=-Z,3=-X
      const dirs=[[0,1,0],[1,0,1],[0,-1,2],[-1,0,3]];
      for (const [dx,dz,r] of dirs){ const x=gx+dx,z=gz+dz; if(this.inBounds(x,z)&&isRoad(x,z)) return r; }
      return (rng()*4|0);
    };
    // generation places neatly on the grid: one object per cell, cell-centered
    const occ = new Set();
    const place = (gx,gz,desc,rot)=>{
      const k = gx+','+gz; if (occ.has(k)) return;
      const p = this.cellCenter(gx,gz);
      if (this.addObject(p.x, p.z, desc, rot, true) != null) occ.add(k);
    };

    // 3) blocks: buildings vs parks, scattered nature
    for (let gx=0;gx<N;gx++) for (let gz=0;gz<N;gz++){
      if (isRoad(gx,gz)) continue;
      const isSidewalk = this.getGround(gx,gz)==='sidewalk';
      const distC = Math.hypot(gx-cx, gz-cz) / (N*0.5); // 0 center .. 1 edge
      const urban = noise.fbm(gx*0.07+11, gz*0.07+5, 4);   // 0..1 city density field
      const forest = noise.fbm(gx*0.11-7, gz*0.11+3, 4);

      // outskirts -> forest / countryside
      const cityness = (1 - distC) * 0.9 + (urban-0.5)*0.6;

      if (cityness > 0.45){
        // urban block cell: place a building on most non-sidewalk cells
        if (!isSidewalk && rng() < 0.82){
          const style = WALL_STYLES[rng()*WALL_STYLES.length|0];
          // height: taller toward center
          const base = 1 + Math.round((1-distC)*3 + (urban-0.5)*3);
          const stories = Math.max(1, Math.min(6, base + (rng()<0.3? 1:0)));
          const roof = stories<=2 ? (rng()<0.6?'slant':'detailed') : 'flat';
          place(gx,gz,{kind:'building',def:{style,stories,roof,door:true}}, roadDirToRot(gx,gz));
        } else if (isSidewalk){
          // street furniture along sidewalks, sparse
          const r = rng();
          if (r < 0.05) place(gx,gz,{kind:'model',id:'detail-light-single'}, roadDirToRot(gx,gz));
          else if (r < 0.08) place(gx,gz,{kind:'model',id:'detail-bench'}, (roadDirToRot(gx,gz)+2)%4);
          else if (r < 0.10) place(gx,gz,{kind:'model',id:'tree-park-large'}, 0);
        }
      } else {
        // countryside / parks / forest
        if (isSidewalk) continue;
        if (forest > 0.58 || (distC>0.7 && forest>0.5)){
          if (rng() < 0.55){
            const id = treeIds[rng()*treeIds.length|0];
            place(gx,gz,{kind:'model',id}, rng()*4|0);
          }
        } else if (rng() < 0.06){
          place(gx,gz,{kind:'model',id:'tree-shrub'}, rng()*4|0);
        }
        // (no auto slopes/hills — terrain stays flat)
      }
    }

    // 4) vehicles on some road cells (oriented along the road)
    for (const [gx,gz] of roadCells){
      if (occ.has(gx+","+gz)) continue;
      if (rng() < 0.018){
        const along = isRoad(gx,gz+1)||isRoad(gx,gz-1); // vertical road?
        const trucks=['truck-green','truck-grey','truck-flat']; // no containers (*-cargo)
        place(gx,gz,{kind:'model',id:trucks[rng()*trucks.length|0]}, along?0:1);
      }
    }
    return this.seed;
  }

  // ----------------------------------------------------------------------
  // Save / load
  // ----------------------------------------------------------------------
  serialize(){
    const r3 = n => Math.round(n*1000)/1000;
    const ground=[]; for (const [k,t] of this.ground) ground.push([k,t]);
    const objects=[]; for (const r of this.objects.values())
      objects.push([r.kind, r.id||null, r.def||null, r.rot, r3(r.x), r3(r.z), r3(r.y||0)]);
    return { v:3, grid:this.GRID, seed:this.seed, seedStr:this.seedStr, ground, objects };
  }
  deserialize(data){
    if (!data || data.grid!==this.GRID) { return false; }
    this.clearAll();
    const savedSnap = this.snap; this.snap = false; // restore exact saved positions
    for (const [k,t] of data.ground||[]){ const [gx,gz]=k.split(',').map(Number); this.setGround(gx,gz,t); }
    for (const o of data.objects||[]){
      if (o.length>=6){                     // v2/v3: [kind,id,def,rot,x,z,(y)]
        const [kind,id,def,rot,x,z,y]=o; this.addObject(x,z,{kind,id,def},rot,false, (y!=null?y:null));
      } else {                              // v1: [cellKey,kind,id,def,rot]
        const [k,kind,id,def,rot]=o; const [gx,gz]=k.split(',').map(Number);
        const p=this.cellCenter(gx,gz); this.addObject(p.x,p.z,{kind,id,def},rot);
      }
    }
    this.snap = savedSnap;
    this.seed = data.seed||1; this.seedStr = data.seedStr||String(this.seed);
    return true;
  }
  count(){ return { objects:this.objects.size, ground:this.ground.size }; }
}

function disposeGroup(g){
  g.traverse(o=>{ if (o.isMesh){ /* geometry & materials are shared templates: do not dispose */ } });
}
