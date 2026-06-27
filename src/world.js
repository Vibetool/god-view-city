import * as THREE from 'three';
import { CELL } from './engine.js';
import { mulberry32, ValueNoise2D, hashStringToSeed } from './noise.js';
import { buildBuilding, WALL_STYLES, ROOF_KINDS } from './buildings.js';

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
    this.objects = new Map();    // oid -> { oid, kind, id?, def?, rot, x, z, group }
    this._oid = 0;
    this.snap = false;           // free placement by default ("place where you click")
    this.seed = 1;

    this.groundGroup = new THREE.Group();
    this.objectGroup = new THREE.Group();
    scene.add(this.groundGroup, this.objectGroup);

    // base grass plane
    const tex = makeGrassTexture();
    tex.repeat.set(grid, grid);
    const mat = new THREE.MeshStandardMaterial({ map:tex, roughness:1, metalness:0 });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(grid*CELL, grid*CELL), mat);
    plane.rotation.x = -Math.PI/2; plane.receiveShadow = true; plane.position.y = 0;
    plane.name = 'baseGround';
    this.basePlane = plane;
    scene.add(plane);

    // grid helper
    this.grid3 = new THREE.GridHelper(grid*CELL, grid, 0x2c3a22, 0x2c3a22);
    this.grid3.position.y = 0.015; this.grid3.material.opacity = 0.35; this.grid3.material.transparent = true;
    this.grid3.visible = false;
    scene.add(this.grid3);
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
    if (!this.inBounds(gx,gz)) return;
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
    mesh.position.set(p.x, type==='water'?0.04:0.012, p.z);
    this.groundGroup.add(mesh);
    this.groundMesh.set(k, mesh);
  }
  getGround(gx,gz){ return this.ground.get(this.key(gx,gz)) || 'grass'; }
  isAsphalt(gx,gz){ return this.inBounds(gx,gz) && this.ground.get(this.key(gx,gz))==='asphalt'; }
  // nearest cell of a given ground type to world point (x,z); returns {gx,gz} or null
  nearestGround(x,z,type){
    let best=null, bd=Infinity;
    for (const [k,t] of this.ground){
      if (t!==type) continue;
      const [gx,gz]=k.split(',').map(Number);
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
  // Add an object at an exact world (x,z). When this.snap is on (or forceSnap),
  // the position is rounded to the grid cell center; otherwise it's placed freely.
  addObject(x, z, desc, rot=0, forceSnap=false){
    if (this.snap || forceSnap){
      const c = this.worldToCell(x,z);
      if (!this.inBounds(c.gx,c.gz)) return null;
      const p = this.cellCenter(c.gx,c.gz); x = p.x; z = p.z;
    }
    const g = this.buildObjectGroup(desc);
    if (!g) return null;
    g.position.set(x, 0, z);
    g.rotation.y = rot * Math.PI/2;
    this.objectGroup.add(g);
    const oid = ++this._oid;
    const rec = { oid, kind:desc.kind, id:desc.id, def:desc.def, rot, x, z, group:g };
    g.userData.oid = oid;
    this.objects.set(oid, rec);
    return oid;
  }
  removeObject(oid){
    const rec = this.objects.get(oid);
    if (!rec) return false;
    this.objectGroup.remove(rec.group);
    disposeGroup(rec.group);
    this.objects.delete(oid);
    return true;
  }
  // Remove the object whose anchor is nearest to (x,z) within radius. Returns bool.
  removeNearest(x, z, radius=0.7){
    let best=null, bd=radius*radius;
    for (const rec of this.objects.values()){
      const dx=rec.x-x, dz=rec.z-z, d=dx*dx+dz*dz;
      if (d<=bd){ bd=d; best=rec; }
    }
    if (best) return this.removeObject(best.oid);
    return false;
  }

  setGridVisible(v){ this.grid3.visible = v; }

  clearAll(){
    for (const oid of [...this.objects.keys()]) this.removeObject(oid);
    for (const k of [...this.ground.keys()]){ const [gx,gz]=k.split(',').map(Number); this.setGround(gx,gz,'grass'); }
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

    // 1) road grid
    const step = 6 + (rng()*3|0);             // block size
    const offX = rng()*step|0, offZ = rng()*step|0;
    const isRoad = (gx,gz)=> ((gx+offX)%step===0) || ((gz+offZ)%step===0);
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
      objects.push([r.kind, r.id||null, r.def||null, r.rot, r3(r.x), r3(r.z)]);
    return { v:2, grid:this.GRID, seed:this.seed, seedStr:this.seedStr, ground, objects };
  }
  deserialize(data){
    if (!data || data.grid!==this.GRID) { return false; }
    this.clearAll();
    const savedSnap = this.snap; this.snap = false; // restore exact saved positions
    for (const [k,t] of data.ground||[]){ const [gx,gz]=k.split(',').map(Number); this.setGround(gx,gz,t); }
    for (const o of data.objects||[]){
      if (o.length>=6){                     // v2: [kind,id,def,rot,x,z]
        const [kind,id,def,rot,x,z]=o; this.addObject(x,z,{kind,id,def},rot);
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
