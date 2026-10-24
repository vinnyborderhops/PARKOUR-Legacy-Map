import * as THREE from 'three';

// A free-fly camera that handles like Roblox Studio's, instead of an orbit camera around a target:
//   right-drag         look around from where the camera is (yaw / pitch)
//   W A S D            fly forward / left / back / right along the view; Q / E down / up
//                      speed ramps up the longer a key is held; Shift flies slowly for precise moves
//   scroll             step toward (or away from) the mouse direction by a steady amount that depends
//                      only on height, so pointing at a building doesn't make it lunge; walls don't block
//   middle- or left-drag   pan: the point you grabbed stays under the cursor
//   Alt + left-drag    orbit around the point under the cursor
//   F                  focus (the host decides what on; see onFocus)
// Touch: one finger pans, two fingers pinch to zoom and drag to look.
// No smoothing on mouse input, like Studio; only keyboard flight accelerates.

const LOOK_SPEED = 0.0035;      // radians per pixel
const PITCH_LIMIT = 1.55;       // just under straight up / down
const FLY_SPEED = 40;           // studs per second when a key is first pressed
const FLY_RAMP = 8;             // ...up to this many times faster after FLY_RAMP_TIME of holding
const FLY_RAMP_TIME = 2.5;      // seconds
const SLOW = 0.25;              // Shift multiplier
const WHEEL_STEP = 0.12;        // fraction of the camera's height above the ground, per notch
const WHEEL_MIN = 6, WHEEL_MAX = 500;
const MIN_Y = 3;                // studs; never below the baseplate top
const FALLBACK_DEPTH = 300;     // studs; for pan/orbit when nothing is under the cursor
// Fly-to viewpoint search (see viewpoint()). Tried in order: full distance first, then closer.
const VIEW_DISTANCES = [1, 0.6, 0.35, 0.15];
const VIEW_MIN_DIST = 30;       // studs
const VIEW_ELEVATIONS = [0.6, 0.9, 0.25, 1.25];             // radians above the horizon
const VIEW_MIN_ELEV = 0.35, VIEW_MAX_ELEV = 1.3;
const VIEW_YAWS = [0, 30, -30, 60, -60, 90, -90, 135, -135, 180]; // degrees from the current direction
const VIEW_PROBES = [[0, 0.5, 0], [0, 4, 0], [3, 1.5, 0], [-3, 1.5, 0], [0, 1.5, 3], [0, 1.5, -3]]; // around the target
const VIEW_GOOD = 0.8;          // fraction of probes that must see the camera
const VIEW_BUDGET_MS = 120;     // stop searching and take the best spot so far

// Keep receiving moves while dragging outside the canvas. Throws for pointers the browser isn't tracking
// (e.g. synthetic events), which shouldn't break the drag itself.
function capture(dom, id) { try { dom.setPointerCapture(id); } catch { /* not a live pointer */ } }

export class StudioCamera {
  constructor(camera, dom, { surfaces = () => [], onFocus = null } = {}) {
    this.camera = camera;
    this.dom = dom;
    this.surfaces = surfaces;
    this.onFocus = onFocus;
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this.held = 0;          // seconds the current flight has been held, for the speed ramp
    this.drag = null;       // { mode: 'look' | 'pan' | 'orbit', x, y, depth?, pivot? }
    this.touches = new Map();
    this.anim = null;
    this.ray = new THREE.Raycaster();
    this.ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.syncAngles();

    dom.addEventListener('contextmenu', e => e.preventDefault());
    dom.addEventListener('pointerdown', e => this.down(e));
    dom.addEventListener('pointermove', e => this.move(e));
    dom.addEventListener('pointerup', e => this.up(e));
    dom.addEventListener('pointercancel', e => this.up(e));
    dom.addEventListener('wheel', e => this.wheel(e), { passive: false });
    addEventListener('keydown', e => this.key(e, true));
    addEventListener('keyup', e => this.key(e, false));
    addEventListener('blur', () => this.keys.clear());
  }

  // ---------- orientation ----------
  syncAngles() {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
  }

  applyAngles() {
    this.pitch = THREE.MathUtils.clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }

  lookAt(target) {
    this.camera.lookAt(target);
    this.syncAngles();
    this.applyAngles();
  }

  // ---------- picking helpers ----------
  rayAt(clientX, clientY) {
    // The camera may have moved since the last render (several wheel events per frame), so refresh first.
    this.camera.updateMatrixWorld();
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    return this.ray;
  }

  // The first surface under a screen point: { point, distance, depth } or null, falling back to the ground
  // plane. distance is along the ray; depth is along the view direction (what pan scaling needs).
  hitAt(clientX, clientY) {
    const ray = this.rayAt(clientX, clientY);
    const hit = ray.intersectObjects(this.surfaces(), false)[0];
    const point = hit ? hit.point : ray.ray.intersectPlane(this.ground, new THREE.Vector3());
    if (!point) return null;
    const rel = point.clone().sub(this.camera.position);
    return { point, distance: rel.length(), depth: Math.max(1, rel.dot(this.forward())) };
  }

  // Distance to what the screen centre is looking at, cheaply (ground plane only).
  focusDistance() {
    const r = this.dom.getBoundingClientRect();
    const ray = this.rayAt(r.left + r.width / 2, r.top + r.height / 2);
    const p = ray.ray.intersectPlane(this.ground, new THREE.Vector3());
    return p ? p.distanceTo(this.camera.position) : this.camera.position.y * 2;
  }

  worldPerPixel(depth) {
    return (2 * depth * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / this.dom.clientHeight;
  }

  // ---------- mouse ----------
  down(e) {
    if (e.pointerType === 'touch') return this.touchDown(e);
    this.anim = null;
    let mode = null;
    if (e.button === 2) mode = 'look';
    else if (e.button === 1) mode = 'pan';
    else if (e.button === 0) mode = e.altKey ? 'orbit' : 'pan';
    if (!mode) return;
    if (e.button === 1) e.preventDefault(); // no autoscroll
    const hit = mode === 'look' ? null : this.hitAt(e.clientX, e.clientY);
    this.drag = { mode, x: e.clientX, y: e.clientY,
      depth: hit ? hit.depth : FALLBACK_DEPTH,
      pivot: hit ? hit.point : this.camera.position.clone().add(this.forward().multiplyScalar(FALLBACK_DEPTH)) };
    capture(this.dom, e.pointerId);
  }

  move(e) {
    if (e.pointerType === 'touch') return this.touchMove(e);
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    if (d.mode === 'look') this.look(dx, dy);
    else if (d.mode === 'pan') this.pan(dx, dy, d.depth);
    else this.orbit(dx, dy, d.pivot);
  }

  up(e) {
    if (e.pointerType === 'touch') return this.touchUp(e);
    this.drag = null;
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
  }

  look(dx, dy) {
    this.yaw -= dx * LOOK_SPEED;
    this.pitch -= dy * LOOK_SPEED;
    this.applyAngles();
  }

  pan(dx, dy, depth) {
    // Move the camera opposite to the drag in its own screen plane, scaled so the grabbed point follows the cursor.
    const k = this.worldPerPixel(depth);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.camera.position.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    this.clampY();
  }

  orbit(dx, dy, pivot) {
    const yaw = -dx * LOOK_SPEED, pitch = -dy * LOOK_SPEED;
    const newPitch = THREE.MathUtils.clamp(this.pitch + pitch, -PITCH_LIMIT, PITCH_LIMIT);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const offset = this.camera.position.clone().sub(pivot);
    offset.applyAxisAngle(right, newPitch - this.pitch).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.camera.position.copy(pivot).add(offset);
    this.yaw += yaw;
    this.pitch = newPitch;
    this.applyAngles();
    this.clampY();
  }

  wheel(e) {
    e.preventDefault();
    this.anim = null;
    // Normalise trackpads (many small deltas) and mice (one big one per notch) to notches.
    const unit = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 100 : 100;
    const notches = THREE.MathUtils.clamp(-e.deltaY / unit, -3, 3);
    if (!notches) return;
    this.zoomAt(e.clientX, e.clientY, notches);
  }

  zoomAt(clientX, clientY, notches) {
    const dir = this.rayAt(clientX, clientY).ray.direction.clone();
    const step = THREE.MathUtils.clamp(this.camera.position.y * WHEEL_STEP, WHEEL_MIN, WHEEL_MAX) * notches;
    this.camera.position.addScaledVector(dir, step * (this.shift ? SLOW : 1));
    this.clampY();
  }

  // ---------- keyboard ----------
  key(e, down) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const k = e.key.toLowerCase();
    if (down && k === 'f' && this.onFocus) { this.onFocus(); return; }
    if (!'wasdqe'.includes(k) || k.length !== 1) { if (k === 'shift') this.shift = down; return; }
    if (down) this.keys.add(k);
    else this.keys.delete(k);
    this.shift = e.shiftKey;
  }

  forward() {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
  }

  // ---------- touch ----------
  touchDown(e) {
    this.anim = null;
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    capture(this.dom, e.pointerId);
    if (this.touches.size === 1) {
      const hit = this.hitAt(e.clientX, e.clientY);
      this.touchDepth = hit ? hit.depth : FALLBACK_DEPTH;
    }
    this.pinch = this.touches.size === 2 ? this.touchSpread() : null;
  }

  touchMove(e) {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    const dx = e.clientX - t.x, dy = e.clientY - t.y;
    if (this.touches.size === 1) {
      t.x = e.clientX;
      t.y = e.clientY;
      this.pan(dx, dy, this.touchDepth);
      return;
    }
    const before = this.touchMid();
    t.x = e.clientX;
    t.y = e.clientY;
    const after = this.touchMid(), spread = this.touchSpread();
    this.look((after.x - before.x) * 0.6, (after.y - before.y) * 0.6);
    if (this.pinch) this.zoomAt(after.x, after.y, THREE.MathUtils.clamp((spread / this.pinch - 1) * 6, -3, 3));
    this.pinch = spread;
  }

  touchUp(e) {
    this.touches.delete(e.pointerId);
    this.pinch = this.touches.size === 2 ? this.touchSpread() : null;
    if (this.touches.size === 1) {
      const [t] = this.touches.values();
      const hit = this.hitAt(t.x, t.y);
      this.touchDepth = hit ? hit.depth : FALLBACK_DEPTH;
    }
  }

  touchMid() {
    const [a, b] = this.touches.values();
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  touchSpread() {
    const [a, b] = this.touches.values();
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }

  // ---------- fly-to ----------
  // Glide to look at `target` from about `dist` studs away. The end spot is picked so the target is mostly
  // visible: rays from a few points on and around the target must reach the camera without hitting map
  // geometry. That also rules out ending inside a building (a ray from outside hits its wall first). Spots
  // closest to the current view direction are tried first; free flying is unaffected and still passes walls.
  flyTo(target, dist = 320) {
    const toP = this.viewpoint(target, dist);
    const toQ = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(toP, target, new THREE.Vector3(0, 1, 0)));
    this.anim = { t0: performance.now(), dur: 900, fromP: this.camera.position.clone(), toP,
      fromQ: this.camera.quaternion.clone(), toQ };
  }

  viewpoint(target, dist) {
    const surfaces = this.surfaces();
    const base = this.camera.position.clone().sub(target);
    const baseYaw = Math.atan2(base.x, base.z);
    const baseElev = THREE.MathUtils.clamp(Math.asin(base.y / (base.length() || 1)), VIEW_MIN_ELEV, VIEW_MAX_ELEV);
    let best = null, bestScore = -1;
    const deadline = performance.now() + VIEW_BUDGET_MS;
    for (const scale of VIEW_DISTANCES) {
      const d = Math.max(VIEW_MIN_DIST, dist * scale);
      for (const elev of [baseElev, ...VIEW_ELEVATIONS]) {
        for (const yawOff of VIEW_YAWS) {
          const yaw = baseYaw + THREE.MathUtils.degToRad(yawOff);
          const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(elev), Math.sin(elev), Math.cos(yaw) * Math.cos(elev));
          const p = target.clone().addScaledVector(dir, d);
          if (p.y < MIN_Y) continue;
          const seen = this.visibleFraction(p, target, surfaces, bestScore);
          if (seen >= VIEW_GOOD) return p;
          if (seen > bestScore) { bestScore = seen; best = p; }
          if (performance.now() > deadline) return best; // hidden targets shouldn't freeze the click
        }
      }
    }
    // Nothing clears (e.g. a secret inside a closed room): straight above, else the least blocked spot tried.
    const above = target.clone().add(new THREE.Vector3(0, dist, 0.01));
    return this.visibleFraction(above, target, surfaces, bestScore) > bestScore ? above : best;
  }

  // Fraction of VIEW_PROBES with a clear line to p. Stops early (returning -1) once it can no longer beat
  // `beat`, which is most of the cost saved when the target is hard to see.
  visibleFraction(p, target, surfaces, beat = -1) {
    let clear = 0, left = VIEW_PROBES.length;
    for (const [x, y, z] of VIEW_PROBES) {
      if ((clear + left) / VIEW_PROBES.length <= beat) return -1;
      left--;
      const q = new THREE.Vector3(target.x + x, target.y + y, target.z + z);
      const dir = p.clone().sub(q);
      const len = dir.length();
      this.ray.set(q, dir.normalize());
      this.ray.far = len;
      const hit = this.ray.intersectObjects(surfaces, false)[0];
      if (!hit || hit.distance > len - 0.5) clear++;
    }
    return clear / VIEW_PROBES.length;
  }

  // ---------- per frame ----------
  update(dt) {
    if (this.anim) {
      const a = this.anim;
      const k = Math.min(1, (performance.now() - a.t0) / a.dur), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      this.camera.position.lerpVectors(a.fromP, a.toP, e);
      this.camera.quaternion.slerpQuaternions(a.fromQ, a.toQ, e);
      if (k === 1) { this.anim = null; this.syncAngles(); }
      return;
    }
    if (!this.keys.size) { this.held = 0; return; }
    this.held += dt;
    const ramp = 1 + (FLY_RAMP - 1) * Math.min(1, this.held / FLY_RAMP_TIME);
    const speed = FLY_SPEED * ramp * (this.shift ? SLOW : 1) * dt;
    const fwd = this.forward(), right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const move = new THREE.Vector3();
    if (this.keys.has('w')) move.add(fwd);
    if (this.keys.has('s')) move.sub(fwd);
    if (this.keys.has('d')) move.add(right);
    if (this.keys.has('a')) move.sub(right);
    if (this.keys.has('e')) move.y += 1;
    if (this.keys.has('q')) move.y -= 1;
    if (move.lengthSq()) this.camera.position.addScaledVector(move.normalize(), speed);
    this.clampY();
  }

  clampY() {
    if (this.camera.position.y < MIN_Y) this.camera.position.y = MIN_Y;
  }
}
