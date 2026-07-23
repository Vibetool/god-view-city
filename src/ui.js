import * as THREE from 'three';
import { MODELS } from './manifest.js';
import { BUILDING_PRESETS } from './buildings.js';

const $ = s => document.querySelector(s);

// Ground paints (id -> label, icon)
const GROUND_PAINTS = [
  { type:'grass',    label:'草地',   swatch:'#6f9b3f' },
  { type:'asphalt',  label:'柏油路', preview:'assets/previews/road-asphalt-center.png' },
  { type:'sidewalk', label:'人行道', preview:'assets/previews/road-asphalt-pavement.png' },
  { type:'dirtroad', label:'土路',   preview:'assets/previews/road-dirt-center.png' },
  { type:'dirt',     label:'泥地',   preview:'assets/previews/road-dirt-pavement.png' },
  { type:'water',    label:'水面',   swatch:'#2f7bd6' },
];

const CATS = [
  { key:'build',   label:'建筑' },
  { key:'ground',  label:'地面' },
  { key:'nature',  label:'树木' },
  { key:'building',label:'墙体' },
  { key:'prop',    label:'道具' },
  { key:'vehicle', label:'载具' },
  { key:'terrain', label:'地形' },
  { key:'erase',   label:'🗑 删除' },
];

// sub-groups for the (large) 墙体 category
const BUILD_SUBS = [
  { key:'wall',   label:'墙' },
  { key:'open',   label:'门窗' },
  { key:'roof',   label:'屋顶' },
  { key:'struct', label:'构件' },
];
function buildSubOf(id){
  if (id.includes('roof')) return 'roof';
  if (id.includes('door') || id.includes('window') || id.includes('garage')) return 'open';
  if (id.startsWith('balcony') || id.startsWith('scaffolding') ||
      id.includes('column') || id.includes('fence') || id.includes('steps') || id.includes('ladder')) return 'struct';
  return 'wall';
}

export function initUI(ctx){
  const { renderer, camera, god, world, lib } = ctx;
  const dom = renderer.domElement;

  const state = {
    sel: null,          // {type:'object'|'building'|'ground'|'delete', ...}
    rot: 0,
    painting: false,
    lastCell: null,
    lastPos: { x:0, z:0 },
    pointer: { x:-1, y:-1, inside:false },
  };
  const MIN_DRAG_DIST = 0.7; // min spacing between drag-scattered objects (world units)
  ctx.uiState = state;

  // ---------- palette ----------
  const tabsEl = $('#tabs'), itemsEl = $('#items'), subEl = $('#subfilter');
  let activeCat = 'build';
  let buildSub = 'wall';
  for (const c of CATS){
    const t = document.createElement('div');
    t.className = 'tab' + (c.key===activeCat?' active':'');
    t.textContent = c.label; t.dataset.k = c.key;
    t.onclick = ()=>{ activeCat=c.key; renderTabs(); renderItems(); };
    tabsEl.appendChild(t);
  }
  function renderTabs(){ [...tabsEl.children].forEach(t=>t.classList.toggle('active', t.dataset.k===activeCat)); }

  function itemEl({label, badge, preview, swatch, onSel, selKey}){
    const el = document.createElement('div');
    el.className = 'item'; el.dataset.sel = selKey || label;
    if (preview){ const img=document.createElement('img'); img.src=preview; img.loading='lazy'; el.appendChild(img); }
    else if (swatch){ const s=document.createElement('div'); s.className='swatch'; s.style.background=swatch; el.appendChild(s); }
    if (badge){ const b=document.createElement('div'); b.className='badge'; b.textContent=badge; el.appendChild(b); }
    const l=document.createElement('div'); l.className='lbl'; l.textContent=label; el.appendChild(l);
    el.onclick = ()=>{ onSel(); markSel(selKey||label); };
    return el;
  }
  function markSel(k){ [...itemsEl.children].forEach(e=>e.classList.toggle('sel', e.dataset.sel===k)); }

  function renderSub(){
    subEl.innerHTML='';
    if (activeCat!=='building'){ subEl.classList.remove('on'); return; }
    subEl.classList.add('on');
    for (const s of BUILD_SUBS){
      const c=document.createElement('div');
      c.className='subchip'+(s.key===buildSub?' active':'');
      c.textContent=s.label;
      c.onclick=()=>{ buildSub=s.key; renderSub(); renderItems(); };
      subEl.appendChild(c);
    }
  }

  function renderItems(){
    renderSub();
    itemsEl.innerHTML='';
    if (activeCat==='build'){
      for (const p of BUILDING_PRESETS){
        itemsEl.appendChild(itemEl({
          label:p.label, badge:p.def.stories+'F',
          preview:`assets/previews/wall-${p.def.style}-window.png`,
          selKey:'b:'+p.id,
          onSel:()=> setSel({type:'building', def:p.def, name:p.label})
        }));
      }
    } else if (activeCat==='ground'){
      for (const g of GROUND_PAINTS){
        itemsEl.appendChild(itemEl({
          label:g.label, preview:g.preview, swatch:g.swatch, selKey:'g:'+g.type,
          onSel:()=> setSel({type:'ground', ground:g.type, name:g.label})
        }));
      }
    } else if (activeCat==='erase'){
      itemsEl.appendChild(itemEl({
        label:'橡皮擦', swatch:'linear-gradient(135deg,#ff5d5d,#7a1f1f)', selKey:'erase',
        onSel:()=> setSel({type:'delete', name:'删除'})
      }));
    } else {
      let list = MODELS.filter(m=>m.cat===activeCat);
      if (activeCat==='building') list = list.filter(m=>buildSubOf(m.id)===buildSub);
      for (const m of list){
        itemsEl.appendChild(itemEl({
          label:m.label, preview:m.preview||undefined, selKey:'m:'+m.id,
          onSel:()=> selectModel(m)
        }));
      }
    }
  }
  renderItems();

  async function selectModel(m){
    if (!lib.isLoaded(m.id)){ await lib.load(m.id); }
    setSel({type:'object', id:m.id, name:m.label});
  }

  function setSel(sel){
    state.sel = sel; state.rot = 0;
    $('#toolName').textContent = sel ? sel.name : '浏览';
    rebuildGhost();
  }

  // ---------- ghost preview ----------
  const ghost = new THREE.Group(); ctx.scene.add(ghost);
  const highlight = makeHighlight(); ctx.scene.add(highlight); highlight.visible=false;

  function clearGhost(){ while(ghost.children.length) ghost.remove(ghost.children[0]); }
  function rebuildGhost(){
    clearGhost();
    const s = state.sel;
    if (!s){ ghost.visible=false; highlight.visible=false; return; }
    if (s.type==='ground' || s.type==='delete'){
      ghost.visible=false; return;
    }
    let g=null;
    if (s.type==='building') g = world.buildObjectGroup({kind:'building', def:s.def});
    else if (s.type==='object') g = world.buildObjectGroup({kind:'model', id:s.id});
    if (!g){ ghost.visible=false; return; }
    g.traverse(o=>{
      if (o.isMesh){
        // keep single material single — an array material on ungrouped geometry renders nothing
        const makeGhost = m=>{ const c=m.clone(); c.transparent=true; c.opacity=0.5; c.depthWrite=false; return c; };
        o.material = Array.isArray(o.material) ? o.material.map(makeGhost) : makeGhost(o.material);
        o.castShadow=false; o.receiveShadow=false;
      }
    });
    ghost.add(g);
    ghost.visible = true;
  }

  function ghostPos(hit){
    if (world.snap){ const p = world.cellCenter(hit.gx,hit.gz); return { x:p.x, z:p.z }; }
    return { x:hit.x, z:hit.z };
  }
  function applyGhostTransform(hit){
    const p = ghostPos(hit);
    let y = 0;
    const s = state.sel;
    if (s && (s.type==='object' || s.type==='building')){
      y = world.supportHeightAt(p.x, p.z); // preview the stack height
    }
    ghost.position.set(p.x, y, p.z);
    ghost.rotation.y = state.rot*Math.PI/2;
  }

  // ---------- raycast: hit real geometry first (so you can place ON TOP of a
  // building from any angle), fall back to the ground plane over empty land ----
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0,1,0), 0);
  const hit3 = new THREE.Vector3();
  const _pickTargets = [world.objectGroup, world.basePlane].filter(Boolean);
  const _rc = [];
  function pointUnderPointer(){
    if (!state.pointer.inside) return null;
    const vw = dom.clientWidth || innerWidth || 1, vh = dom.clientHeight || innerHeight || 1;
    ndc.set((state.pointer.x/vw)*2-1, -(state.pointer.y/vh)*2+1);
    ray.setFromCamera(ndc, camera);
    _rc.length = 0;
    ray.intersectObjects(_pickTargets, true, _rc);
    let hx, hz;
    if (_rc.length){ hx=_rc[0].point.x; hz=_rc[0].point.z; }   // top of a building / ground mesh
    else { if (!ray.ray.intersectPlane(plane, hit3)) return null; hx=hit3.x; hz=hit3.z; }
    const c = world.worldToCell(hx, hz);
    return { x:hx, z:hz, gx:c.gx, gz:c.gz };
  }

  // ---------- actions (free placement at the exact clicked point) ----------
  const ach = ctx.ach;   // achievements (optional)
  function act(h){
    const s = state.sel; if (!s) return;
    if (s.type==='ground'){
      world.setGround(h.gx,h.gz,s.ground);
      ach && ach.onGroundPlaced();
    }
    else if (s.type==='delete'){
      if (!world.removeNearest(h.x,h.z,0.7)) world.setGround(h.gx,h.gz,'grass');
    }
    else if (s.type==='object') world.addObject(h.x,h.z,{kind:'model',id:s.id}, state.rot);
    else if (s.type==='building'){
      const ok = world.addObject(h.x,h.z,{kind:'building',def:s.def}, state.rot);
      if (ok != null && ach) ach.onBuildingPlaced();
    }
  }
  // ground & delete drag by cell; objects scatter by distance; buildings click-only
  const isDragPaint = s => s && (s.type==='ground'||s.type==='delete'||s.type==='object');
  const isCellTool  = s => s && (s.type==='ground'||s.type==='delete');

  // ---------- pointer events (LEFT button = build; camera handles the rest) ----------
  dom.addEventListener('pointermove', e=>{
    if (e.pointerType==='touch') return;       // touch handled by TouchControls
    state.pointer.x=e.clientX; state.pointer.y=e.clientY; state.pointer.inside=true;
    if (state.painting && state.sel){
      const h = pointUnderPointer(); if (!h) return;
      if (isCellTool(state.sel)){
        const k=h.gx+','+h.gz; if (k!==state.lastCell){ state.lastCell=k; act(h); }
      } else { // object scatter: throttle by distance
        const dx=h.x-state.lastPos.x, dz=h.z-state.lastPos.z;
        if (dx*dx+dz*dz >= MIN_DRAG_DIST*MIN_DRAG_DIST){ state.lastPos={x:h.x,z:h.z}; act(h); }
      }
    }
  });
  dom.addEventListener('pointerleave', ()=>{ state.pointer.inside=false; });
  dom.addEventListener('pointerdown', e=>{
    if (e.pointerType==='touch') return;         // touch handled by TouchControls
    if (e.button!==0 || god.space) return;       // left only; space+left = pan
    if (!state.sel) return;
    const h = pointUnderPointer(); if (!h) return;
    state.painting = isDragPaint(state.sel);
    state.lastCell = h.gx+','+h.gz;
    state.lastPos = { x:h.x, z:h.z };
    act(h);
    if (state.painting){ try{ dom.setPointerCapture(e.pointerId); }catch(_){} }
  });
  const endPaint = e=>{ if (e.pointerType==='touch') return; if (state.painting){ try{dom.releasePointerCapture(e.pointerId);}catch(_){} } state.painting=false; state.lastCell=null; };
  dom.addEventListener('pointerup', endPaint);
  dom.addEventListener('pointercancel', endPaint);

  // ---------- keyboard ----------
  const pill = $('#rotpill'); let pillT=0;
  window.addEventListener('keydown', e=>{
    if (e.target.tagName==='INPUT') return;
    if (e.code==='KeyR'){ rotate(); }
    else if (e.code==='KeyX'){ activeCat='erase'; renderTabs(); renderItems(); setSel({type:'delete',name:'删除'}); }
    else if (e.code==='Escape'){ cancel(); }
  });
  function flashPill(t){ pill.textContent=t; pill.classList.add('show'); pillT=performance.now()+900; }

  function applyGhostFromPointer(){ const h=pointUnderPointer(); if(h) applyGhostTransform(h); }

  // shared actions (keyboard + mobile buttons + touch tap)
  function rotate(){ state.rot=(state.rot+1)%4; applyGhostFromPointer(); flashPill('朝向 '+(state.rot*90)+'°'); }
  function cancel(){ setSel(null); markSel('__none__'); }
  function tapAt(cx, cy){ // place/erase/paint at a screen point (mobile tap)
    state.pointer.x=cx; state.pointer.y=cy; state.pointer.inside=true;
    const h=pointUnderPointer(); if(h) act(h);
  }
  // mobile: show the ghost preview while a finger is held down (no hover on touch)
  function setHover(cx, cy){ state.pointer.x=cx; state.pointer.y=cy; state.pointer.inside=true; }
  function hideHover(){ state.pointer.inside=false; }

  // ---------- per-frame update ----------
  function update(){
    if (pillT && performance.now()>pillT){ pill.classList.remove('show'); pillT=0; }
    const s = state.sel;
    if (!s){ ghost.visible=false; highlight.visible=false; return; } // nothing selected -> skip raycast
    const h = pointUnderPointer();
    if (h && s){
      if (s.type==='ground'){               // grid-snapped tile highlight
        highlight.visible=true; ghost.visible=false;
        const p=world.cellCenter(h.gx,h.gz); highlight.position.set(p.x,0.03,p.z);
        highlight.material.color.set(0x4aa3ff);
      } else if (s.type==='delete'){         // free cursor marker (delete radius)
        highlight.visible=true; ghost.visible=false;
        highlight.position.set(h.x,0.03,h.z);
        highlight.material.color.set(0xff5d5d);
      } else if (ghost.children.length){
        highlight.visible=false; ghost.visible=true; applyGhostTransform(h);
      }
    } else {
      ghost.visible=false; highlight.visible=false;
    }
  }

  return { update, setSel, renderItems, tapAt, rotate, cancel, setHover, hideHover };
}

function makeHighlight(){
  const geo = new THREE.PlaneGeometry(1,1);
  const mat = new THREE.MeshBasicMaterial({ color:0x4aa3ff, transparent:true, opacity:0.35, depthWrite:false });
  const m = new THREE.Mesh(geo, mat); m.rotation.x=-Math.PI/2;
  // edge outline
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color:0xffffff, transparent:true, opacity:0.6 }));
  edge.rotation.x=-Math.PI/2; edge.position.y=0.001; m.add(edge);
  return m;
}
