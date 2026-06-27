import * as THREE from 'three';
import { createEngine, ModelLibrary } from './engine.js';
import { MODELS } from './manifest.js';
import { World, GROUND_MODEL } from './world.js';
import { buildingModelIds } from './buildings.js';
import { Traffic } from './traffic.js';
import { initUI } from './ui.js';

const SAVE_KEY = 'citysandbox.save.v1';
const GRID = 64;

const loader = document.getElementById('loader');
const bar = document.querySelector('#bar > i');
const loadmsg = document.getElementById('loadmsg');
function setProgress(p, msg){ bar.style.width = Math.round(p*100)+'%'; if(msg) loadmsg.textContent=msg; }

async function boot(){
  const app = document.getElementById('app');
  const eng = createEngine(app);
  const lib = new ModelLibrary();
  lib.register(MODELS);

  setProgress(0.05, '加载模型…');

  // models needed up-front (generation + ground)
  const preload = new Set([
    ...Object.values(GROUND_MODEL).filter(Boolean),
    ...buildingModelIds(),
    'tree-large','tree-small','tree-pine-large','tree-pine-small',
    'tree-park-large','tree-park-pine-large','tree-shrub','grass-hill',
    'detail-light-single','detail-bench',
    'truck-green','truck-grey','truck-flat','truck-green-cargo','truck-grey-cargo',
  ]);
  await lib.preload([...preload], (d,t)=> setProgress(0.05 + 0.8*(d/t), `加载模型 ${d}/${t}`));

  setProgress(0.9, '生成城市…');
  const world = new World(eng.scene, lib, GRID);
  const uictx = { ...eng, world, lib };
  const ui = initUI(uictx);
  const traffic = new Traffic(world);
  window.GAME = { eng, world, lib, ui, traffic, ctx: uictx };

  // sun target follows camera focus a bit (keeps shadows centered)
  const seedInput = document.getElementById('seedInput');

  // ---------- stats / toast ----------
  const statsEl = document.getElementById('stats');
  let objCount = 0;
  function updateStats(){ objCount = world.count().objects; }
  let toastT = 0;
  function toast(t){ const c=document.getElementById('toolchip'); if(!c._old) c._old=c.innerHTML; c.innerHTML='<b>'+t+'</b>'; toastT=performance.now()+1100; }

  function regen(seed){
    const s = (seed===undefined || seed==='') ? (Math.random()*1e9|0) : seed;
    seedInput.value = s;
    world.generate(s);
    updateStats();
  }
  regen(Math.random()*1e9|0);

  setProgress(1, '完成');
  setTimeout(()=>{ loader.style.opacity='0'; loader.style.transition='opacity .5s'; setTimeout(()=>loader.remove(),500); }, 150);

  // ---------- topbar ----------
  document.getElementById('btnRegen').onclick = ()=> regen();
  seedInput.addEventListener('keydown', e=>{ if(e.key==='Enter'){ regen(seedInput.value.trim()); e.target.blur(); } });
  document.getElementById('btnGrid').onclick = ()=>{
    world._gridOn = !world._gridOn; world.setGridVisible(world._gridOn);
  };
  const btnSnap = document.getElementById('btnSnap');
  btnSnap.onclick = ()=>{
    world.snap = !world.snap;
    btnSnap.textContent = '⊞ 吸附:' + (world.snap?'开':'关');
    btnSnap.classList.toggle('primary', world.snap);
    if (world.snap) world.setGridVisible(true), world._gridOn=true;
  };
  const btnTraffic = document.getElementById('btnTraffic');
  btnTraffic.onclick = ()=>{
    traffic.enabled = !traffic.enabled;
    btnTraffic.textContent = '🚗 行驶:' + (traffic.enabled?'开':'关');
    btnTraffic.classList.toggle('primary', traffic.enabled);
  };
  document.getElementById('btnClear').onclick = ()=>{ if(confirm('清空整个地图？')){ world.clearAll(); updateStats(); } };
  document.getElementById('btnSave').onclick = ()=>{
    try{ localStorage.setItem(SAVE_KEY, JSON.stringify(world.serialize())); toast('已保存 ✓'); }
    catch(e){ toast('保存失败'); }
  };
  document.getElementById('btnLoad').onclick = async ()=>{
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw){ toast('没有存档'); return; }
    let data; try{ data=JSON.parse(raw); }catch(e){ toast('存档损坏'); return; }
    // preload any models referenced in the save (v2: [kind,id,...]; v1: [cellKey,kind,id,...])
    const ids = new Set();
    for (const o of data.objects||[]){
      if (o.length>=6){ if (o[0]==='model' && o[1]) ids.add(o[1]); }
      else { if (o[1]==='model' && o[2]) ids.add(o[2]); }
    }
    await lib.preload([...ids]);
    if (world.deserialize(data)){ seedInput.value = data.seedStr||''; updateStats(); toast('已读取 ✓'); }
    else toast('存档不兼容');
  };

  // ---------- render loop ----------
  const clock = new THREE.Clock();
  let fpsT=performance.now(), frames=0, fps=0;
  function frame(){
    const dt = Math.min(clock.getDelta(), 0.05);
    eng.god.update(dt);
    traffic.update(dt);
    // keep sun/shadow box centered on view target
    eng.sun.position.set(eng.god.target.x+34, 52, eng.god.target.z+22);
    eng.sun.target.position.copy(eng.god.target); eng.sun.target.updateMatrixWorld();
    ui.update();
    eng.renderer.render(eng.scene, eng.camera);

    frames++; const now=performance.now();
    if (now-fpsT>500){ fps=Math.round(frames*1000/(now-fpsT)); frames=0; fpsT=now;
      statsEl.textContent = `物体 ${objCount} · ${fps} fps · 网格 ${GRID}×${GRID}`; }
    if (toastT && now>toastT){ const c=document.getElementById('toolchip'); if(c._old){ c.innerHTML=c._old; c._old=null; } toastT=0; }
    requestAnimationFrame(frame);
  }
  frame();
}

boot().catch(e=>{ console.error(e); document.getElementById('loadmsg').textContent='出错: '+e.message; });
