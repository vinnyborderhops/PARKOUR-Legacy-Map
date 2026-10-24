import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { StudioCamera } from './studio-camera.js?v=1792814841';
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh';

// Raycasts (fly-to line of sight, pan grab, clicks) hit big merged map batches; a BVH per geometry makes
// each ray cheap instead of testing every triangle. Built per mesh as files load (see loadFile).
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
const BVH_MIN_TRIANGLES = 500;

// data/index.json (tools/build_regions.py) lists the ground file and every region's files with their layer.
// The map layer always loads. Props and decor files load and show only while their toggle is on AND
// their region is within the category's distance below, so a full-map overview draws just the map.
const DATA = 'data/';
const SETTINGS_KEY = 'legacy-map-settings';
// Studs from the camera to the region's rectangle (height counts), per Studio category. Tuned so the
// worst views measured (mid-height over the centre, low over Spawn) stay near 500 draws.
const CULL = {
  Props: 1000, Cushions: 900, Ziplines: 1400, MapDecoration: 1500, Billboards: 1500, HackableBillboards: 1600,
};
const CULL_EVERY = 10; // frames between distance checks

// Colours from ReplicatedStorage.TimeTrialConfig.Colors
const DIFFS = ['Easy', 'Intermediate', 'Hard', 'Insane', 'Impossible', 'Insurmountable'];
const DIFF_COLOR = {
  Easy: '#00ff00', Intermediate: '#ffff00', Hard: '#6b327c',
  Insane: '#000000', Impossible: '#210000', Insurmountable: '#ff0000',
};
// places.json types; "Site" entries are the spawn points.
const PLACE_TYPES = [['Site', 'Spawns', '#4aa3ff'], ['Tower', 'Towers', '#ffffff'], ['Secret', 'Secrets', '#ff5ad1']];
const PLACE_COLOR = Object.fromEntries(PLACE_TYPES.map(([t, , c]) => [t, c]));
const PAD_PICK_STUDS = 8; // a click this close to a trial's Start.Main selects that trial
const LABEL_DIST = 1400;

// ---------- settings ----------
// Saved with the layer toggles. Draw distance scales CULL.
// The scene always uses the daytime look; Theme only recolours the UI (panels, labels).
const SCENE_LOOK = { sky: '#b9cfe2', hemiSky: 0xeef4ff, hemiGround: 0x5a5f66, hemi: 2.2, sun: 2.0, sunColor: 0xffffff };
const DISTANCE = { near: 0.6, normal: 1, far: 1.8 };
const LABEL_SIZE = { s: '9px', m: '11px', l: '14px' };
const FOG = { near: 3000, far: 11000 };
const DEFAULT_SETTINGS = { theme: 'system', distance: 'normal', quality: 'high', fog: 'on', labels: 'm', helpOnStart: false };
let saved = {};
try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { /* defaults */ }
const settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
const systemDark = matchMedia('(prefers-color-scheme: dark)');

// ---------- scene ----------
const canvas = document.getElementById('view');
// Antialiasing is fixed when the WebGL context is made, so the Quality setting only changes it on reload.
const antialias = settings.quality === 'high';
const renderer = new THREE.WebGLRenderer({ canvas, antialias, logarithmicDepthBuffer: true });
const labelRenderer = new CSS2DRenderer({ element: document.getElementById('labels') });
const scene = new THREE.Scene();
scene.background = new THREE.Color(SCENE_LOOK.sky);
const camera = new THREE.PerspectiveCamera(70, 1, 1, 30000); // Studio's default field of view
const hemi = new THREE.HemisphereLight(SCENE_LOOK.hemiSky, SCENE_LOOK.hemiGround, SCENE_LOOK.hemi);
scene.add(hemi);
const sun = new THREE.DirectionalLight(SCENE_LOOK.sunColor, SCENE_LOOK.sun);
sun.position.set(0.6, 1, 0.35);
scene.add(sun);

function applyTheme() {
  document.documentElement.dataset.theme =
    settings.theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : settings.theme;
}
systemDark.addEventListener('change', () => { if (settings.theme === 'system') applyTheme(); });

function applyFog() {
  scene.fog = settings.fog === 'on' ? new THREE.Fog(scene.background.clone(), FOG.near, FOG.far) : null;
}

function anisotropy() {
  return settings.quality === 'high' ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 1;
}

function applyQuality() {
  renderer.setPixelRatio(settings.quality === 'high' ? Math.min(devicePixelRatio, 2) : 1);
  resize();
  for (const t of [...textures.values(), tileUniform.value]) {
    t.anisotropy = anisotropy();
    t.needsUpdate = true;
  }
  document.getElementById('qualityHint').hidden = antialias === (settings.quality === 'high');
}

function applyLabels() {
  document.documentElement.style.setProperty('--label-size', LABEL_SIZE[settings.labels]);
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  labelRenderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- materials ----------
// Each glTF material carries extras: class (opaque / trans / neon / ff / surface), and for textured
// draws either "map" (one image) or "tiles" (Texture quads sampling the shared texture array by _LAYER).
let V = ''; // ?v=<build> cache-buster for every data URL, set once index.json is in
const textureLoader = new THREE.TextureLoader();
const textures = new Map();
function texture(path) {
  let t = textures.get(path);
  if (!t) {
    t = textureLoader.load(DATA + path + V);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.flipY = false; // glTF UV convention: v runs down from the image's top edge
    t.anisotropy = anisotropy();
    textures.set(path, t);
  }
  return t;
}

// The texture array starts as a 1-layer placeholder; loadTiles() swaps in the real one through this
// shared uniform, so materials compiled before it arrives pick it up without recompiling.
const tileUniform = { value: new THREE.DataArrayTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, 1) };
tileUniform.value.needsUpdate = true;
const whitePixel = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
whitePixel.needsUpdate = true;

async function loadTiles(meta) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = DATA + meta.file + V;
  });
  const S = meta.size;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = new Uint8Array(S * S * 4 * meta.count);
  for (let i = 0; i < meta.count; i++) {
    data.set(ctx.getImageData((i % meta.cols) * S, Math.floor(i / meta.cols) * S, S, S).data, i * S * S * 4);
  }
  const t = new THREE.DataArrayTexture(data, S, S, meta.count);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = anisotropy();
  t.needsUpdate = true;
  tileUniform.value = t;
}

function useTiles(m) {
  // A 1x1 map turns on USE_MAP and vMapUv; the fragment then samples the array instead.
  m.map = whitePixel;
  m.onBeforeCompile = s => {
    s.uniforms.tileArray = tileUniform;
    s.vertexShader = 'attribute float _layer;\nvarying float vLayer;\n'
      + s.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvLayer = _layer;');
    s.fragmentShader = 'uniform highp sampler2DArray tileArray;\nvarying float vLayer;\n'
      + s.fragmentShader.replace('#include <map_fragment>',
        'diffuseColor *= texture(tileArray, vec3(vMapUv, floor(vLayer + 0.5)));');
  };
  m.customProgramCacheKey = () => 'tiles';
}

function styleMaterial(m) {
  const x = m.userData || {};
  if (x.tiles) useTiles(m);
  else if (x.map) m.map = texture(x.map);
  if (m.transparent) m.depthWrite = false;
  if ('roughness' in m) { m.roughness = 1; m.metalness = 0; }
  m.needsUpdate = true;
}

// ---------- map files ----------
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const state = { layers: { map: true, props: false, decor: false, trialLabels: true, pois: true },
  diff: new Set(DIFFS), search: '', selected: null };
Object.assign(state.layers, saved.layers || {});
state.layers.map = true;
const saveSettings = () => {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ layers: state.layers, settings, helpSeen: true })); } catch { /* ignore */ }
};

const layerGroups = {}; // layer -> Group
const files = [];       // { region, meta, group, state: 'idle' | 'loading' | 'loaded' }
const pickable = [];    // map meshes, for clicking a trial's start pad
let index, pending = 0;
const loadingEl = document.getElementById('loading');

function setPending(d) {
  pending += d;
  loadingEl.style.display = pending ? 'block' : 'none';
  loadingEl.textContent = `Loading ${pending} file${pending === 1 ? '' : 's'}…`;
}

async function loadFile(f) {
  f.state = 'loading';
  setPending(1);
  try {
    const gltf = await loader.loadAsync(DATA + f.meta.path + V);
    gltf.scene.traverse(o => {
      if (!o.isMesh) return;
      styleMaterial(o.material);
      if (o.material.userData?.class !== 'ff') pickable.push(o);
      // Map geometry is what the camera zooms and pans against, glass included so zoom stops at a glass wall;
      // decal/texture sheets and ForceField shells aren't.
      if (f.meta.layer === 'map' && !/^(surface|decal)\|/.test(o.name) && o.material.userData?.class !== 'ff') {
        if (!o.isInstancedMesh && o.geometry.index && o.geometry.index.count / 3 >= BVH_MIN_TRIANGLES) o.geometry.computeBoundsTree();
        surfaceMeshes.push(o);
        collisionDirty = true;
      }
    });
    f.group.add(gltf.scene);
    f.state = 'loaded';
  } catch (e) {
    console.error(f.meta.path, e);
    f.state = 'idle';
  } finally {
    setPending(-1);
  }
}

function regionDistance(r) {
  if (!r) return 0; // the ground belongs to no region and never culls
  const [x0, z0, x1, z1] = r.bounds, p = camera.position;
  return Math.hypot(Math.max(x0 - p.x, 0, p.x - x1), Math.max(z0 - p.z, 0, p.z - z1), p.y);
}

// Distance culling and lazy loading in one pass, nearest files first.
function updateFiles() {
  const want = [];
  for (const f of files) {
    const d = regionDistance(f.region);
    f.group.visible = d <= (CULL[f.meta.category] ?? Infinity) * DISTANCE[settings.distance];
    if (f.group.visible && f.state === 'idle' && state.layers[f.meta.layer]) want.push([d, f]);
  }
  want.sort((a, b) => a[0] - b[0]);
  for (const [, f] of want) loadFile(f);
}

function applyLayers() {
  for (const [layer, g] of Object.entries(layerGroups)) g.visible = !!state.layers[layer];
  if (pois) pois.placeMesh.visible = state.layers.pois;
  updateFiles();
}

// ---------- labels, trials, places ----------
function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const fmt = v => `${Math.round(v.x)}, ${Math.round(v.y)}, ${Math.round(v.z)}`;
const v3 = a => new THREE.Vector3(a[0], a[1], a[2]);

function makeLabel(text, cls, onClick) {
  const el = document.createElement('div');
  el.className = 'lbl ' + (cls || '');
  el.textContent = text;
  if (onClick) {
    el.classList.add('click');
    el.addEventListener('pointerdown', e => e.stopPropagation());
    el.addEventListener('click', onClick);
  }
  return new CSS2DObject(el);
}

let trials = [], pois = null, marker = null;

function buildTrials(list) {
  return list.filter(t => t.start && t.finish).map((t, i) => {
    const trial = { ...t, index: i, startV: v3(t.start), endV: v3(t.finish), kind: 'trial' };
    trial.label = makeLabel(t.name, '', () => select(trial, true));
    trial.label.position.set(trial.startV.x, trial.startV.y + 40, trial.startV.z);
    scene.add(trial.label);
    return trial;
  });
}

// The selected trial's markers, built like the game builds them:
//   beam   ReplicatedStorage.TrialBeam at Start.Main + (0, -0.5, 0), coloured like Start.Arrow
//   pillar ReplicatedStorage.TrialTemplate.End at Transparency 0.4 for the active trial
//   route  a straight start-to-end line
// Only the selected trial gets them, so nothing is drawn until a trial is picked.
function buildMarker(visuals) {
  const column = color => new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.5, 1, 16, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  const beam = column(0xffffff), pillar = column('#' + visuals.finish.color);
  pillar.material.opacity = 1 - visuals.finish.activeTransparency;
  const route = new THREE.Line(new THREE.BufferGeometry().setFromPoints([v3([0, 0, 0]), v3([0, 0, 0])]),
    new THREE.LineBasicMaterial({ transparent: true, opacity: 0.8 }));
  for (const o of [beam, pillar, route]) {
    o.renderOrder = 2;
    o.frustumCulled = false;
    o.visible = false;
    scene.add(o);
  }
  return { beam, pillar, route, visuals };
}

function buildPois(list) {
  const places = list.map(p => ({ ...p, cat: p.type, pos: v3(p.pos), kind: 'poi' }));
  const dia = new THREE.OctahedronGeometry(10).scale(1, 1.6, 1).translate(0, 22, 0);
  const placeMesh = new THREE.InstancedMesh(dia, new THREE.MeshBasicMaterial(), places.length);
  const c = new THREE.Color();
  places.forEach((p, i) => {
    placeMesh.setColorAt(i, c.set(PLACE_COLOR[p.cat] || '#ffffff'));
    p.index = i;
    p.label = makeLabel(p.name, 'poi', () => select(p, true));
    p.label.position.set(p.pos.x, p.pos.y + 48, p.pos.z);
    scene.add(p.label);
  });
  placeMesh.userData.items = places;
  scene.add(placeMesh);
  return { places, placeMesh };
}

// Markers grow as the camera pulls back so they stay readable from overview height. The beam and
// pillar keep their in-game height and only widen, since a 2-stud beam vanishes from afar.
let markerScale = 1;
function writeMarkers() {
  const s = markerScale;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(s, s, s);
  for (const pl of pois.places) pois.placeMesh.setMatrixAt(pl.index, m4.compose(pl.pos, q, sv));
  pois.placeMesh.instanceMatrix.needsUpdate = true;
  pois.placeMesh.computeBoundingSphere();

  const { beam, pillar, route, visuals } = marker;
  const t = state.selected?.kind === 'trial' ? state.selected : null;
  beam.visible = pillar.visible = route.visible = !!t;
  if (!t) return;
  const [bw, bh] = visuals.beam.size, [ew, eh] = visuals.finish.size;
  beam.position.copy(t.startV).add(new THREE.Vector3(0, visuals.beam.offsetY, 0));
  beam.scale.set(bw * s, bh, bw * s);
  pillar.position.copy(t.endV);
  pillar.scale.set(ew * s, eh, ew * s);
  beam.material.color.set('#' + (t.arrowColor || DIFF_COLOR[t.difficulty].slice(1)));
  // Black and dark-red arrows would vanish as a thin line against the map, so draw those white.
  route.material.color.set(t.difficulty === 'Insane' || t.difficulty === 'Impossible' ? '#ffffff' : beam.material.color);
  route.geometry.setFromPoints([t.startV.clone().setY(t.startV.y + 4), t.endV.clone().setY(t.endV.y + 4)]);
}

// Same fade as StarterPack.TimeTrials for a completed trial, using the camera as the player:
// Transparency = max(0.25, 1 - (horizontalDistance - 15) / 50), so the beam vanishes as you reach it.
function fadeBeam() {
  const t = state.selected;
  if (t?.kind !== 'trial') return;
  const closest = Math.hypot(camera.position.x - t.startV.x, camera.position.z - t.startV.z);
  marker.beam.material.opacity = 1 - Math.min(1, Math.max(0.25, 1 - (closest - 15) / 50));
}

// ---------- side menu ----------
const listEl = document.getElementById('list');
const infoEl = document.getElementById('info');

function buildUi() {
  const chips = document.getElementById('chips');
  for (const d of DIFFS) {
    if (!trials.some(t => t.difficulty === d)) continue;
    const b = document.createElement('button');
    b.className = 'chip';
    b.innerHTML = `<span class="dot" style="background:${DIFF_COLOR[d]}"></span>${d}`;
    b.onclick = () => {
      state.diff.has(d) ? state.diff.delete(d) : state.diff.add(d);
      b.classList.toggle('off', !state.diff.has(d));
      renderList();
    };
    chips.append(b);
  }
  for (const cb of document.querySelectorAll('[data-layer]')) {
    cb.checked = !!state.layers[cb.dataset.layer];
    cb.onchange = () => {
      state.layers[cb.dataset.layer] = cb.checked;
      saveSettings();
      applyLayers();
    };
  }
  document.getElementById('search').oninput = e => { state.search = norm(e.target.value); renderList(); };
  renderList();
  for (const seg of document.querySelectorAll('[data-setting]')) {
    const key = seg.dataset.setting;
    const mark = () => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === settings[key]));
    seg.onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      settings[key] = b.dataset.v;
      mark();
      saveSettings();
      APPLY[key]();
    };
    mark();
  }
}
// ---------- dialogs ----------
// Settings and Help are <dialog>s opened from the side menu's header. Help also opens by itself the first
// time the map loads (nothing saved yet), and on every load while "Show this when the map opens" is ticked.
const settingsDlg = document.getElementById('settings');
const helpDlg = document.getElementById('help');
document.getElementById('openSettings').onclick = () => settingsDlg.showModal();
document.getElementById('openHelp').onclick = () => helpDlg.showModal();
for (const dlg of [settingsDlg, helpDlg]) {
  dlg.addEventListener('click', e => {
    if (e.target.closest('[data-close]') || e.target === dlg) dlg.close(); // a click on the backdrop lands on the dialog itself
  });
}
const helpOnStart = document.getElementById('helpOnStart');
helpOnStart.checked = settings.helpOnStart;
helpOnStart.onchange = () => { settings.helpOnStart = helpOnStart.checked; saveSettings(); };
helpDlg.addEventListener('close', saveSettings);
if (!saved.helpSeen || settings.helpOnStart) helpDlg.showModal();

const APPLY = { theme: applyTheme, distance: () => updateFiles(), quality: applyQuality, fog: applyFog, labels: applyLabels };

function trialVisible(t) { return state.diff.has(t.difficulty); }

function renderList() {
  const q = state.search;
  const match = (...names) => !q || names.some(n => n && norm(n).includes(q));
  const rows = [];
  const ts = trials.filter(t => trialVisible(t) && match(t.name, t.id, t.region))
    .sort((a, b) => DIFFS.indexOf(a.difficulty) - DIFFS.indexOf(b.difficulty) || a.name.localeCompare(b.name));
  rows.push(`<div class="listhead">Trials (${ts.length})</div>`);
  for (const t of ts) {
    rows.push(`<div class="item${state.selected === t ? ' sel' : ''}" data-t="${t.index}"><span class="dot" style="background:${DIFF_COLOR[t.difficulty]}"></span>${esc(t.name)}<small>${esc(t.region || '')}</small></div>`);
  }
  for (const [type, title] of PLACE_TYPES) {
    const ps = pois.places.filter(p => p.cat === type && match(p.name, p.region)).sort((a, b) => a.name.localeCompare(b.name));
    rows.push(`<div class="listhead">${title} (${ps.length})</div>`);
    for (const p of ps) {
      rows.push(`<div class="item${state.selected === p ? ' sel' : ''}" data-p="${p.index}"><span class="dot" style="background:${PLACE_COLOR[p.cat]}"></span>${esc(p.name)}<small>${esc(p.region || '')}</small></div>`);
    }
  }
  listEl.innerHTML = rows.join('');
}
listEl.onclick = e => {
  const it = e.target.closest('.item');
  if (!it) return;
  select(it.dataset.t !== undefined ? trials[+it.dataset.t] : pois.places[+it.dataset.p], true);
};

// The selected menu item's details: the top-right card (bottom sheet on phones).
function renderSelected(item) {
  if (!item) { infoEl.style.display = 'none'; return; }
  let html;
  if (item.kind === 'trial') {
    html = `<h3><span class="dot" style="background:${DIFF_COLOR[item.difficulty]}"></span>${esc(item.name)}</h3>
      <div class="row"><span>Difficulty</span><span>${item.difficulty}</span></div>
      <div class="row"><span>Region</span><span>${esc(item.region || '–')}</span></div>
      <div class="row"><span>Perfect time</span><span>${item.perfectTime ?? '–'} s</span></div>
      <div class="row"><span>Course points</span><span>${item.points ?? '–'}</span></div>
      <div class="row"><span>Straight distance</span><span>${Math.round(item.startV.distanceTo(item.endV))} studs</span></div>
      <div class="row"><span>Height change</span><span>${Math.round(item.endV.y - item.startV.y)} studs</span></div>
      <div class="acts"><button class="act" id="goStart">Start</button><button class="act" id="goEnd">End</button><button class="act" id="clearSel">Close</button></div>`;
  } else {
    const type = (PLACE_TYPES.find(([t]) => t === item.cat) || [, item.cat])[1];
    html = `<h3><span class="dot" style="background:${PLACE_COLOR[item.cat]}"></span>${esc(item.name)}</h3>
      <div class="row"><span>Type</span><span>${esc(type)}</span></div>
      <div class="row"><span>Region</span><span>${esc(item.region || '–')}</span></div>
      <div class="row"><span>Position</span><span>${fmt(item.pos)}</span></div>`
      + (item.verified ? '' : '<div class="note">Approximate position, not yet confirmed in Studio.</div>')
      + '<div class="acts"><button class="act" id="clearSel">Close</button></div>';
  }
  infoEl.innerHTML = html;
  infoEl.style.display = 'block';
  document.getElementById('goStart')?.addEventListener('click', () => flyTo(item.startV));
  document.getElementById('goEnd')?.addEventListener('click', () => flyTo(item.endV));
  document.getElementById('clearSel').onclick = () => select(null);
}

function select(item, fly) {
  if (state.selected?.label) state.selected.label.element.classList.remove('sel');
  state.selected = item;
  writeMarkers();
  renderSelected(item);
  renderList();
  if (!item) return;
  if (item.label) item.label.element.classList.add('sel');
  if (fly) flyTo(item.startV || item.pos);
}

// ---------- camera ----------
// Roblox Studio-style free-fly camera (site/studio-camera.js). F focuses the selected trial or place.
const surfaceMeshes = [];
// Most map geometry is instanced, which a per-geometry BVH can't speed up, so for the camera's raycasts all
// solid map geometry (about 110k triangles) is baked into one world-space mesh with a single BVH. It is
// (re)built on demand once no files are loading; until then the meshes are raycast directly.
let collision = null, collisionDirty = false;
function cameraSurfaces() {
  if (collisionDirty && !pending) {
    collision = buildCollision(surfaceMeshes);
    collisionDirty = false;
  }
  return collision && !collisionDirty ? [collision] : surfaceMeshes.filter(visibleUp);
}
function buildCollision(meshes) {
  let tris = 0;
  for (const m of meshes) tris += (m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3) * (m.isInstancedMesh ? m.count : 1);
  const out = new Float32Array(tris * 9);
  const v = new THREE.Vector3(), world = new THREE.Matrix4(), inst = new THREE.Matrix4();
  let w = 0;
  for (const m of meshes) {
    m.updateWorldMatrix(true, false);
    const pos = m.geometry.attributes.position, idx = m.geometry.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < (m.isInstancedMesh ? m.count : 1); i++) {
      if (m.isInstancedMesh) {
        m.getMatrixAt(i, inst); // fills inst; returns nothing
        world.multiplyMatrices(m.matrixWorld, inst);
      } else world.copy(m.matrixWorld);
      for (let j = 0; j < n; j++) {
        v.fromBufferAttribute(pos, idx ? idx.getX(j) : j).applyMatrix4(world);
        out[w++] = v.x; out[w++] = v.y; out[w++] = v.z;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  g.computeBoundsTree();
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial()); // never added to the scene; FrontSide like the map
  mesh.updateMatrixWorld();
  return mesh;
}
const cam = new StudioCamera(camera, canvas, {
  surfaces: cameraSurfaces,
  onFocus: () => { if (state.selected) flyTo(state.selected.startV || state.selected.pos); },
});
function flyTo(target, dist = 320) { cam.flyTo(target, dist); }

// ---------- picking ----------
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function visibleUp(o) { for (; o; o = o.parent) if (!o.visible) return false; return true; }
function setRay(e) {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
}
function markerHit() {
  if (!pois || !state.layers.pois) return null;
  const hit = ray.intersectObject(pois.placeMesh, false)[0];
  return hit ? hit.object.userData.items[hit.instanceId] : null;
}

canvas.addEventListener('pointermove', e => {
  setRay(e);
  canvas.style.cursor = markerHit() ? 'pointer' : '';
});
let downAt = null;
canvas.addEventListener('pointerdown', e => { downAt = e.button === 0 && !e.altKey ? [e.clientX, e.clientY] : null; });
canvas.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  setRay(e);
  const item = markerHit();
  if (item) { select(item, true); return; }
  const hit = ray.intersectObjects(pickable.filter(visibleUp), false)[0];
  if (!hit) return;
  // Clicking a trial's start pad selects that trial.
  const pad = trials.find(t => trialVisible(t) && t.startV.distanceTo(hit.point) < PAD_PICK_STUDS);
  if (pad) select(pad, false);
});
addEventListener('keydown', e => { if (e.key === 'Escape') select(null); });

// ---------- start ----------
index = await fetch(DATA + 'index.json', { cache: 'no-cache' }).then(r => r.json());
V = `?v=${index.build}`;
if (index.tiles) loadTiles(index.tiles);
for (const layer of Object.keys(index.layers)) {
  layerGroups[layer] = new THREE.Group();
  layerGroups[layer].name = layer;
  scene.add(layerGroups[layer]);
}
function addFile(region, meta) {
  const fg = new THREE.Group();
  fg.name = meta.path;
  layerGroups[meta.layer].add(fg);
  files.push({ region, meta, group: fg, state: 'idle' });
}
if (index.ground) addFile(null, { ...index.ground, category: 'Baseplates', layer: 'map' });
for (const r of index.regions) for (const meta of r.files) addFile(r, meta);

const [trialList, placeList, trialVisuals] = await Promise.all([
  fetch(DATA + 'trials.json' + V).then(r => r.json()),
  fetch(DATA + 'places.json' + V).then(r => r.json()),
  fetch(DATA + 'trial-visuals.json' + V).then(r => r.json()),
]);
trials = buildTrials(trialList);
pois = buildPois(placeList);
marker = buildMarker(trialVisuals);
document.getElementById('stats').textContent =
  `${trials.length} trials · ${pois.places.length} places · ${index.regions.length} regions`;

const [x0, z0, x1, z1] = index.extent;
camera.position.set((x0 + x1) / 2, 3800, (z0 + z1) / 2 + 3200);
cam.lookAt(new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2));
applyTheme();
applyFog();
applyQuality();
applyLabels();
buildUi();
applyLayers();
writeMarkers();
// Console handle for poking at the scene, e.g. viewer.flyTo(new viewer.THREE.Vector3(x, y, z), 60)
window.viewer = { THREE, scene, camera, cam, renderer, flyTo, select, index, files, trials, updateFiles };

// ---------- loop ----------
function updateLabels() {
  const cam = camera.position;
  for (const t of trials) {
    const near = state.layers.trialLabels && trialVisible(t) && cam.distanceTo(t.label.position) < LABEL_DIST;
    t.label.visible = near || t === state.selected;
  }
  for (const p of pois.places) {
    const near = state.layers.pois && cam.distanceTo(p.label.position) < LABEL_DIST * 1.6;
    p.label.visible = near || p === state.selected;
  }
}

let frame = 0, lastFrame = null;
renderer.setAnimationLoop(now => {
  const dt = Math.min(0.1, (now - (lastFrame ?? now)) / 1000);
  lastFrame = now;
  cam.update(dt);
  if (++frame % CULL_EVERY === 0) updateFiles();
  const want = THREE.MathUtils.clamp(cam.focusDistance() / 700, 1, 5);
  if (Math.abs(want - markerScale) / markerScale > 0.08) { markerScale = want; writeMarkers(); }
  fadeBeam();
  updateLabels();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
});
