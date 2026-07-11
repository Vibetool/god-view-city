import * as THREE from 'three';

// shared solid slab used to cap flat-roof buildings (the GLB flat roof reads as
// an open terrace, so a plain building looked roofless)
const _slabGeo = new THREE.BoxGeometry(1, 0.14, 1);
const _slabMat = new THREE.MeshStandardMaterial({ color:0x33363b, roughness:0.92, metalness:0 });

// A "building" is a single grid cell with a stack of 1x1x1 wall modules
// (Kenney urban kit) capped by a roof piece. Multi-cell looking blocks emerge
// from placing many adjacent single-cell buildings during generation.

export const WALL_STYLES = ['a', 'b'];
export const ROOF_KINDS  = ['flat', 'slant', 'detailed'];

// model ids needed by the building system (for preloading)
export function buildingModelIds(){
  const ids = [];
  for (const s of WALL_STYLES){
    ids.push(`wall-${s}`, `wall-${s}-window`, `wall-${s}-door`, `wall-${s}-garage`,
             `wall-${s}-low`, `wall-${s}-roof`, `wall-${s}-roof-slant`, `wall-${s}-roof-detailed`);
  }
  return ids;
}

// def: { style:'a'|'b', stories:int(1..5), roof:'flat'|'slant'|'detailed', door:bool }
export function buildBuilding(lib, def){
  const style = def.style || 'a';
  const stories = Math.max(1, Math.min(def.stories || 2, 6));
  const roof = def.roof || 'flat';
  const door = def.door !== false;
  const g = new THREE.Group();

  for (let f = 0; f < stories; f++){
    let id;
    if (f === 0 && door) id = `wall-${style}-door`;
    else id = (f === 0) ? `wall-${style}-garage` : `wall-${style}-window`;
    let inst = lib.instance(id) || lib.instance(`wall-${style}`) || lib.instance(`wall-a`);
    if (!inst) continue;
    inst.position.y = f * 1.0;
    g.add(inst);
  }
  // roof: slant/detailed use the sloped GLB caps; flat gets a solid slab so the
  // top is clearly capped instead of an open box
  if (roof === 'slant' || roof === 'detailed'){
    const roofId = `wall-${style}-roof-${roof}`;
    const cap = lib.instance(roofId) || lib.instance(`wall-${style}-roof`);
    if (cap){ cap.position.y = stories; g.add(cap); }
  } else {
    const slab = new THREE.Mesh(_slabGeo, _slabMat);
    slab.position.y = stories + 0.07; slab.castShadow = true; slab.receiveShadow = true;
    g.add(slab);
  }

  g.userData.def = { style, stories, roof, door };
  return g;
}

// Palette presets — shown as one-click building stamps.
export const BUILDING_PRESETS = [
  { id:'house-a',   label:'小屋 A',   def:{ style:'a', stories:1, roof:'slant',    door:true } },
  { id:'house-b',   label:'小屋 B',   def:{ style:'b', stories:1, roof:'slant',    door:true } },
  { id:'home2-a',   label:'两层 A',   def:{ style:'a', stories:2, roof:'detailed', door:true } },
  { id:'home2-b',   label:'两层 B',   def:{ style:'b', stories:2, roof:'detailed', door:true } },
  { id:'flat3-a',   label:'公寓 A',   def:{ style:'a', stories:3, roof:'flat',     door:true } },
  { id:'flat4-b',   label:'公寓 B',   def:{ style:'b', stories:4, roof:'flat',     door:true } },
  { id:'tower-a',   label:'塔楼 A',   def:{ style:'a', stories:5, roof:'flat',     door:true } },
  { id:'tower-b',   label:'塔楼 B',   def:{ style:'b', stories:6, roof:'flat',     door:true } },
];
