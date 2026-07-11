import * as THREE from 'three';
import { createEngine, ModelLibrary } from './engine.js';
import { MODELS } from './manifest.js';
import { World, GROUND_MODEL } from './world.js';
import { buildingModelIds } from './buildings.js';
import { Traffic } from './traffic.js';
import { DayNight } from './daynight.js';
import { TouchControls } from './touch.js';
import { initUI } from './ui.js';

const SAVE_KEY = 'citysandbox.save.v1';
const GRID = 64;

const loader = document.getElementById('loader');
const bar = document.querySelector('#bar > i');
const loadmsg = document.getElementById('loadmsg');
function setProgress(p, msg){ bar.style.width = Math.round(p*100)+'%'; if(msg) loadmsg.textContent=msg; }

// surface any early crash on the loading screen instead of hanging on it
const isMobile = matchMedia('(pointer: coarse)').matches || ('ontouchstart' in window)
  || /Android|iPhone|iPad|iPod|Mobile|MicroMessenger/i.test(navigator.userAgent);
function showLoadError(msg){ const el=document.getElementById('loadmsg'); if(el && !window.__gameReady) el.textContent=msg; }
window.addEventListener('error', e=> showLoadError('加载出错：'+(e.message||'')));
window.addEventListener('unhandledrejection', e=> showLoadError('加载出错：'+((e.reason&&e.reason.message)||e.reason||'')));

async function boot(){
  const app = document.getElementById('app');
  if (!window.WebGLRenderingContext){ showLoadError('此浏览器不支持 WebGL，请用 Chrome/Safari 打开'); return; }
  let eng;
  try { eng = createEngine(app, { mobile:isMobile }); }
  catch(err){ showLoadError('WebGL 初始化失败，请更新浏览器或换 Chrome 打开'); throw err; }
  if (isMobile) document.body.classList.add('mobile');
  const lib = new ModelLibrary();
  lib.register(MODELS);

  setProgress(0.05, '加载模型…');

  // models needed up-front (generation + ground)
  const preload = new Set([
    ...Object.values(GROUND_MODEL).filter(Boolean),
    ...buildingModelIds(),
    'tree-large','tree-small','tree-pine-large','tree-pine-small',
    'tree-park-large','tree-park-pine-large','tree-shrub','grass-hill',
    'detail-light-single','detail-light-traffic','detail-bench',
    'truck-green','truck-grey','truck-flat','truck-green-cargo','truck-grey-cargo',
  ]);
  await lib.preload([...preload], (d,t)=> setProgress(0.05 + 0.8*(d/t), `加载模型 ${d}/${t}`));

  setProgress(0.9, '生成城市…');
  const world = new World(eng.scene, lib, GRID);
  const uictx = { ...eng, world, lib };
  const ui = initUI(uictx);
  const traffic = new Traffic(world);
  const daynight = new DayNight(eng, 8); // start at 08:00
  window.GAME = { eng, world, lib, ui, traffic, daynight, ctx: uictx };

  // clock HUD: click to cycle time speed (1× / 6× / 30× / pause)
  // touch / mobile support: detect a coarse pointer, enable gestures + mobile UI
  new TouchControls(eng.god, ui, eng.renderer.domElement);
  document.getElementById('mRotate').onclick = ()=> ui.rotate();
  document.getElementById('mCancel').onclick = ()=> ui.cancel();

  const clockEl = document.getElementById('clock');
  const clockIcon = document.getElementById('clockIcon');
  const clockTime = document.getElementById('clockTime');
  const clockRate = document.getElementById('clockRate');
  clockEl.onclick = ()=>{ const r = daynight.cycleRate(); clockRate.textContent = r===0 ? '⏸' : (r+'×'); };

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
  window.__gameReady = true;
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
    world.followGround(eng.god.target); // keep infinite ground/grid under the camera
    traffic.update(dt);
    daynight.update(dt, eng.god.target); // advance time; drive sun/sky/fog/exposure
    ui.update();
    eng.renderer.render(eng.scene, eng.camera);

    clockTime.textContent = daynight.hhmm(); clockIcon.textContent = daynight.icon();
    frames++; const now=performance.now();
    if (now-fpsT>500){ fps=Math.round(frames*1000/(now-fpsT)); frames=0; fpsT=now;
      statsEl.textContent = `物体 ${objCount} · ${fps} fps · 网格 ${GRID}×${GRID}`; }
    if (toastT && now>toastT){ const c=document.getElementById('toolchip'); if(c._old){ c.innerHTML=c._old; c._old=null; } toastT=0; }
    requestAnimationFrame(frame);
  }
  frame();
}

boot().catch(e=>{ console.error(e); document.getElementById('loadmsg').textContent='出错: '+e.message; });
