import * as THREE from 'three';

// Touch gestures for the god camera + build tools (mobile / touchscreen):
//   1 finger tap   -> use the current tool at that point (place / erase / paint)
//   1 finger drag  -> pan the map
//   2 finger pinch -> zoom, twist -> rotate view, drag -> pan
// Mouse/pen pointers are ignored here (handled by GodCamera + the UI).
export class TouchControls {
  constructor(god, ui, dom){
    this.god = god; this.ui = ui; this.dom = dom;
    this.pts = new Map();      // pointerId -> {x,y}
    this.mode = 'none';        // 'tap' | 'pan' | 'gesture'
    this.moved = 0;
    this.tapStart = null;
    this.prev = null;          // last two-finger snapshot
    this._bind();
  }
  _bind(){
    const d = this.dom;
    d.addEventListener('pointerdown', e=>{
      if (e.pointerType !== 'touch') return;
      this.pts.set(e.pointerId, { x:e.clientX, y:e.clientY });
      if (this.pts.size === 1){
        this.mode = 'tap'; this.moved = 0;
        this.tapStart = { x:e.clientX, y:e.clientY, t:performance.now() };
        this.ui.setHover(e.clientX, e.clientY);   // show ghost preview under the finger
      } else if (this.pts.size === 2){
        this.mode = 'gesture'; this.prev = this._twoInfo(); this.ui.hideHover();
      } else {
        this.mode = 'none'; this.ui.hideHover();
      }
    });
    d.addEventListener('pointermove', e=>{
      if (e.pointerType !== 'touch') return;
      const p = this.pts.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (this.mode === 'gesture' && this.pts.size >= 2){
        this._gesture();
      } else if (this.pts.size === 1 && (this.mode === 'tap' || this.mode === 'pan')){
        this.moved += Math.hypot(dx, dy);
        if (this.mode === 'tap' && this.moved > 10){ this.mode = 'pan'; this.ui.hideHover(); }
        if (this.mode === 'pan') this.god._panScreen(dx, dy);
        else this.ui.setHover(e.clientX, e.clientY);   // still a tap -> move the ghost
      }
    });
    const end = e=>{
      if (e.pointerType !== 'touch') return;
      const wasTap = this.mode === 'tap' && this.pts.size === 1;
      this.pts.delete(e.pointerId);
      if (wasTap && this.tapStart && (performance.now() - this.tapStart.t) < 500 && this.moved < 10){
        this.ui.tapAt(this.tapStart.x, this.tapStart.y);
      }
      if (this.pts.size === 0){ this.mode = 'none'; this.prev = null; this.ui.hideHover(); }
      else if (this.pts.size === 1){ this.mode = 'none'; } // after a gesture, wait for full lift
    };
    d.addEventListener('pointerup', end);
    d.addEventListener('pointercancel', end);
  }
  _twoInfo(){
    const [a,b] = [...this.pts.values()];
    return {
      dist: Math.hypot(a.x-b.x, a.y-b.y),
      ang:  Math.atan2(b.y-a.y, b.x-a.x),
      mx: (a.x+b.x)/2, my: (a.y+b.y)/2,
    };
  }
  _gesture(){
    const cur = this._twoInfo(), prev = this.prev;
    if (!prev){ this.prev = cur; return; }
    const g = this.god;
    if (cur.dist > 1 && prev.dist > 1){
      g.dist = THREE.MathUtils.clamp(g.dist * (prev.dist/cur.dist), g.minDist, g.maxDist);
    }
    let da = cur.ang - prev.ang;
    while (da >  Math.PI) da -= Math.PI*2;
    while (da < -Math.PI) da += Math.PI*2;
    g.yaw -= da;                                 // twist to rotate view
    g._panScreen(cur.mx - prev.mx, cur.my - prev.my); // two-finger drag pans
    this.prev = cur;
  }
}
