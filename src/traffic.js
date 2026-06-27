// Vehicle AI: trucks find the nearest asphalt road, then roam the road network
// on random routes. They never leave asphalt cells.

export class Traffic {
  constructor(world){
    this.world = world;
    this.cars = new Map();     // oid -> car state
    this.enabled = true;
    this.speed = 2.2;          // base speed, cells/sec
    this.facingOffset = Math.PI; // Kenney truck cab sits at -Z; flip so the cab leads
  }
  isTruck(rec){ return rec.kind==='model' && rec.id && rec.id.startsWith('truck'); }

  // keep car states in sync with the trucks currently in the world
  reconcile(){
    const w = this.world;
    for (const rec of w.objects.values()){
      if (this.isTruck(rec) && !this.cars.has(rec.oid)) this.cars.set(rec.oid, this._init(rec));
    }
    for (const oid of [...this.cars.keys()]){
      if (!w.objects.has(oid)) this.cars.delete(oid);
    }
  }
  _init(rec){
    return {
      oid:rec.oid, rec, group:rec.group,
      hasCell:false, gx:0, gz:0,            // current road cell
      hasNext:false, ngx:0, ngz:0, t:0,     // segment to next cell
      fx:9999, fz:9999,                      // cell we came from (avoid U-turns)
      yaw:rec.group.rotation.y,
      speed:this.speed*(0.8+Math.random()*0.5),
    };
  }

  update(dt){
    this.reconcile();
    if (!this.enabled) return;
    if (dt > 0.1) dt = 0.1; // avoid big jumps after tab was inactive
    for (const s of this.cars.values()) this._drive(s, dt);
  }

  _drive(s, dt){
    const w = this.world, g = s.group;

    // (1) not yet on a road: drive straight toward the nearest asphalt cell
    if (!s.hasCell){
      const near = w.nearestGround(g.position.x, g.position.z, 'asphalt');
      if (!near) return;                      // no roads exist -> idle
      const c = w.cellCenter(near.gx, near.gz);
      const dx = c.x-g.position.x, dz = c.z-g.position.z, dist = Math.hypot(dx,dz);
      if (dist < 0.06){
        g.position.set(c.x, 0, c.z);
        s.gx=near.gx; s.gz=near.gz; s.hasCell=true; s.hasNext=false; s.fx=9999; s.fz=9999;
      } else {
        const step = Math.min(dist, s.speed*dt);
        g.position.x += dx/dist*step; g.position.z += dz/dist*step;
        this._faceTo(s, dx, dz, dt);
      }
      this._syncRec(s); return;
    }

    // car left the road (e.g. its cell was repainted)? -> re-approach
    if (!w.isAsphalt(s.gx, s.gz)){ s.hasCell=false; s.hasNext=false; return; }

    // (2) choose next road cell (random route, avoid immediate U-turn)
    if (!s.hasNext){
      const nb = this._roadNeighbors(s.gx, s.gz, s.fx, s.fz);
      if (nb.length === 0) return;             // isolated cell -> idle
      const pick = nb[(Math.random()*nb.length)|0];
      s.ngx=pick[0]; s.ngz=pick[1]; s.t=0; s.hasNext=true;
    }

    // (3) advance along the current segment (cells are 1 unit apart)
    const a = w.cellCenter(s.gx, s.gz), b = w.cellCenter(s.ngx, s.ngz);
    s.t += s.speed * dt;
    if (s.t >= 1){
      g.position.set(b.x, 0, b.z);
      s.fx=s.gx; s.fz=s.gz; s.gx=s.ngx; s.gz=s.ngz; s.hasNext=false;
    } else {
      g.position.x = a.x + (b.x-a.x)*s.t;
      g.position.z = a.z + (b.z-a.z)*s.t;
    }
    this._faceTo(s, b.x-a.x, b.z-a.z, dt);
    this._syncRec(s);
  }

  _faceTo(s, dx, dz, dt){
    if (dx===0 && dz===0) return;
    const target = Math.atan2(dx, dz) + this.facingOffset;
    let d = target - s.yaw;
    while (d >  Math.PI) d -= Math.PI*2;
    while (d < -Math.PI) d += Math.PI*2;
    s.yaw += d * Math.min(1, dt*9);            // smooth turn
    s.group.rotation.y = s.yaw;
  }

  _roadNeighbors(gx, gz, fx, fz){
    const w = this.world;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    const out = [];
    for (const [dx,dz] of dirs){
      const x=gx+dx, z=gz+dz;
      if (w.isAsphalt(x,z) && !(x===fx && z===fz)) out.push([x,z]);
    }
    if (out.length===0){                       // dead end: U-turn allowed
      for (const [dx,dz] of dirs){ const x=gx+dx,z=gz+dz; if (w.isAsphalt(x,z)) out.push([x,z]); }
    }
    return out;
  }

  _syncRec(s){ s.rec.x = s.group.position.x; s.rec.z = s.group.position.z; }
}
