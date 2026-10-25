'use strict';
/* =====================================================================
   RoadRanger AI – real-map distance, travel-time and route advisor
   No build step, no API keys needed (except the optional Claude panel).
   ===================================================================== */

/* ---------- 1. SETTINGS (edit these freely) ---------- */
const CONFIG = {
  routing: {
    car:  'https://routing.openstreetmap.de/routed-car',
    bike: 'https://routing.openstreetmap.de/routed-bike',
    foot: 'https://routing.openstreetmap.de/routed-foot'
  },
  nominatim: 'https://nominatim.openstreetmap.org',   // place search + reverse geocoding
  overpass:  'https://overpass-api.de/api/interpreter', // nearby places
  weather:   'https://api.open-meteo.com/v1/forecast',  // free weather, no key
  claudeModel: 'claude-sonnet-5-5',                     // used only by the optional "Ask Claude" box
  currency: '$',
  startView: { center: [20, 10], zoom: 2 }
};

/* cost = currency per km, co2 = kg per km, kcal = per km, speed = km/h (for bike/walk) */
const MODES = {
  car:  { label: 'Car',       icon: '🚗', profile: 'car',  color: '#2563eb', mul: 1,    wait: 0, cost: 0.12, co2: 0.17, kcal: 0 },
  moto: { label: 'Motorbike', icon: '🏍️', profile: 'car',  color: '#ea580c', mul: 0.85, wait: 0, cost: 0.05, co2: 0.10, kcal: 0 },
  bus:  { label: 'Bus (est.)', icon: '🚌', profile: 'car',  color: '#7c3aed', mul: 1.7,  wait: 8, cost: 0.04, co2: 0.09, kcal: 0 },
  bike: { label: 'Bicycle',   icon: '🚴', profile: 'bike', color: '#16a34a', speed: 15,  cost: 0,    co2: 0,    kcal: 30 },
  walk: { label: 'Walking',   icon: '🚶', profile: 'foot', color: '#db2777', speed: 5,   cost: 0,    co2: 0,    kcal: 55 }
};
const TRAFFIC = { light: 1, normal: 1.25, heavy: 1.6 };   // multiplier on road travel time
const MAX_STOPS = 8;
const NEARBY = [
  ['⛽ Fuel', '[amenity=fuel]'], ['🍽️ Food', '[amenity~"restaurant|cafe|fast_food"]'],
  ['🏥 Hospital', '[amenity=hospital]'], ['💊 Pharmacy', '[amenity=pharmacy]'],
  ['🏧 ATM', '[amenity=atm]'], ['🏨 Hotel', '[tourism=hotel]'], ['🅿️ Parking', '[amenity=parking]']
];

/* ---------- 2. STATE + HELPERS ---------- */
const state = {
  stops: [null, null], mode: 'car', routes: {}, traffic: 'normal', priority: 'balanced',
  units: 'km', pick: null, weather: null, advice: null, estimated: false,
  markers: [], routeLayers: [], simTimer: null
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const letter = i => String.fromCharCode(65 + i);

function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  kids.flat().filter(k => k !== null && k !== undefined && k !== false).forEach(k => n.append(k));
  return n;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function fmtDist(km) {
  if (state.units === 'mi') {
    const mi = km * 0.621371;
    return mi < 0.1 ? `${Math.round(mi * 5280)} ft` : `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
  }
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 2 : 1)} km`;
}
function fmtTime(min) {
  if (min < 1) return '< 1 min';
  const t = Math.round(min), d = Math.floor(t / 1440), h = Math.floor((t % 1440) / 60), m = t % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m} min`;
}
const fmtMoney = v => (v < 0.005 ? 'Free' : CONFIG.currency + v.toFixed(2));
const shortName = n => n.split(',').slice(0, 3).map(s => s.trim()).join(', ');

function haversine(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const filled = () => state.stops.filter(Boolean);

/* ---------- 3. MAP ---------- */
const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© OpenStreetMap contributors'
});
const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19, attribution: 'Imagery © Esri'
});
const map = L.map('map', { layers: [street] }).setView(CONFIG.startView.center, CONFIG.startView.zoom);
L.control.layers({ Street: street, Satellite: satellite }).addTo(map);
L.control.scale().addTo(map);
const nearbyLayer = L.layerGroup().addTo(map);

function drawMarkers() {
  state.markers.forEach(m => m.remove());
  state.markers = [];
  const last = state.stops.length - 1;
  state.stops.forEach((p, i) => {
    if (!p) return;
    const cls = i === 0 ? 'start' : i === last ? 'end' : 'via';
    const icon = L.divIcon({
      className: '', html: `<div class="pin ${cls}"><span>${letter(i)}</span></div>`,
      iconSize: [34, 34], iconAnchor: [17, 41]
    });
    const m = L.marker([p.lat, p.lng], { icon, draggable: true, title: p.name }).addTo(map);
    m.on('dragend', () => {
      const ll = m.getLatLng();
      const np = { lat: ll.lat, lng: ll.lng, name: `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}` };
      state.stops[i] = np;
      syncInputs();
      reverseName(np);
      scheduleRoute();
    });
    state.markers.push(m);
  });
}

map.on('click', e => {
  if (state.pick !== null) {
    const i = state.pick;
    state.pick = null;
    document.body.classList.remove('picking');
    placeFromMap(e.latlng, i);
    return;
  }
  const mk = (text, fn) => el('button', { type: 'button', textContent: text, onclick: () => { map.closePopup(); fn(); } });
  const box = el('div', { className: 'popup' },
    el('b', { textContent: `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}` }),
    mk('Set as start (A)', () => placeFromMap(e.latlng, 0)),
    mk('Set as destination', () => placeFromMap(e.latlng, state.stops.length - 1)),
    mk('Add as stop', () => {
      if (state.stops.length >= MAX_STOPS) return toast(`Maximum ${MAX_STOPS} stops`);
      state.stops.splice(state.stops.length - 1, 0, null);
      renderStops();
      placeFromMap(e.latlng, state.stops.length - 2);
    })
  );
  L.popup().setLatLng(e.latlng).setContent(box).openOn(map);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { state.pick = null; document.body.classList.remove('picking'); }
});

function placeFromMap(ll, i) {
  const p = { lat: ll.lat, lng: ll.lng, name: `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}` };
  setStop(i, p);
  reverseName(p);
}

/* ---------- 4. STOPS + SEARCH DROPDOWN ---------- */
function setStop(i, p) {
  state.stops[i] = p;
  renderStops();
  drawMarkers();
  if (filled().length < 2) map.flyTo([p.lat, p.lng], 14);
  scheduleRoute();
}

async function reverseName(p) {
  try {
    const r = await fetch(`${CONFIG.nominatim}/reverse?format=jsonv2&zoom=17&lat=${p.lat}&lon=${p.lng}`);
    const j = await r.json();
    if (j.display_name) { p.name = shortName(j.display_name); syncInputs(); }
  } catch { /* keep coordinates as the name */ }
}

function syncInputs() {
  $$('#stops input').forEach(inp => {
    const s = state.stops[+inp.dataset.index];
    if (document.activeElement !== inp) inp.value = s ? s.name : '';
  });
}

function renderStops() {
  const box = $('#stops');
  box.innerHTML = '';
  const last = state.stops.length - 1;
  state.stops.forEach((s, i) => {
    const input = el('input', {
      type: 'text', autocomplete: 'off', spellcheck: false, value: s ? s.name : '',
      placeholder: i === 0 ? 'Start: search a place…' : i === last ? 'Destination: search a place…' : `Stop ${i}: search a place…`
    });
    input.dataset.index = i;
    const list = el('ul', { className: 'suggest' });
    const pick = el('button', { className: 'icon', type: 'button', title: 'Pick on map', textContent: '📍' });
    pick.onclick = () => {
      state.pick = i;
      document.body.classList.add('picking');
      toast(`Click the map to set ${letter(i)} (Esc to cancel)`);
    };
    const rm = el('button', { className: 'icon', type: 'button', title: 'Remove stop', textContent: '✕' });
    rm.onclick = () => { state.stops.splice(i, 1); renderStops(); drawMarkers(); scheduleRoute(); };
    box.append(el('div', { className: 'stop' },
      el('span', { className: 'badge ' + (i === 0 ? 'start' : i === last ? 'end' : ''), textContent: letter(i) }),
      el('div', { className: 'inwrap' }, input, list),
      pick,
      state.stops.length > 2 ? rm : el('span')
    ));
    attachSearch(input, list, i);
  });
}

function attachSearch(input, list, index) {
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { state.stops[index] = null; drawMarkers(); scheduleRoute(); list.innerHTML = ''; return; }
    if (q.length < 3) { list.innerHTML = ''; return; }
    timer = setTimeout(() => search(q, list, index), 400);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); const first = $('li:not(.muted)', list); if (first) first.click(); }
  });
}
document.addEventListener('click', e => {
  if (!e.target.closest('.inwrap')) $$('.suggest').forEach(u => (u.innerHTML = ''));
});

async function search(q, list, index) {
  const coord = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (coord) {
    const lat = +coord[1], lng = +coord[2];
    list.innerHTML = '';
    list.append(el('li', {
      textContent: `Use coordinates ${lat}, ${lng}`,
      onclick: () => { list.innerHTML = ''; placeFromMap({ lat, lng }, index); }
    }));
    return;
  }
  list.innerHTML = '<li class="muted">Searching…</li>';
  try {
    const r = await fetch(`${CONFIG.nominatim}/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`);
    const rows = await r.json();
    list.innerHTML = '';
    if (!rows.length) { list.innerHTML = '<li class="muted">No places found. Try a different spelling.</li>'; return; }
    rows.forEach(row => {
      const parts = row.display_name.split(',');
      list.append(el('li', {
        onclick: () => {
          list.innerHTML = '';
          setStop(index, { lat: +row.lat, lng: +row.lon, name: shortName(row.display_name) });
        }
      }, el('b', { textContent: parts[0] }), el('small', { textContent: parts.slice(1, 4).join(',').trim() })));
    });
  } catch {
    list.innerHTML = '<li class="muted">Search failed. Check your internet connection.</li>';
  }
}

/* ---------- 5. ROUTING ---------- */
let routeTimer;
function scheduleRoute() { clearTimeout(routeTimer); routeTimer = setTimeout(route, 350); }

async function fetchRoute(profile, coords) {
  const url = `${CONFIG.routing[profile]}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.code !== 'Ok') throw new Error(j.code);
  const rt = j.routes[0];
  return {
    distance: rt.distance, duration: rt.duration, coords: rt.geometry.coordinates,
    steps: rt.legs.flatMap(l => l.steps), legs: rt.legs.map(l => ({ distance: l.distance, duration: l.duration }))
  };
}

function estimateRoute(pts) {  // offline fallback if the routing server is unreachable
  let km = 0;
  const legs = [];
  for (let i = 1; i < pts.length; i++) { const d = haversine(pts[i - 1], pts[i]) * 1.3; km += d; legs.push({ distance: d * 1000, duration: d / 40 * 3600 }); }
  return { distance: km * 1000, duration: km / 40 * 3600, coords: pts.map(p => [p.lng, p.lat]), steps: [], legs, estimated: true };
}

async function route() {
  const pts = filled();
  if (pts.length < 2) { clearRoute(); return; }
  $('#loading').hidden = false;
  const coords = pts.map(p => `${p.lng},${p.lat}`).join(';');
  const profiles = ['car', 'bike', 'foot'];
  const res = await Promise.allSettled(profiles.map(p => fetchRoute(p, coords)));
  state.routes = {};
  state.estimated = false;
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') state.routes[profiles[i]] = r.value;
    else { state.routes[profiles[i]] = estimateRoute(pts); state.estimated = true; }
  });
  $('#loading').hidden = true;
  if (state.estimated) toast('Routing server unreachable: showing straight-line estimates');
  $('#results').hidden = false;
  drawRoute(true);
  renderResults();
  loadWeather(pts[pts.length - 1]);
  saveHistory(pts);
}

function clearRoute() {
  state.routes = {};
  state.routeLayers.forEach(l => l.remove());
  state.routeLayers = [];
  $('#results').hidden = true;
  $('#loading').hidden = true;
}

function drawRoute(fit) {
  stopSim();
  state.routeLayers.forEach(l => l.remove());
  state.routeLayers = [];
  const m = MODES[state.mode], r = state.routes[m.profile];
  if (!r) return;
  const ll = r.coords.map(([lng, lat]) => [lat, lng]);
  const casing = L.polyline(ll, { color: '#fff', weight: 10, opacity: 0.9 }).addTo(map);
  const line = L.polyline(ll, {
    color: m.color, weight: 6, opacity: 0.95, lineCap: 'round',
    dashArray: state.mode === 'walk' ? '1 10' : state.estimated ? '8 8' : undefined
  }).addTo(map);
  state.routeLayers.push(casing, line);
  if (fit) map.fitBounds(line.getBounds(), { padding: [60, 60] });
}

/* ---------- 6. METRICS + AI ADVISOR ---------- */
function metrics(k) {
  const m = MODES[k], r = state.routes[m.profile];
  if (!r) return null;
  const km = r.distance / 1000;
  const min = m.profile === 'car'
    ? (r.duration / 60) * TRAFFIC[state.traffic] * m.mul + m.wait
    : (km / m.speed) * 60;
  return { km, min, cost: km * (m.cost || 0), co2: km * m.co2, kcal: km * (m.kcal || 0) };
}

function departDate() {
  const v = $('#depart').value;
  return v ? new Date(v) : new Date();
}
const fmtClock = d => d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

const WMO = c =>
  c === 0 ? ['☀️', 'Clear sky'] : c <= 3 ? ['⛅', 'Partly cloudy'] : c <= 48 ? ['🌫️', 'Fog'] :
  c <= 57 ? ['🌦️', 'Drizzle'] : c <= 67 ? ['🌧️', 'Rain'] : c <= 77 ? ['❄️', 'Snow'] :
  c <= 82 ? ['🌧️', 'Rain showers'] : c <= 86 ? ['❄️', 'Snow showers'] : ['⛈️', 'Thunderstorm'];

function weatherIsBad() {
  const w = state.weather;
  return !!w && (w.rain > 0.2 || w.code >= 51 || w.wind > 35 || w.temp > 37 || w.temp < 3);
}

function advise() {
  const rows = Object.keys(MODES).map(k => ({ k, ...metrics(k) })).filter(r => r.min != null && !isNaN(r.min));
  if (!rows.length) return null;
  const km = rows[0].km;
  const W = {
    fast:     { t: .70, c: .10, e: .10, h: .10 },
    cheap:    { t: .20, c: .60, e: .10, h: .10 },
    green:    { t: .15, c: .10, e: .60, h: .15 },
    health:   { t: .15, c: .10, e: .15, h: .60 },
    balanced: { t: .35, c: .25, e: .20, h: .20 }
  }[state.priority];
  const norm = (key, v) => {
    const a = rows.map(r => r[key]), mn = Math.min(...a), mx = Math.max(...a);
    return mx === mn ? 0 : (v - mn) / (mx - mn);
  };
  const bad = weatherIsBad();
  rows.forEach(r => {
    r.score = W.t * norm('min', r.min) + W.c * norm('cost', r.cost) + W.e * norm('co2', r.co2) + W.h * (1 - norm('kcal', r.kcal));
    if (r.k === 'walk') r.score += km > 10 ? 1 : km > 5 ? 0.3 : 0;
    if (r.k === 'bike') r.score += km > 50 ? 1 : km > 25 ? 0.5 : 0;
    if (bad && ['walk', 'bike', 'moto'].includes(r.k)) r.score += 0.25;
  });
  rows.sort((a, b) => a.score - b.score);
  const best = rows[0], fastest = [...rows].sort((a, b) => a.min - b.min)[0];
  const car = rows.find(r => r.k === 'car');
  const lo = rows[0].score, hi = rows[rows.length - 1].score;
  rows.forEach(r => (r.match = Math.round(100 - ((r.score - lo) / (hi - lo || 1)) * 70)));

  const L_ = r => `${MODES[r.k].icon} ${MODES[r.k].label}`;
  const reasons = [];
  reasons.push(`${L_(fastest)} is the quickest at ${fmtTime(fastest.min)}.`);
  if (best.k !== fastest.k) {
    reasons.push(`${L_(best)} is recommended for your "${$('#priority').selectedOptions[0].text}" priority. It takes ${fmtTime(best.min - fastest.min)} longer than the fastest option.`);
  }
  if (car && best.co2 < car.co2) reasons.push(`Saves about ${(car.co2 - best.co2).toFixed(1)} kg of CO₂ compared with driving.`);
  if (best.kcal > 0) reasons.push(`Burns roughly ${Math.round(best.kcal)} kcal on the way.`);
  if (state.weather && bad) reasons.push(`Weather at the destination is ${WMO(state.weather.code)[1].toLowerCase()} at ${Math.round(state.weather.temp)}°C, so outdoor options were scored lower.`);
  const d = departDate(), h = d.getHours(), wk = d.getDay() % 6 !== 0;
  if (wk && ((h >= 7 && h < 10) || (h >= 16 && h < 19)) && state.traffic !== 'heavy') reasons.push('Your departure falls in rush hour. Switch Traffic to "Heavy" for a more cautious estimate.');
  if (km > 300) reasons.push('Long distance: plan a break every 2 hours. Rail or air may beat road travel here (not modelled).');
  if (state.estimated) reasons.push('Routing server unreachable, so these are rough straight-line estimates.');
  return { best, fastest, rows, reasons };
}

/* ---------- 7. RENDERING RESULTS ---------- */
function renderResults() {
  renderModes(); renderSummary(); refreshInsights(); renderSteps(); renderWeather();
}

function refreshInsights() {
  state.advice = advise();
  renderAdvisor();
  renderCompare();
}

function renderModes() {
  const box = $('#modes');
  box.innerHTML = '';
  Object.keys(MODES).forEach(k => {
    const m = metrics(k);
    box.append(el('button', {
      className: 'mode', type: 'button', title: MODES[k].label,
      onclick: () => { state.mode = k; drawRoute(true); renderModes(); renderSummary(); renderSteps(); renderCompare(); }
    }, el('span', { className: 'ic', textContent: MODES[k].icon }), el('span', { className: 't', textContent: m ? fmtTime(m.min) : '–' })));
    box.lastChild.setAttribute('aria-pressed', String(k === state.mode));
  });
}

function renderSummary() {
  const k = state.mode, m = metrics(k);
  if (!m) return;
  const pts = filled();
  const straight = pts.slice(1).reduce((s, p, i) => s + haversine(pts[i], p), 0);
  const arrive = new Date(departDate().getTime() + m.min * 60000);
  $('#sign').innerHTML = `
    <div><span class="lbl">${MODES[k].icon} ${MODES[k].label} · road distance</span><span class="big">${fmtDist(m.km).split(' ')[0]}</span><span class="unit">${fmtDist(m.km).split(' ')[1]}</span></div>
    <div class="right"><span class="lbl">travel time</span><span class="big">${fmtTime(m.min)}</span></div>`;
  const box = $('#summary');
  box.innerHTML = '';
  const stat = (a, b) => el('div', { className: 'stat' }, el('span', { textContent: a }), el('b', { textContent: b }));
  box.append(
    stat('Straight line', fmtDist(straight)),
    stat('Arrive', fmtClock(arrive)),
    stat('Detour', `${Math.max(0, Math.round((m.km / straight - 1) * 100))}% longer`),
    stat('Cost (est.)', fmtMoney(m.cost)),
    stat('CO₂', m.co2 ? `${m.co2.toFixed(1)} kg` : 'None'),
    stat('Calories', m.kcal ? `${Math.round(m.kcal)} kcal` : '–')
  );
  const r = state.routes[MODES[k].profile];
  if (pts.length > 2 && r) {
    box.append(el('div', { className: 'legs', textContent: r.legs.map((l, i) => `${letter(i)}→${letter(i + 1)} ${fmtDist(l.distance / 1000)}`).join('  ·  ') }));
  }
}

function renderAdvisor() {
  const a = state.advice, box = $('#advisor');
  if (!a) { box.textContent = ''; return; }
  const b = a.best;
  box.innerHTML = '';
  box.append(
    el('div', { className: 'best' },
      el('strong', { textContent: `${MODES[b.k].icon} Best choice: ${MODES[b.k].label}` }),
      el('span', { textContent: `${fmtTime(b.min)} · ${fmtDist(b.km)} · ${fmtMoney(b.cost)}` })),
    el('ul', { className: 'reasons' }, a.reasons.map(t => el('li', { textContent: t })))
  );
}

function renderCompare() {
  const a = state.advice, box = $('#compare');
  if (!a) return;
  const maxT = Math.max(...a.rows.map(r => r.min));
  const order = Object.keys(MODES);
  const rows = [...a.rows].sort((x, y) => order.indexOf(x.k) - order.indexOf(y.k));
  const table = el('table', { className: 'cmp' },
    el('tr', {}, ['Travel by', 'Time', 'Cost', 'CO₂', 'Match'].map(h => el('th', { textContent: h }))),
    rows.map(r => {
      const tr = el('tr', { className: (r.k === state.mode ? 'sel ' : '') + (r.k === a.best.k ? 'pick' : ''), onclick: () => { state.mode = r.k; drawRoute(true); renderModes(); renderSummary(); renderSteps(); renderCompare(); } },
        el('td', {}, `${MODES[r.k].icon} ${MODES[r.k].label}`, r.k === a.best.k ? el('span', { className: 'tag', textContent: 'AI pick' }) : null),
        el('td', {}, fmtTime(r.min), el('div', { className: 'bar' }, el('i', { style: `width:${Math.max(4, (r.min / maxT) * 100)}%` }))),
        el('td', { textContent: fmtMoney(r.cost) }),
        el('td', { textContent: r.co2 ? r.co2.toFixed(1) + ' kg' : '–' }),
        el('td', { textContent: r.match + '%' }));
      return tr;
    })
  );
  box.innerHTML = '';
  box.append(table);
}

const ARROWS = { left: '↰', right: '↱', 'sharp left': '↰', 'sharp right': '↱', 'slight left': '↖', 'slight right': '↗', straight: '↑', uturn: '⮌' };
function stepText(s) {
  const t = s.maneuver.type, mod = s.maneuver.modifier || '', road = s.name ? ` onto ${s.name}` : '';
  if (t === 'depart') return `Start${road}`;
  if (t === 'arrive') return 'Arrive at your stop';
  if (t === 'roundabout' || t === 'rotary') return `Take the roundabout${road}`;
  if (t === 'turn' || t === 'end of road' || t === 'fork' || t === 'on ramp' || t === 'off ramp') return `Turn ${mod}${road}`.replace('  ', ' ');
  return `Continue ${mod}${road}`.replace('  ', ' ');
}
function renderSteps() {
  const r = state.routes[MODES[state.mode].profile], ol = $('#steps');
  ol.innerHTML = '';
  if (!r || !r.steps.length) { ol.append(el('li', { textContent: 'Directions are not available for estimated routes.' })); return; }
  r.steps.forEach(s => ol.append(el('li', {},
    el('span', { textContent: ARROWS[s.maneuver.modifier] || '•' }),
    el('span', { textContent: stepText(s) }),
    el('small', { textContent: fmtDist(s.distance / 1000) }))));
}

/* ---------- 8. WEATHER ---------- */
async function loadWeather(p) {
  try {
    const u = `${CONFIG.weather}?latitude=${p.lat}&longitude=${p.lng}&current=temperature_2m,precipitation,weather_code,wind_speed_10m`;
    const j = await (await fetch(u)).json();
    const c = j.current;
    state.weather = { temp: c.temperature_2m, rain: c.precipitation, code: c.weather_code, wind: c.wind_speed_10m };
  } catch { state.weather = null; }
  renderWeather();
  if (state.routes.car) refreshInsights();
}
function renderWeather() {
  const w = state.weather, box = $('#weather');
  if (!w) { box.textContent = 'Weather unavailable right now.'; return; }
  const [ic, txt] = WMO(w.code);
  box.innerHTML = '';
  box.append(el('span', { className: 'w-ic', textContent: ic }),
    el('div', {}, el('b', { textContent: `${Math.round(w.temp)}°C` }), el('div', { textContent: `${txt} · wind ${Math.round(w.wind)} km/h · rain ${w.rain} mm` })));
}

/* ---------- 9. NEARBY PLACES (Overpass) ---------- */
function buildNearby() {
  const box = $('#nearbyChips');
  NEARBY.forEach(([label, filter]) => {
    const b = el('button', { type: 'button', textContent: label });
    b.onclick = () => findNearby(label, filter, b);
    box.append(b);
  });
}
async function findNearby(label, filter, btn) {
  const pts = filled();
  const which = $('#nearbyNear').value;
  const c = which === 'center' ? map.getCenter() : which === 'start' ? pts[0] : pts[pts.length - 1];
  if (!c) return toast('Set a route first, or choose "Near map centre"');
  const lat = c.lat, lng = c.lng ?? c.lng;
  $$('#nearbyChips button').forEach(x => x.classList.remove('on'));
  btn.classList.add('on');
  $('#nearbyInfo').textContent = 'Searching…';
  nearbyLayer.clearLayers();
  const q = `[out:json][timeout:20];nwr(around:2000,${lat},${lng})${filter};out center 30;`;
  try {
    const j = await (await fetch(`${CONFIG.overpass}?data=${encodeURIComponent(q)}`)).json();
    let n = 0;
    j.elements.forEach(e => {
      const la = e.lat ?? e.center?.lat, lo = e.lon ?? e.center?.lon;
      if (la == null) return;
      n++;
      const name = e.tags?.name || label.replace(/^\S+\s/, '');
      L.circleMarker([la, lo], { radius: 8, color: '#fff', weight: 2, fillColor: '#f59e0b', fillOpacity: 1 })
        .bindPopup(`<b>${name}</b><br>${(haversine({ lat, lng }, { lat: la, lng: lo })).toFixed(2)} km away`).addTo(nearbyLayer);
    });
    $('#nearbyInfo').textContent = n ? `${n} places within 2 km. Click a dot for details.` : 'Nothing found within 2 km.';
  } catch { $('#nearbyInfo').textContent = 'Could not load places. Try again in a moment.'; }
}

/* ---------- 10. EXTRAS: simulate, share, GPX, history, geolocation ---------- */
function stopSim() { clearInterval(state.simTimer); state.simTimer = null; if (state.simDot) { state.simDot.remove(); state.simDot = null; } }
function simulate() {
  const r = state.routes[MODES[state.mode].profile];
  if (!r) return;
  stopSim();
  const c = r.coords, step = Math.max(1, Math.floor(c.length / 250));
  let i = 0;
  state.simDot = L.circleMarker([c[0][1], c[0][0]], { radius: 10, color: '#fff', weight: 3, fillColor: MODES[state.mode].color, fillOpacity: 1 }).addTo(map);
  map.fitBounds(L.latLngBounds(c.map(([lng, lat]) => [lat, lng])), { padding: [60, 60] });
  state.simTimer = setInterval(() => {
    i += step;
    if (i >= c.length) { stopSim(); toast('You have arrived'); return; }
    state.simDot.setLatLng([c[i][1], c[i][0]]);
  }, 30);
}

function shareLink() {
  const pts = filled();
  if (pts.length < 2) return toast('Create a route first');
  const url = location.href.split('#')[0] + '#r=' + pts.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(';');
  navigator.clipboard.writeText(url).then(() => toast('Link copied')).catch(() => prompt('Copy this link', url));
}

function exportGPX() {
  const r = state.routes[MODES[state.mode].profile];
  if (!r) return;
  const pts = r.coords.map(([lng, lat]) => `<trkpt lat="${lat}" lon="${lng}"></trkpt>`).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="RoadRanger AI" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>RoadRanger route</name><trkseg>\n${pts}\n</trkseg></trk></gpx>`;
  const a = el('a', { href: URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' })), download: 'roadranger-route.gpx' });
  a.click();
  URL.revokeObjectURL(a.href);
}

function saveHistory(pts) {
  const h = JSON.parse(localStorage.getItem('rr_history') || '[]');
  const key = pts.map(p => p.lat.toFixed(4) + p.lng.toFixed(4)).join('|');
  const km = state.routes.car.distance / 1000;
  const entry = { key, stops: pts, km, time: Date.now() };
  const next = [entry, ...h.filter(x => x.key !== key)].slice(0, 8);
  localStorage.setItem('rr_history', JSON.stringify(next));
  renderHistory();
}
function renderHistory() {
  const ul = $('#history'), h = JSON.parse(localStorage.getItem('rr_history') || '[]');
  ul.innerHTML = '';
  if (!h.length) { ul.append(el('li', { textContent: 'Routes you plan will appear here.' })); return; }
  h.forEach(e => ul.append(el('li', {
    onclick: () => { state.stops = e.stops.map(p => ({ ...p })); renderStops(); drawMarkers(); route(); }
  }, `${e.stops[0].name.split(',')[0]} → ${e.stops[e.stops.length - 1].name.split(',')[0]}`,
     el('small', { textContent: `${fmtDist(e.km)} by road · ${new Date(e.time).toLocaleDateString()}` }))));
}

function locate() {
  if (!navigator.geolocation) return toast('Location is not supported in this browser');
  toast('Finding your location…');
  navigator.geolocation.getCurrentPosition(pos => {
    const i = state.stops[0] ? state.stops.findIndex(s => !s) : 0;
    const idx = i === -1 ? 0 : i;
    const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, name: 'My location' };
    setStop(idx, p);
    map.flyTo([p.lat, p.lng], 14);
  }, () => toast('Location blocked. Allow it in your browser settings.'), { enableHighAccuracy: true, timeout: 10000 });
}

async function loadFromHash() {
  const m = location.hash.match(/^#r=(.+)$/);
  if (!m) return;
  const pts = m[1].split(';').map(s => s.split(',').map(Number)).filter(a => a.length === 2 && a.every(isFinite));
  if (pts.length < 2) return;
  state.stops = pts.slice(0, MAX_STOPS).map(([lat, lng]) => ({ lat, lng, name: `${lat.toFixed(5)}, ${lng.toFixed(5)}` }));
  renderStops(); drawMarkers(); scheduleRoute();
  for (const p of state.stops) { await reverseName(p); await sleep(1100); }  // be polite to Nominatim
}

/* ---------- 11. OPTIONAL: ASK CLAUDE ---------- */
function routeContext() {
  const modes = {};
  Object.keys(MODES).forEach(k => {
    const m = metrics(k);
    if (m) modes[MODES[k].label] = { distance_km: +m.km.toFixed(1), minutes: Math.round(m.min), cost: +m.cost.toFixed(2), co2_kg: +m.co2.toFixed(2), kcal: Math.round(m.kcal) };
  });
  return {
    stops: filled().map(p => p.name), traffic: state.traffic, priority: state.priority,
    departure: $('#depart').value || 'now', weather_at_destination: state.weather, modes,
    local_recommendation: state.advice ? MODES[state.advice.best.k].label : null
  };
}
async function askAI() {
  const key = $('#apiKey').value.trim(), out = $('#aiOut');
  if (!key) return toast('Paste your Anthropic API key first');
  if (!state.advice) return toast('Create a route first');
  if ($('#rememberKey').checked) localStorage.setItem('rr_key', key); else localStorage.removeItem('rr_key');
  out.textContent = 'Thinking…';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: CONFIG.claudeModel, max_tokens: 700,
        system: 'You are RoadRanger AI, a concise travel-planning assistant. Use only the route data provided. Give a clear recommendation, be honest about uncertainty (traffic, weather), and keep answers under 180 words.',
        messages: [{ role: 'user', content: `Route data (JSON):\n${JSON.stringify(routeContext())}\n\nQuestion: ${$('#aiQ').value}` }]
      })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || r.status);
    out.textContent = j.content.map(c => c.text || '').join('');
  } catch (e) { out.textContent = 'Could not reach Claude: ' + e.message; }
}

/* ---------- 12. WIRING ---------- */
function nowLocal() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
function rerender() { if (state.routes.car) { renderModes(); renderSummary(); refreshInsights(); } }

$('#addStop').onclick = () => {
  if (state.stops.length >= MAX_STOPS) return toast(`Maximum ${MAX_STOPS} stops`);
  state.stops.splice(state.stops.length - 1, 0, null);
  renderStops();
};
$('#swap').onclick = () => { state.stops.reverse(); renderStops(); drawMarkers(); scheduleRoute(); };
$('#locate').onclick = locate;
$('#clear').onclick = () => { state.stops = [null, null]; renderStops(); drawMarkers(); clearRoute(); nearbyLayer.clearLayers(); stopSim(); };
$('#now').onclick = () => { $('#depart').value = nowLocal(); rerender(); };
$('#depart').onchange = rerender;
$('#traffic').onchange = e => { state.traffic = e.target.value; rerender(); };
$('#priority').onchange = e => { state.priority = e.target.value; rerender(); };
$('#btnUnits').onclick = e => { state.units = state.units === 'km' ? 'mi' : 'km'; e.target.textContent = state.units; rerender(); renderSteps(); renderHistory(); };
$('#btnTheme').onclick = () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  localStorage.setItem('rr_theme', dark ? 'dark' : 'light');
};
$('#btnPresent').onclick = () => {
  const on = document.body.classList.toggle('present');
  $('#btnPresent').textContent = on ? 'Exit' : 'Present';
  if (on && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  if (!on && document.fullscreenElement) document.exitFullscreen();
  setTimeout(() => map.invalidateSize(), 300);
};
$('#btnSim').onclick = simulate;
$('#btnShare').onclick = shareLink;
$('#btnGpx').onclick = exportGPX;
$('#aiGo').onclick = askAI;

$('#depart').value = nowLocal();
document.documentElement.dataset.theme = localStorage.getItem('rr_theme') || 'light';
const savedKey = localStorage.getItem('rr_key');
if (savedKey) { $('#apiKey').value = savedKey; $('#rememberKey').checked = true; }
renderStops();
buildNearby();
renderHistory();
loadFromHash();
