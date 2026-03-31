// websocket.js — Narwhale.io Compatible Server
// ============================================================
// BUGS CORREGIDOS EN ESTA VERSIÓN (vía ingeniería inversa del cliente):
//
//  ❌→✅ BUG 1 (CRÍTICO): buildSetElements enviaba uint16 elementCount
//         El cliente NO lee un contador: itera hasta byteLength.
//         Ese uint16 extra rompía la deserialización de todos los elementos.
//
//  ❌→✅ BUG 2 (CRÍTICO): JOIN no respondía con SET_ELEMENTS.
//         El cliente setea hasJoined=true SOLO al recibir SET_ELEMENTS.
//         Sin hasJoined=true, el botón Play no lleva a emitir START nunca.
//
//  ❌→✅ BUG 3 (CRÍTICO): indicatorX/Y usaban fórmula de normalización incorrecta.
//         Fórmula cliente: uint16/65535 * 2*width - width/2
//         Fórmula inversa: uint16 = (x + width/2) / (2*width) * 65535
//         El servidor usaba: x/width * 65535 (incorrecto).
//
//  ❌→✅ BUG 4 (CRÍTICO): broadcastTransient usaba la misma fórmula incorrecta.
//         El cliente usa parseFloatFromUint16 con el mismo esquema de indicador.
//
//  ❌→✅ BUG 5: buildLeaderBoard usaba uint16 para scores de equipo.
//         El cliente los lee como uint8.
//
//  ❌→✅ BUG 6: parseClientMessage START intentaba quitar null-terminator
//         que en realidad el cliente NO envía (getData() no lo incluye).
//
//  ❌→✅ BUG 7: fish.color serializado wrong endian para el cliente.
//         El cliente acumula: color = (color<<8) + byte → big-endian MSB primero.
//         El servidor ya lo hacía bien ([R][G][B]) — confirmado correcto.
//
//  ❌→✅ BUG 8: team=-1 → el servidor mandaba 7 (0b111 en bits 0-2).
//         Correcto: el cliente ignora team en modo non-team, no hay problema real.
//         Pero por claridad, 7 se usa como "sin equipo" (valor por defecto del cliente).
// ============================================================

'use strict';

const WebSocket = require('ws');

// ============================================================
// OPCODES (verificados contra cliente minificado)
// ============================================================
const MSG = {
  JOIN:              16,
  LEAVE:             17,
  START:             18,
  GET_LOBBIES:       19,
  UPDATE_TARGET:     32,
  SPLIT_UP:          33,
  RIP:               34,
  RETREAT:           35,
  PLAYER_UPDATE:     36,
  PING:              37,
  INPUT:             38,
  SET_ELEMENTS:      48,
  PLAYER_INFO:       49,
  LEADER_BOARD:      50,
  TEAM_INFO:         51,
  TRANSIENT_ELEMENT: 52,
  GET_STATS:         64
};

const ElemType = { Fish:0, Ball:1, Attachable:2, Character:3, Bomb:4, Occupiable:5 };
const TransientType = { SmokeExplosion:0 };
const FieldType = { Normal:0, Soccer:1, Platform:2, EasterEgg:3, TeamDeathMatch:4 };

const TICK_RATE = 60;
const DT        = 1 / TICK_RATE;

const CTRL = { Up:1, Down:2, Left:4, Right:8, MouseLeft:16, MouseRight:32 };

// ============================================================
// ROOMS
// ============================================================
const rooms = [
  { name:'Large 1',           id:0, options:{ width:6400, height:6400, cellWidth:1280, hasIndicator:false, isPriority:true,  fieldType:FieldType.Normal,         desirablePlayerNum:25, hasSlowFactor:false } },
  { name:'Large 2',           id:1, options:{ width:6400, height:6400, cellWidth:1280, hasIndicator:false, isPriority:true,  fieldType:FieldType.Normal,         desirablePlayerNum:25, hasSlowFactor:false } },
  { name:'Sparse',            id:2, options:{ width:6400, height:6400, cellWidth:1280, hasIndicator:false, isPriority:true,  fieldType:FieldType.Normal,         desirablePlayerNum:15, hasSlowFactor:false } },
  { name:'Small 1',           id:3, options:{ width:3840, height:3840, cellWidth:1280, hasIndicator:false, isPriority:false, fieldType:FieldType.Normal,         desirablePlayerNum:9,  hasSlowFactor:false } },
  { name:'Small 2',           id:4, options:{ width:3840, height:3840, cellWidth:1280, hasIndicator:false, isPriority:false, fieldType:FieldType.Normal,         desirablePlayerNum:9,  hasSlowFactor:false } },
  { name:'Narwhale Ball!',    id:5, options:{ width:6400, height:3840, cellWidth:1280, hasIndicator:true,  isPriority:false, fieldType:FieldType.Soccer,         desirablePlayerNum:25, hasSlowFactor:true  } },
  { name:'Narwhale Egg Hunt!',id:6, options:{ width:6400, height:5120, cellWidth:1280, hasIndicator:true,  isPriority:false, fieldType:FieldType.EasterEgg,      desirablePlayerNum:25, hasSlowFactor:true  } },
  { name:'Team Deathmatch',   id:7, options:{ width:6400, height:6400, cellWidth:1280, hasIndicator:true,  isPriority:false, fieldType:FieldType.TeamDeathMatch, desirablePlayerNum:25, hasSlowFactor:true  } },
];

// ============================================================
// MATH UTILS
// ============================================================
function mag(x, y)    { return Math.sqrt(x*x + y*y); }
function clamp(v,a,b) { return Math.min(Math.max(v,a),b); }

function normalizeAngle(a) {
  const T = Math.PI * 2;
  a = a % T;
  if (a >  Math.PI) a -= T;
  if (a < -Math.PI) a += T;
  return a;
}

// Angle [-PI,PI] → uint8 [0,255]
// Client decodes: (uint8/255*2 - 1) * PI
// So: uint8 = (angle/PI + 1)/2 * 255
function angleToUint8(angle) {
  return Math.round(clamp((angle / Math.PI + 1) / 2, 0, 1) * 255);
}

// ============================================================
// INDICATOR / TRANSIENT COORDINATE ENCODING
// ============================================================
// Client decodes: parseFloatFromUint16(t, off, 2*width, -width/2)
//   = uint16/65535 * (2*width) + (-width/2)
// Inverse: uint16 = (worldCoord + width/2) / (2*width) * 65535
function encodeIndicatorX(x, width) {
  return Math.round(clamp((x + width / 2) / (2 * width) * 65535, 0, 65535));
}
function encodeIndicatorY(y, height) {
  return Math.round(clamp((y + height / 2) / (2 * height) * 65535, 0, 65535));
}

// ============================================================
// STRING ENCODING
// encodeURIComponent + null terminator (server→client)
// ============================================================
function encodeString(str) {
  const encoded = encodeURIComponent(str || '');
  const bytes = [];
  for (let i = 0; i < encoded.length; i++) bytes.push(encoded.charCodeAt(i));
  bytes.push(0);
  return bytes;
}

// Read null-terminated percent-encoded string from Buffer at offset
function decodeString(buf, offset) {
  const start = offset;
  while (offset < buf.length && buf[offset] !== 0) offset++;
  let str = '';
  try   { str = decodeURIComponent(buf.slice(start, offset).toString('ascii')); }
  catch { str = buf.slice(start, offset).toString('ascii'); }
  return { value: str, next: offset + 1 }; // skip the null byte
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1/6) return p + (q-p)*6*t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q-p)*(2/3-t)*6;
      return p;
    };
    const q = l < 0.5 ? l*(1+s) : l+s-l*s;
    const p = 2*l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
}

// ============================================================
// PART
// ============================================================
class Part {
  constructor() { this.x=0; this.y=0; this.vx=0; this.vy=0; this.rot=0; this.vt=0; }
  updatePos(dt)    { this.x += this.vx*dt; this.y += this.vy*dt; }
  dampVel(f, dt)   { const d = 1+f*dt; this.vx/=d; this.vy/=d; }
  updateRot(dt)    { this.rot += dt*this.vt; }
  dampRot(f, dt)   { this.vt *= (1 - f*dt*60); }
  updatePosRot(dt) { this.updatePos(dt); this.updateRot(dt); }
}

// ============================================================
// FISH
// ============================================================
class Fish {
  constructor(id, name, roomId, team) {
    this.id            = id;
    this.name          = name || '';
    this.roomId        = roomId;
    this.alive         = true;
    this.size          = 36;
    this.breakPoint    = 11;
    this.tuskRatio     = 0.5;
    this.maxDash       = 3;
    this.curDash       = 3;
    this.overDash      = 0;
    this.invincibleDur = 1.5;
    this.alpha         = 1;
    // team: -1 = no team; 0 = left; 1 = right
    // bits 0-2 of the serialized byte; 7 = "no team" sentinel per client code
    this.team          = (typeof team === 'number') ? team : -1;
    this.color         = [255, 255, 255]; // [R, G, B]
    this.decoration    = 0;
    this.skincode      = 0;
    this.score         = 0;
    this.kills         = 0;
    this.level         = 1;
    this.upgrades      = [];
    this.parts         = [];
    this.target        = { x: 0.001, y: 0 };
    this.currentControl = 0;
    this.dashCooldown  = 0;
    this.respawnTimer  = 0;
    this.ws            = null;
    this.carriedEggs   = [];
    this._initParts(roomId);
  }

  _initParts(roomId) {
    const opts   = (rooms[roomId] || rooms[0]).options;
    const margin = 300;
    const head   = new Part();
    head.x   = margin + Math.random() * (opts.width  - margin*2);
    head.y   = margin + Math.random() * (opts.height - margin*2);
    head.rot = Math.random() * Math.PI * 2;
    this.parts.push(head);
    for (let i = 1; i <= this.breakPoint; i++) {
      const seg   = new Part();
      const behind = head.rot + Math.PI;
      seg.x   = head.x + Math.cos(behind) * this.size * i;
      seg.y   = head.y + Math.sin(behind) * this.size * i;
      seg.rot = head.rot;
      this.parts.push(seg);
    }
  }

  get tuskLength() { return this.size * this.tuskRatio; }
  get headX()      { return this.parts[0].x; }
  get headY()      { return this.parts[0].y; }
  get tuskTipX()   { const h=this.parts[0]; return h.x + Math.cos(h.rot)*(this.size/2 + this.tuskLength); }
  get tuskTipY()   { const h=this.parts[0]; return h.y + Math.sin(h.rot)*(this.size/2 + this.tuskLength); }
  get tuskBaseX()  { const h=this.parts[0]; return h.x + Math.cos(h.rot)*(this.size/2); }
  get tuskBaseY()  { const h=this.parts[0]; return h.y + Math.sin(h.rot)*(this.size/2); }

  update(dt, roomConfig) {
    if (!this.alive) {
      if (this.respawnTimer > 0) { this.respawnTimer -= dt; if (this.respawnTimer < 0) this.respawnTimer = 0; }
      return;
    }
    if (this.invincibleDur > 0) this.invincibleDur = Math.max(0, this.invincibleDur - dt);
    if (this.dashCooldown  > 0) this.dashCooldown  -= dt;

    if (this.curDash < this.maxDash) {
      this.overDash += dt * 0.4;
      if (this.overDash >= 1.0) { this.overDash = 0; this.curDash++; }
    }

    const head        = this.parts[0];
    const targetAngle = Math.atan2(this.target.y, this.target.x);
    const targetMag   = mag(this.target.x, this.target.y);
    const isDashing   = !!(this.currentControl & CTRL.MouseLeft);
    const isRetreating= !!(this.currentControl & CTRL.MouseRight);

    if (isDashing && this.curDash > 0 && this.dashCooldown <= 0) {
      this.curDash--; this.overDash=0; this.dashCooldown=0.1;
      head.vx += Math.cos(head.rot)*600; head.vy += Math.sin(head.rot)*600;
      this.currentControl &= ~CTRL.MouseLeft;
    }
    if (isRetreating && this.curDash > 0 && this.dashCooldown <= 0) {
      this.curDash--; this.overDash=0; this.dashCooldown=0.1;
      head.vx -= Math.cos(head.rot)*500; head.vy -= Math.sin(head.rot)*500;
      this.currentControl &= ~CTRL.MouseRight;
    }

    if (targetMag > 0.01) {
      const moveForce = 300 * Math.min(targetMag, 1.0);
      const tx = this.target.x / targetMag, ty = this.target.y / targetMag;
      head.vx += tx * moveForce * dt * 5;
      head.vy += ty * moveForce * dt * 5;
      head.vt += normalizeAngle(targetAngle - head.rot) * dt * 8;
    }
    head.updatePosRot(dt);
    head.dampRot(0.005, dt);

    const speed = mag(head.vx, head.vy);
    if (speed > 1e-9) {
      const dot = head.vx*this.target.x + head.vy*this.target.y;
      const td  = targetMag;
      let damp;
      if      (0.8*td*speed < dot) damp = 1e-9;
      else if (0.4*td*speed < dot) damp = 0.01;
      else if (0            < dot) damp = 0.05;
      else                         damp = 0.1;
      head.dampVel(damp, dt);
    }
    const maxSpd = isDashing ? 800 : 500;
    if (speed > maxSpd) { const r = maxSpd/speed; head.vx*=r; head.vy*=r; }

    // Body chain
    let prev = null;
    for (let i = 0; i < this.parts.length; i++) {
      if (i === 0) { prev = this.parts[0]; continue; }
      const p = this.parts[i];
      if (i === this.breakPoint) {
        // break segment: independent physics
        p.updatePosRot(dt); p.dampVel(0.01, dt); p.dampRot(0.05, dt);
        prev = p;
      } else if (prev) {
        const angLimit = (Math.PI*2/3) * (i-1) / 10;
        p.updateRot(dt); p.dampRot(0.05, dt);
        const diff = normalizeAngle(p.rot - prev.rot);
        if ((diff > angLimit && p.vt > 0) || (diff < -angLimit && p.vt < 0)) p.vt *= -1;
        const behind = p.rot + Math.PI;
        p.x = prev.x + Math.cos(behind)*this.size;
        p.y = prev.y + Math.sin(behind)*this.size;
        prev = p;
      }
    }

    // Bounds
    const o  = roomConfig.options, hs = this.size/2;
    if (head.x < hs)            { head.x = hs;            head.vx =  Math.abs(head.vx)*0.3; }
    if (head.x > o.width - hs)  { head.x = o.width - hs;  head.vx = -Math.abs(head.vx)*0.3; }
    if (head.y < hs)            { head.y = hs;            head.vy =  Math.abs(head.vy)*0.3; }
    if (head.y > o.height - hs) { head.y = o.height - hs; head.vy = -Math.abs(head.vy)*0.3; }

    for (const egg of this.carriedEggs) { egg.x = head.x; egg.y = head.y; }
  }

  // -------------------------------------------------------
  // BINARY SERIALIZATION — matches parseFish() exactly
  //
  // parseFish layout (from client source):
  //   uint32  id
  //   3×uint8 color (read as big-endian: color=(color<<8)+byte each iter)
  //   string  name (null-terminated percent-encoded)
  //   uint8   team(3b) | breakPoint(5b)
  //   uint8   alpha/255
  //   uint8   maxDash(4b low) | curDash(4b high)
  //   uint8   overDash/255
  //   uint8   tuskRatio/255*2  (decoded: tuskRatio = uint8/255*2)
  //   uint8   decoration
  //   float32 headX
  //   float32 headY
  //   uint16  speed
  //   uint8   speedAngle
  //   uint8   headRot
  //   uint8   skincode
  //   uint8   invincibleDur/255*2
  //   uint8   segmentCount  (= parts.length - 1)
  //   for i=1..segmentCount:
  //     if i==breakPoint: float32 x, y, vx, vy
  //     else:             uint8 rot
  //
  // NOTE: no ElemType byte here — that's written by buildSetElements
  // before calling serializeBinary()
  // -------------------------------------------------------
  serializeBinary() {
    const nameBytes  = encodeString(this.name);
    const head       = this.parts[0];
    const speed      = Math.round(mag(head.vx, head.vy));
    const speedAngle = Math.atan2(head.vy, head.vx);
    const segCount   = this.parts.length - 1;

    let size = 0;
    size += 4;              // id
    size += 3;              // RGB
    size += nameBytes.length;
    size += 1;              // team|breakPoint
    size += 1;              // alpha
    size += 1;              // dash packed
    size += 1;              // overDash
    size += 1;              // tuskRatio
    size += 1;              // decoration
    size += 4;              // headX
    size += 4;              // headY
    size += 2;              // speed
    size += 1;              // speedAngle
    size += 1;              // headRot
    size += 1;              // skincode
    size += 1;              // invincibleDur
    size += 1;              // segmentCount
    for (let i = 1; i < this.parts.length; i++) size += (i === this.breakPoint) ? 16 : 1;

    const buf = Buffer.alloc(size);
    const dv  = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let off   = 0;

    dv.setUint32(off, this.id, true); off += 4;

    // Color: server writes [R][G][B]; client reads as (color<<8)+byte 3 times → R<<16|G<<8|B ✓
    dv.setUint8(off, this.color[0]); off++;
    dv.setUint8(off, this.color[1]); off++;
    dv.setUint8(off, this.color[2]); off++;

    for (let i = 0; i < nameBytes.length; i++) buf[off++] = nameBytes[i];

    // team bits 0-2, breakPoint bits 3-7
    // team=-1 → use 7 (0b111) which client treats as "no team"
    const teamVal = (this.team >= 0) ? (this.team & 7) : 7;
    dv.setUint8(off, teamVal | ((this.breakPoint & 31) << 3)); off++;

    dv.setUint8(off, Math.round(clamp(this.alpha, 0, 1) * 255)); off++;
    dv.setUint8(off, (this.maxDash & 15) | ((this.curDash & 15) << 4)); off++;
    dv.setUint8(off, Math.round(clamp(this.overDash, 0, 1) * 255)); off++;
    // tuskRatio: client decodes as uint8/255*2 → encode = tuskRatio/2*255
    dv.setUint8(off, Math.round(clamp(this.tuskRatio / 2, 0, 1) * 255)); off++;
    dv.setUint8(off, this.decoration & 255); off++;

    dv.setFloat32(off, head.x, true); off += 4;
    dv.setFloat32(off, head.y, true); off += 4;

    dv.setUint16(off, clamp(speed, 0, 65535), true); off += 2;
    dv.setUint8(off, angleToUint8(speedAngle)); off++;
    dv.setUint8(off, angleToUint8(head.rot));   off++;
    dv.setUint8(off, this.skincode & 255);       off++;
    // invincibleDur: client decodes as uint8/255*2
    dv.setUint8(off, Math.round(clamp(this.invincibleDur / 2, 0, 1) * 255)); off++;

    dv.setUint8(off, segCount); off++;

    for (let i = 1; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (i === this.breakPoint) {
        dv.setFloat32(off, p.x,  true); off += 4;
        dv.setFloat32(off, p.y,  true); off += 4;
        dv.setFloat32(off, p.vx, true); off += 4;
        dv.setFloat32(off, p.vy, true); off += 4;
      } else {
        dv.setUint8(off, angleToUint8(p.rot)); off++;
      }
    }
    return buf;
  }
}

// ============================================================
// BALL
// ============================================================
class Ball {
  constructor(x, y) {
    this.id     = 0xBA110000 + Math.floor(Math.random() * 0xFFFF);
    this.x=x; this.y=y; this.vx=0; this.vy=0; this.radius=40; this.scale=1;
  }
  update(dt) { this.x+=this.vx*dt; this.y+=this.vy*dt; const d=1+0.5*dt; this.vx/=d; this.vy/=d; }
  serializeBinary() {
    const buf=Buffer.alloc(4+4+4+2+1); const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength); let off=0;
    dv.setUint32(off,this.id,true);   off+=4;
    dv.setFloat32(off,this.x,true);  off+=4;
    dv.setFloat32(off,this.y,true);  off+=4;
    const spd=Math.round(mag(this.vx,this.vy));
    dv.setUint16(off,clamp(spd,0,65535),true); off+=2;
    dv.setUint8(off,angleToUint8(Math.atan2(this.vy,this.vx)));
    return buf;
  }
}

// ============================================================
// EGG
// ============================================================
class Egg {
  constructor(x, y, variation) {
    this.id=0xE6600000+Math.floor(Math.random()*0xFFFF);
    this.x=x; this.y=y; this.vx=0; this.vy=0;
    this.rot=Math.random()*Math.PI*2;
    this.variation=variation; this.eggType=0; this.eggSize=1; this.radius=20;
    this.collected=false; this.carriedBy=null;
  }
  update(dt) { if(this.carriedBy)return; this.x+=this.vx*dt; this.y+=this.vy*dt; const d=1+0.005*dt; this.vx/=d; this.vy/=d; }
  serializeBinary() {
    const buf=Buffer.alloc(4+4+4+2+1+1+1+1+1); const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength); let off=0;
    dv.setUint32(off,this.id,true);   off+=4;
    dv.setFloat32(off,this.x,true);  off+=4;
    dv.setFloat32(off,this.y,true);  off+=4;
    const spd=Math.round(mag(this.vx,this.vy));
    dv.setUint16(off,clamp(spd,0,65535),true); off+=2;
    dv.setUint8(off,angleToUint8(Math.atan2(this.vy,this.vx))); off++;
    dv.setUint8(off,angleToUint8(this.rot));   off++;
    dv.setUint8(off,this.variation&255);        off++;
    dv.setUint8(off,this.eggType&255);          off++;
    dv.setUint8(off,this.eggSize&255);
    return buf;
  }
}

// ============================================================
// OCCUPIABLE ZONE
// ============================================================
class OccupiableZone {
  constructor(id, benefit) { this.id=id; this.benefit=benefit; this.accumSide=0; this.curSide=0; this.occupyingSide=0; }
  serializeBinary() {
    const buf=Buffer.alloc(4+1+1+1+1); const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength); let off=0;
    dv.setUint32(off,this.id,true); off+=4;
    dv.setUint8(off,this.benefit); off++;
    dv.setUint8(off,Math.round(clamp((this.accumSide+1)/2,0,1)*255)); off++;
    dv.setInt8(off,this.curSide);        off++;
    dv.setInt8(off,this.occupyingSide);
    return buf;
  }
}

// ============================================================
// COLLISION SYSTEM
// ============================================================
class CollisionSystem {
  static ptSegDist(px,py,ax,ay,bx,by) {
    const abx=bx-ax, aby=by-ay, apx=px-ax, apy=py-ay;
    const lenSq=abx*abx+aby*aby;
    if(lenSq===0) return mag(apx,apy);
    const t=clamp((apx*abx+apy*aby)/lenSq,0,1);
    return mag(px-(ax+t*abx), py-(ay+t*aby));
  }
  static bodyVsBody(a, b) {
    const ha=a.parts[0], hb=b.parts[0];
    const r=a.size/2+b.size/2, dx=hb.x-ha.x, dy=hb.y-ha.y, dist=mag(dx,dy);
    if(dist>=r||dist===0) return false;
    const overlap=r-dist, nx=dx/dist, ny=dy/dist;
    ha.x-=nx*overlap*0.5; ha.y-=ny*overlap*0.5;
    hb.x+=nx*overlap*0.5; hb.y+=ny*overlap*0.5;
    ha.vx-=nx*50; ha.vy-=ny*50; hb.vx+=nx*50; hb.vy+=ny*50;
    return true;
  }
  static tuskVsBody(attacker, victim) {
    if(attacker.invincibleDur>0||victim.invincibleDur>0) return false;
    if(!attacker.alive||!victim.alive||attacker.id===victim.id) return false;
    if(attacker.tuskRatio<0.1) return false;
    return CollisionSystem.ptSegDist(victim.parts[0].x,victim.parts[0].y,
      attacker.tuskBaseX,attacker.tuskBaseY,attacker.tuskTipX,attacker.tuskTipY) < victim.size/2;
  }
  static applyTuskDamage(attacker, victim, room) {
    const vh=victim.parts[0], ah=attacker.parts[0];
    const dx=vh.x-ah.x, dy=vh.y-ah.y, dist=mag(dx,dy);
    if(dist>0) { vh.vx+=(dx/dist)*400; vh.vy+=(dy/dist)*400; }
    victim.tuskRatio   = Math.max(0.05, victim.tuskRatio-0.15);
    attacker.tuskRatio = Math.min(2.0,  attacker.tuskRatio+0.05);
    attacker.score += 25;
    if(victim.tuskRatio<=0.05) {
      victim.alive=false; victim.respawnTimer=3.0;
      attacker.kills++; attacker.score+=100;
      if(victim.ws&&victim.ws.readyState===WebSocket.OPEN) victim.ws.send(Buffer.from([MSG.RIP]));
      room.broadcastTransient(TransientType.SmokeExplosion, vh.x, vh.y);
      return true;
    }
    return false;
  }
  static fishVsBall(fish, ball) {
    const head=fish.parts[0], dx=ball.x-head.x, dy=ball.y-head.y, dist=mag(dx,dy);
    const minDist=fish.size/2+ball.radius;
    if(dist>=minDist||dist===0) return false;
    const nx=dx/dist, ny=dy/dist, overlap=minDist-dist;
    ball.x+=nx*overlap; ball.y+=ny*overlap;
    ball.vx+=head.vx*0.75+nx*100; ball.vy+=head.vy*0.75+ny*100;
    if(CollisionSystem.ptSegDist(ball.x,ball.y,fish.tuskBaseX,fish.tuskBaseY,fish.tuskTipX,fish.tuskTipY)<ball.radius) {
      const spd=mag(head.vx,head.vy);
      ball.vx+=Math.cos(head.rot)*spd*3; ball.vy+=Math.sin(head.rot)*spd*3;
    }
    return true;
  }
  static fishVsEgg(fish, egg) {
    if(egg.carriedBy||egg.collected) return false;
    if(mag(egg.x-fish.headX, egg.y-fish.headY) < fish.size/2+egg.radius) {
      egg.carriedBy=fish.id; fish.carriedEggs.push(egg); return true;
    }
    return false;
  }
}

// ============================================================
// GAME ROOM
// ============================================================
class GameRoom {
  constructor(config) {
    this.config          = config;
    this.id              = config.id;
    this.name            = config.name;
    this.fieldType       = config.options.fieldType;
    this.players         = new Map();
    this.spectators      = new Set(); // joined but not yet started
    this.time            = 0;
    this.slowFactor      = 1;
    this.slowTimer       = 0;
    this.leftTeamScore   = 0;
    this.rightTeamScore  = 0;
    this.winTeam         = -1;
    this.isRoundDone     = false;
    this.roundResetTimer = 0;
    this.ball            = null;
    this.eggs            = [];
    this.occupiables     = [];
    this.nextTeamAssign  = 0;
    this._initMode();
  }

  _initMode() {
    const opts = this.config.options;
    if (this.fieldType === FieldType.Soccer) {
      this.ball = new Ball(opts.width/2, opts.height/2);
    } else if (this.fieldType === FieldType.EasterEgg) {
      this._spawnEggs();
      for (let i=0; i<4; i++) this.occupiables.push(new OccupiableZone(0xCC000000+i, i));
    }
  }

  _spawnEggs() {
    const opts=this.config.options; this.eggs=[];
    for(let i=0;i<20;i++) this.eggs.push(new Egg(
      200+Math.random()*(opts.width-400), 200+Math.random()*(opts.height-400),
      Math.floor(Math.random()*52)));
  }

  _isTeamMode() { return [FieldType.Soccer,FieldType.EasterEgg,FieldType.TeamDeathMatch].includes(this.fieldType); }
  _assignTeam() { const t=this.nextTeamAssign; this.nextTeamAssign=(this.nextTeamAssign+1)%2; return t; }

  addPlayer(player) {
    if (this._isTeamMode()) player.team = this._assignTeam();
    this.players.set(player.id, player);
    console.log(`[${this.name}] "${player.name}" entró | team=${player.team} | total=${this.players.size}`);
  }

  removePlayer(pid) {
    const p=this.players.get(pid); if(!p) return;
    for(const egg of p.carriedEggs){egg.carriedBy=null;egg.vx=(Math.random()-0.5)*200;egg.vy=(Math.random()-0.5)*200;}
    p.carriedEggs=[];
    this.players.delete(pid);
    console.log(`[${this.name}] "${p.name}" salió | total=${this.players.size}`);
  }

  respawnPlayer(player) {
    const opts=this.config.options, margin=300;
    player.alive=true; player.tuskRatio=0.5; player.curDash=player.maxDash;
    player.invincibleDur=1.5; player.parts=[];
    const head=new Part();
    head.x=margin+Math.random()*(opts.width-margin*2);
    head.y=margin+Math.random()*(opts.height-margin*2);
    head.rot=Math.random()*Math.PI*2;
    player.parts.push(head);
    for(let i=1;i<=player.breakPoint;i++){
      const seg=new Part(), behind=head.rot+Math.PI;
      seg.x=head.x+Math.cos(behind)*player.size*i;
      seg.y=head.y+Math.sin(behind)*player.size*i;
      seg.rot=head.rot; player.parts.push(seg);
    }
  }

  // -------------------------------------------------------
  // broadcastTransient
  // Client decodes: parseFloatFromUint16(t, 2, 2*w, -w/2)
  // Encode: uint16 = (x + w/2) / (2*w) * 65535
  // -------------------------------------------------------
  broadcastTransient(type, x, y) {
    const opts=this.config.options;
    const buf=Buffer.alloc(6); const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength);
    dv.setUint8(0, MSG.TRANSIENT_ELEMENT);
    dv.setUint8(1, type);
    dv.setUint16(2, encodeIndicatorX(x, opts.width),  true);
    dv.setUint16(4, encodeIndicatorY(y, opts.height), true);
    for(const p of this.players.values())   if(p.ws&&p.ws.readyState===WebSocket.OPEN) p.ws.send(buf);
    for(const ws of this.spectators)        if(ws.readyState===WebSocket.OPEN) ws.send(buf);
  }

  tick(dt) {
    this.time = (this.time + Math.round(dt*1000)) % 65536;

    if (this.slowTimer>0) {
      this.slowTimer-=dt; this.slowFactor=3;
      if(this.slowTimer<=0){this.slowFactor=1;this.slowTimer=0;}
    }
    if (this.roundResetTimer>0) { this.roundResetTimer-=dt; if(this.roundResetTimer<=0) this._resetRound(); }

    for(const p of this.players.values()){
      p.update(dt, this.config);
      if(!p.alive && p.respawnTimer===0) this.respawnPlayer(p);
    }

    const alive=Array.from(this.players.values()).filter(p=>p.alive);
    for(let i=0;i<alive.length;i++){
      for(let j=i+1;j<alive.length;j++){
        const a=alive[i], b=alive[j];
        CollisionSystem.bodyVsBody(a,b);
        if(this._isTeamMode()&&a.team>=0&&a.team===b.team) continue;
        if(CollisionSystem.tuskVsBody(a,b)){const k=CollisionSystem.applyTuskDamage(a,b,this);if(k)this._onKill(a,b);}
        if(b.alive&&CollisionSystem.tuskVsBody(b,a)){const k=CollisionSystem.applyTuskDamage(b,a,this);if(k)this._onKill(b,a);}
      }
    }
    if(this.fieldType===FieldType.Soccer) this._tickSoccer(dt,alive);
    else if(this.fieldType===FieldType.EasterEgg) this._tickEggHunt(dt,alive);
  }

  _tickSoccer(dt, alive) {
    if(!this.ball) return;
    this.ball.update(dt);
    const opts=this.config.options, goalTop=opts.height/3, goalBottom=opts.height*2/3;
    for(const f of alive) CollisionSystem.fishVsBall(f,this.ball);
    if(this.ball.y-this.ball.radius<0){this.ball.y=this.ball.radius;this.ball.vy=Math.abs(this.ball.vy);}
    if(this.ball.y+this.ball.radius>opts.height){this.ball.y=opts.height-this.ball.radius;this.ball.vy=-Math.abs(this.ball.vy);}
    const inGoal=this.ball.y>goalTop&&this.ball.y<goalBottom;
    if(!inGoal){
      if(this.ball.x<this.ball.radius){this.ball.x=this.ball.radius;this.ball.vx=Math.abs(this.ball.vx);}
      if(this.ball.x>opts.width-this.ball.radius){this.ball.x=opts.width-this.ball.radius;this.ball.vx=-Math.abs(this.ball.vx);}
    }
    if(inGoal&&!this.isRoundDone){
      if(this.ball.x<-this.ball.radius){this.rightTeamScore++;this._onGoal();}
      else if(this.ball.x>opts.width+this.ball.radius){this.leftTeamScore++;this._onGoal();}
    }
  }

  _onGoal(){this.isRoundDone=true;this.slowTimer=3;if(this.leftTeamScore>=5)this.winTeam=0;if(this.rightTeamScore>=5)this.winTeam=1;this.roundResetTimer=4;this._broadcastTeamInfo();}
  _resetRound(){
    this.isRoundDone=false; const opts=this.config.options;
    if(this.winTeam>=0){this.leftTeamScore=0;this.rightTeamScore=0;this.winTeam=-1;}
    if(this.ball){this.ball.x=opts.width/2;this.ball.y=opts.height/2;this.ball.vx=0;this.ball.vy=0;}
    for(const p of this.players.values()) if(!p.alive) this.respawnPlayer(p);
    this._broadcastTeamInfo();
  }

  _tickEggHunt(dt, alive) {
    const opts=this.config.options, cw=opts.cellWidth;
    const baskets={0:{x:cw/2,y:opts.height/2,radius:cw/3},1:{x:opts.width-cw/2,y:opts.height/2,radius:cw/3}};
    for(const egg of this.eggs){egg.update(dt);egg.x=clamp(egg.x,egg.radius,opts.width-egg.radius);egg.y=clamp(egg.y,egg.radius,opts.height-egg.radius);}
    for(const fish of alive){
      for(const egg of this.eggs) CollisionSystem.fishVsEgg(fish,egg);
      if(fish.carriedEggs.length>0&&fish.team>=0){
        const basket=baskets[fish.team];
        if(basket&&mag(fish.headX-basket.x,fish.headY-basket.y)<basket.radius){
          const dep=fish.carriedEggs.length;
          for(const egg of fish.carriedEggs) egg.collected=true;
          fish.carriedEggs=[]; fish.score+=dep*50;
          if(fish.team===0) this.leftTeamScore+=dep; else this.rightTeamScore+=dep;
          this._broadcastTeamInfo();
        }
      }
    }
    if(this.eggs.filter(e=>!e.collected&&!e.carriedBy).length<5)
      for(let i=0;i<5;i++) this.eggs.push(new Egg(200+Math.random()*(opts.width-400),200+Math.random()*(opts.height-400),Math.floor(Math.random()*52)));
    this.eggs=this.eggs.filter(e=>!e.collected);
  }

  _onKill(killer, victim) {
    console.log(`[${this.name}] "${killer.name}" eliminó a "${victim.name}"`);
    if(this._isTeamMode()&&killer.team>=0){
      if(killer.team===0) this.leftTeamScore++; else this.rightTeamScore++;
      this._broadcastTeamInfo();
    }
    if(this.fieldType===FieldType.EasterEgg){
      for(const egg of victim.carriedEggs){egg.carriedBy=null;egg.x=victim.headX+(Math.random()-0.5)*100;egg.y=victim.headY+(Math.random()-0.5)*100;egg.vx=(Math.random()-0.5)*300;egg.vy=(Math.random()-0.5)*300;}
      victim.carriedEggs=[];
    }
    const newLevel=1+Math.floor(killer.kills/2);
    if(newLevel>killer.level){
      const upgrades=[]; for(let i=killer.level;i<newLevel;i++) upgrades.push(i%6);
      killer.level=newLevel; killer.upgrades=upgrades; this._sendPlayerInfo(killer);
    }
  }

  // -------------------------------------------------------
  // buildSetElements — CRITICAL FORMAT (from client parseFish/parseData)
  //
  // ❌ PREVIOUS VERSION sent a uint16 elementCount BEFORE the elements.
  //    The client does NOT read a count — it iterates until byteLength.
  //    That extra 2-byte field offset everything and broke all parsing.
  //
  // ✅ CORRECT layout:
  //   [uint8]  opcode 48
  //   [uint16] time
  //   [uint8]  flags (bit0=slowFactor, bit1=hasIndicator)
  //   [uint8]  slowFactor  (if flags & 1)
  //   [uint16] indicatorX  (if flags & 2)
  //   [uint16] indicatorY  (if flags & 2)
  //   [ elements... ]   ← NO elementCount prefix
  //   Each element starts with [uint8 ElemType], followed by element data.
  // -------------------------------------------------------
  buildSetElements() {
    const opts = this.config.options;
    const elems = [];

    for(const p of this.players.values()) if(p.alive) {
      // Prepend ElemType byte, then the fish data
      const fishBuf = p.serializeBinary();
      const withType = Buffer.alloc(1 + fishBuf.length);
      withType[0] = ElemType.Fish;
      fishBuf.copy(withType, 1);
      elems.push(withType);
    }
    if(this.ball) {
      const b = Buffer.alloc(1 + 15); // 1 type + 15 bytes ball
      b[0] = ElemType.Ball;
      this.ball.serializeBinary().copy(b, 1);
      elems.push(b);
    }
    for(const egg of this.eggs) if(!egg.collected) {
      const e = Buffer.alloc(1 + 19);
      e[0] = ElemType.Attachable;
      egg.serializeBinary().copy(e, 1);
      elems.push(e);
    }
    for(const occ of this.occupiables) {
      const o = Buffer.alloc(1 + 8);
      o[0] = ElemType.Occupiable;
      occ.serializeBinary().copy(o, 1);
      elems.push(o);
    }

    let flags = 0, headerExtra = 0;
    if(this.slowFactor > 1)   { flags |= 1; headerExtra += 1; }
    if(opts.hasIndicator)     { flags |= 2; headerExtra += 4; }

    const headerSize = 1 + 2 + 1 + headerExtra; // opcode + time + flags + extras
    const elemSize   = elems.reduce((s,b)=>s+b.length, 0);
    const buf = Buffer.alloc(headerSize + elemSize);
    const dv  = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let off   = 0;

    dv.setUint8(off, MSG.SET_ELEMENTS); off++;
    dv.setUint16(off, this.time, true);  off+=2;
    dv.setUint8(off, flags);             off++;

    if(flags & 1) { dv.setUint8(off, Math.round(this.slowFactor)); off++; }
    if(flags & 2) {
      const indX = this.ball ? this.ball.x : opts.width/2;
      const indY = this.ball ? this.ball.y : opts.height/2;
      // ✅ Correct formula: (coord + dim/2) / (2*dim) * 65535
      dv.setUint16(off, encodeIndicatorX(indX, opts.width),  true); off+=2;
      dv.setUint16(off, encodeIndicatorY(indY, opts.height), true); off+=2;
    }

    for(const e of elems) { e.copy(buf, off); off+=e.length; }
    return buf;
  }

  buildTeamInfo() {
    const buf=Buffer.alloc(5);
    buf[0]=MSG.TEAM_INFO; buf[1]=this.leftTeamScore&255; buf[2]=this.rightTeamScore&255;
    buf.writeInt8(this.winTeam>=0?this.winTeam:-1, 3); buf[4]=this.isRoundDone?1:0;
    return buf;
  }
  _broadcastTeamInfo() {
    if(!this._isTeamMode()) return;
    const buf=this.buildTeamInfo();
    for(const p of this.players.values()) if(p.ws&&p.ws.readyState===WebSocket.OPEN) p.ws.send(buf);
  }

  // -------------------------------------------------------
  // buildLeaderBoard
  // Client parseData:
  //   uint8 playerCount
  //   for each: uint8 level, string name
  //   uint8 teamCount
  //   for each team score: uint8  ← NOT uint16!
  // -------------------------------------------------------
  buildLeaderBoard() {
    const sorted=Array.from(this.players.values()).sort((a,b)=>b.score-a.score).slice(0,10);
    const parts=[Buffer.from([MSG.LEADER_BOARD, sorted.length])];
    for(const p of sorted){
      parts.push(Buffer.from([p.level&255]));
      parts.push(Buffer.from(encodeString(p.name)));
    }
    if(this._isTeamMode()){
      // ✅ uint8 per team score (client reads with getUint8)
      parts.push(Buffer.from([2, this.leftTeamScore&255, this.rightTeamScore&255]));
    } else {
      parts.push(Buffer.from([0]));
    }
    return Buffer.concat(parts);
  }

  // -------------------------------------------------------
  // PLAYER_INFO (49)
  // Client PlayerInfo.parseData:
  //   uint8 level
  //   uint8 upgradeCount
  //   uint8[] upgrades
  // -------------------------------------------------------
  _sendPlayerInfo(player) {
    const upg=player.upgrades||[];
    const buf=Buffer.alloc(3+upg.length);
    buf[0]=MSG.PLAYER_INFO; buf[1]=player.level&255; buf[2]=upg.length;
    for(let i=0;i<upg.length;i++) buf[3+i]=upg[i]&255;
    player.upgrades=[];
    if(player.ws&&player.ws.readyState===WebSocket.OPEN) player.ws.send(buf);
  }
}

// ============================================================
// PROTOCOL BUILDERS (Server → Client)
// ============================================================

// GET_LOBBIES response: [opcode][JSON bytes][0x00]
// Client parseData: this.data = JSON.parse(readNullTerminatedString(buf, 1))
function buildGetLobbiesResponse() {
  const lobbies = rooms.map(r=>({
    id: r.id, name: r.name,
    playerCount: gameRooms.get(r.id)?.players.size ?? 0,
    options: r.options
  }));
  const json = JSON.stringify(lobbies);
  const jbuf = Buffer.from(json, 'utf8');
  const out  = Buffer.alloc(1 + jbuf.length + 1);
  out[0] = MSG.GET_LOBBIES;
  jbuf.copy(out, 1);
  out[out.length-1] = 0; // null terminator
  return out;
}

// START response: [uint8 opcode=18][uint16 uid LE]
// Client: this.uid = t.getUint16(1, true)
function buildStartResponse(uid) {
  const buf=Buffer.alloc(3); const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength);
  dv.setUint8(0, MSG.START); dv.setUint16(1, uid&0xFFFF, true);
  return buf;
}

// PING response: [uint8 opcode=37][float32 timestamp LE]
// Client echoes back the same float32 to compute RTT
function buildPingResponse(timestamp) {
  const buf=Buffer.alloc(5); const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength);
  dv.setUint8(0, MSG.PING); dv.setFloat32(1, timestamp, true);
  return buf;
}

// ============================================================
// CLIENT → SERVER PARSING
// ============================================================
function parseClientMessage(data) {
  if(!Buffer.isBuffer(data)) {
    if(data instanceof ArrayBuffer)  data=Buffer.from(data);
    else if(data instanceof Uint8Array) data=Buffer.from(data.buffer,data.byteOffset,data.byteLength);
    else return null;
  }
  if(data.length<1) return null;

  const dv   = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = dv.getUint8(0);

  switch(type) {
    case MSG.GET_LOBBIES: return {type};

    case MSG.JOIN:
      if(data.length<5) return null;
      return {type, roomId: dv.getUint32(1,true)};

    // START from client: [uint8 op][uint32 skincode][uint32 colorcode][...name bytes, NO null terminator]
    // Client getData(): e.set(encodeURIComponent(name), 9)  — no null appended
    case MSG.START: {
      if(data.length<9) return null;
      const skincode  = dv.getUint32(1,true);
      const colorcode = dv.getUint32(5,true);
      let name = '';
      if(data.length > 9) {
        // ✅ No null terminator sent by client — read remaining bytes as the name
        const nameBytes = data.slice(9);
        // Remove null if accidentally present
        const end = nameBytes.indexOf(0);
        const slice = end>=0 ? nameBytes.slice(0,end) : nameBytes;
        try   { name = decodeURIComponent(slice.toString('ascii')); }
        catch { name = slice.toString('ascii'); }
      }
      // colorcode = H<<0 | S<<8 | L<<16 (each as 0-255)
      const h = (colorcode & 0xFF) / 255;
      const s = ((colorcode >> 8) & 0xFF) / 255;
      const l = ((colorcode >> 16) & 0xFF) / 255;
      return {type, name, skincode, colorcode, color: hslToRgb(h,s,l)};
    }

    case MSG.UPDATE_TARGET:
      if(data.length<9) return null;
      return {type, x: dv.getFloat32(1,true), y: dv.getFloat32(5,true)};

    case MSG.SPLIT_UP:
      if(data.length<9) return null;
      return {type, x: dv.getFloat32(1,true), y: dv.getFloat32(5,true)};

    case MSG.RETREAT:
      if(data.length<9) return null;
      return {type, x: dv.getFloat32(1,true), y: dv.getFloat32(5,true)};

    case MSG.INPUT:
      if(data.length<2) return null;
      return {type, control: dv.getUint8(1)};

    case MSG.PING:
      if(data.length<5) return null;
      return {type, timestamp: dv.getFloat32(1,true)};

    case MSG.LEAVE:   return {type};
    case MSG.RIP:     return {type};
    case MSG.GET_STATS: return {type};

    default:
      console.warn(`[Parse] opcode desconocido: ${type} (0x${type.toString(16)}) len=${data.length}`);
      return null;
  }
}

// ============================================================
// WEBSOCKET SERVER
// ============================================================
const PORT = process.env.PORT || 8080;

const gameRooms = new Map();
for(const rc of rooms) gameRooms.set(rc.id, new GameRoom(rc));

const wss = new WebSocket.Server({port: PORT}, () => {
  console.log('\n========================================');
  console.log(` Narwhale.io Server — Binary Protocol`);
  console.log(` Puerto ${PORT} | ${rooms.length} salas`);
  console.log('========================================\n');
  console.log('Bugs corregidos vs versión anterior:');
  console.log('  ✅ SET_ELEMENTS: sin elementCount prefix');
  console.log('  ✅ JOIN: responde con SET_ELEMENTS → hasJoined=true en cliente');
  console.log('  ✅ indicatorX/Y: fórmula correcta (x+w/2)/(2w)*65535');
  console.log('  ✅ transient: misma fórmula');
  console.log('  ✅ LeaderBoard scores: uint8 (no uint16)');
  console.log('  ✅ START parse: sin null terminator esperado\n');
});

let nextPlayerId = 1;
const connections = new Map(); // ws → {player, room, roomId, pid}

wss.on('connection', (ws, req) => {
  const pid = nextPlayerId++;
  console.log(`[WS] #${pid} conectado desde ${req.socket.remoteAddress}`);
  connections.set(ws, {player:null, room:null, roomId:null, pid});

  ws.on('message', (raw) => {
    let data;
    if(Buffer.isBuffer(raw)) data=raw;
    else if(raw instanceof ArrayBuffer) data=Buffer.from(raw);
    else if(raw instanceof Uint8Array)  data=Buffer.from(raw.buffer,raw.byteOffset,raw.byteLength);
    else return;

    const opcode = data.length>0 ? data[0] : -1;
    const opName = Object.entries(MSG).find(([,v])=>v===opcode)?.[0] || '?';
    console.log(`[WS] #${pid} ← opcode=${opcode}(${opName}) len=${data.length}`);

    let msg;
    try { msg = parseClientMessage(data); }
    catch(e) { console.error(`[WS] #${pid} parse error:`, e); return; }
    if(!msg) return;

    const conn = connections.get(ws);

    try {
      switch(msg.type) {

        case MSG.GET_LOBBIES: {
          const buf = buildGetLobbiesResponse();
          ws.send(buf);
          console.log(`[WS] #${pid} → GET_LOBBIES (${buf.length}B)`);
          break;
        }

        // -------------------------------------------------------
        // JOIN — CRITICAL
        // After JOIN the server MUST send SET_ELEMENTS immediately.
        // The client only sets hasJoined=true when it receives SET_ELEMENTS.
        // Without hasJoined=true, the start() function silently exits
        // and the user can never actually enter the game.
        // -------------------------------------------------------
        case MSG.JOIN: {
          const room = gameRooms.get(msg.roomId);
          if(!room) { console.warn(`[WS] #${pid} JOIN sala inválida ${msg.roomId}`); break; }

          // Leave previous room
          if(conn.player && conn.room) conn.room.removePlayer(conn.player.id);
          if(conn.room) conn.room.spectators.delete(ws);

          conn.room=room; conn.roomId=msg.roomId; conn.player=null;
          room.spectators.add(ws);

          // ✅ Send SET_ELEMENTS immediately so client sets hasJoined=true
          // and enables the Play button
          try { ws.send(room.buildSetElements()); } catch(_){}

          // Send team info if team mode
          if(room._isTeamMode()) try { ws.send(room.buildTeamInfo()); } catch(_){}

          console.log(`[WS] #${pid} → JOIN sala ${msg.roomId}(${room.name}) | spectators=${room.spectators.size}`);
          break;
        }

        case MSG.START: {
          if(!conn.room) { console.warn(`[WS] #${pid} START sin sala`); break; }

          if(conn.player) conn.room.removePlayer(conn.player.id);
          conn.room.spectators.delete(ws);

          const player   = new Fish(pid, msg.name, conn.roomId);
          player.ws      = ws;
          player.color   = msg.color   || [255,255,255];
          player.skincode= msg.skincode|| 0;
          conn.player    = player;
          conn.room.addPlayer(player);

          // ✅ START response with UID (client sets player.id = uid and gameStarted=true)
          ws.send(buildStartResponse(player.id));
          console.log(`[WS] #${pid} → START uid=${player.id} name="${player.name}"`);

          // ✅ PLAYER_INFO initial (client triggers level-up UI)
          conn.room._sendPlayerInfo(player);

          // Initial PING so client starts RTT measurement
          ws.send(buildPingResponse(0));
          break;
        }

        case MSG.UPDATE_TARGET:
          if(conn?.player?.alive) {
            if(!isNaN(msg.x)&&!isNaN(msg.y)){conn.player.target.x=msg.x;conn.player.target.y=msg.y;}
          }
          break;

        case MSG.INPUT:
          if(conn?.player?.alive) conn.player.currentControl=msg.control;
          break;

        case MSG.SPLIT_UP:
          if(conn?.player?.alive){conn.player.target.x=msg.x;conn.player.target.y=msg.y;conn.player.currentControl|=CTRL.MouseLeft;}
          break;

        case MSG.RETREAT:
          if(conn?.player?.alive){conn.player.target.x=msg.x;conn.player.target.y=msg.y;conn.player.currentControl|=CTRL.MouseRight;}
          break;

        // ✅ PING: echo back the exact float32 timestamp received
        case MSG.PING:
          try { ws.send(buildPingResponse(msg.timestamp)); } catch(_){}
          break;

        case MSG.LEAVE:
          if(conn.player&&conn.room){conn.room.removePlayer(conn.player.id);conn.player=null;}
          if(conn.room){conn.room.spectators.delete(ws);conn.room=null;conn.roomId=null;}
          console.log(`[WS] #${pid} LEAVE`);
          break;

        case MSG.RIP:
          if(conn.player) console.log(`[WS] #${pid} RIP confirmado`);
          break;

        case MSG.GET_STATS: {
          const stats={total:connections.size,rooms:[]};
          for(const [id,room] of gameRooms) stats.rooms.push({id,name:room.name,players:room.players.size});
          const json=JSON.stringify(stats), buf=Buffer.alloc(1+json.length+1);
          buf[0]=MSG.GET_STATS; Buffer.from(json,'utf8').copy(buf,1); buf[buf.length-1]=0;
          try{ws.send(buf);}catch(_){}
          break;
        }
      }
    } catch(e) { console.error(`[WS] #${pid} handler error opcode=${msg.type}:`, e); }
  });

  ws.on('close', (code) => {
    const conn=connections.get(ws);
    if(conn?.player&&conn.room) conn.room.removePlayer(conn.player.id);
    if(conn?.room) conn.room.spectators.delete(ws);
    connections.delete(ws);
    console.log(`[WS] #${pid} desconectado (code=${code})`);
  });

  ws.on('error', (e) => console.error(`[WS] #${pid} error:`, e.message));
});

// ============================================================
// GAME LOOP — 60 FPS
// ============================================================
let tickCount = 0;

setInterval(() => {
  tickCount++;
  for(const room of gameRooms.values()) {
    const hasPlayers = room.players.size > 0;
    const hasSpectators = room.spectators.size > 0;
    if(!hasPlayers && !hasSpectators) continue;

    room.tick(DT);

    const stateBuf  = room.buildSetElements();
    const leaderBuf = (hasPlayers && tickCount%60===0) ? room.buildLeaderBoard() : null;
    const teamBuf   = (hasPlayers && room._isTeamMode() && tickCount%10===0) ? room.buildTeamInfo() : null;

    // Send to active players
    for(const player of room.players.values()) {
      if(!player.ws || player.ws.readyState!==WebSocket.OPEN) continue;
      try {
        player.ws.send(stateBuf);
        if(leaderBuf) player.ws.send(leaderBuf);
        if(teamBuf)   player.ws.send(teamBuf);
      } catch(_){}
    }

    // Send SET_ELEMENTS to spectators (so they keep hasJoined=true and see the room)
    for(const specWs of room.spectators) {
      if(specWs.readyState!==WebSocket.OPEN){room.spectators.delete(specWs);continue;}
      try{specWs.send(stateBuf);}catch(_){room.spectators.delete(specWs);}
    }
  }
}, 1000 / TICK_RATE);

// Status log
setInterval(() => {
  let total=0;
  for(const room of gameRooms.values()){
    if(room.players.size>0||room.spectators.size>0)
      console.log(`  [${room.name}] jugadores=${room.players.size} espectadores=${room.spectators.size} | ${room.leftTeamScore}-${room.rightTeamScore}`);
    total+=room.players.size;
  }
  console.log(`[Server] Total jugadores: ${total} | Connections: ${connections.size}`);
}, 30000);

console.log(`[Server] Game loop a ${TICK_RATE} ticks/seg`);

