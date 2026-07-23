// Achievement system: unlock conditions + top-left toast popups.
// Unlocks persist in localStorage so each achievement only pops once.

const DEFS = {
  geographer: { name:'地理学家', desc:'首次放置地面',     icon:'🗺️' },
  engineer:   { name:'工程师',   desc:'放置 10 个建筑',   icon:'🏗️' },
  metropolis: { name:'繁华都市', desc:'车辆数量达到 40',  icon:'🌆' },
};
const KEY = 'citysandbox.achievements';

export class Achievements {
  constructor(){
    let d = {};
    try { d = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch(e){}
    this.unlocked  = new Set(d.unlocked || []);
    this.buildings = d.buildings | 0;      // lifetime manually-placed buildings
  }
  _save(){
    try { localStorage.setItem(KEY, JSON.stringify({ unlocked:[...this.unlocked], buildings:this.buildings })); } catch(e){}
  }
  unlock(id){
    if (this.unlocked.has(id)) return;
    this.unlocked.add(id); this._save();
    const def = DEFS[id]; if (def) toast(def);
  }
  onGroundPlaced(){ this.unlock('geographer'); }
  onBuildingPlaced(){
    this.buildings++; this._save();
    if (this.buildings >= 10) this.unlock('engineer');
  }
  checkCars(n){ if (n >= 40) this.unlock('metropolis'); }
  // snapshot for the achievements panel (carCount = live vehicles on the map)
  list(carCount = 0){
    const has = id => this.unlocked.has(id);
    return [
      { id:'geographer', ...DEFS.geographer, unlocked:has('geographer'), progress:null },
      { id:'engineer',   ...DEFS.engineer,   unlocked:has('engineer'),
        progress:{ cur:Math.min(this.buildings,10), max:10 } },
      { id:'metropolis', ...DEFS.metropolis, unlocked:has('metropolis'),
        progress:{ cur:Math.min(carCount,40), max:40 } },
    ];
  }
}

function toast(def){
  let wrap = document.getElementById('achWrap');
  if (!wrap){ wrap = document.createElement('div'); wrap.id = 'achWrap'; document.body.appendChild(wrap); }
  const el = document.createElement('div');
  el.className = 'achToast';
  el.innerHTML = `<span class="ic">${def.icon}</span>
    <div><div class="t1">🏆 成就解锁</div><div class="t2">${def.name}</div><div class="t3">${def.desc}</div></div>`;
  wrap.appendChild(el);
  requestAnimationFrame(()=> requestAnimationFrame(()=> el.classList.add('show')));
  setTimeout(()=>{ el.classList.remove('show'); setTimeout(()=> el.remove(), 500); }, 4200);
}
