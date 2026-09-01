/* homestead-pool-card — a "Swimming Conditions" news article for a newsprint Home Assistant
 * dashboard: a woodcut plate of the pool (day / night / storm) carrying the water temperature
 * on a pasted tag, a verdict headline and drop-cap lede, a hatched 14-day high–low chart from
 * recorder history, a five-cell strip and the lifeguard's "Bathing notices". Read-only: tap →
 * more-info. Companion to almanac-weather-card / network-ledger-card / homestead-classifieds-card
 * / homestead-waterworks-card. */
const HPC_VERSION = "2026.9.1";
const INK = "#3a2d1f", PAPER = "#f3e7d3", TAN = "#a3876a", BROWN = "#7a6248",
  TERRA = "#c65f38", BLUE = "#5f7e94", DOT = "#cfb894", GREEN = "#2f7f6f";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STORMY = new Set(["lightning", "lightning-rainy", "pouring", "rainy", "hail", "exceptional"]);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const bad = (s) => s == null || s === "" || s === "unknown" || s === "unavailable";
const num = (s) => { const v = parseFloat(s); return isNaN(v) ? null : v; };
const r0 = (v) => (v == null ? null : Math.round(v));
const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const ap = (h) => (h >= 12 ? "PM" : "AM");
const hh = (h) => h % 12 || 12;
const clock = (d) => (d ? `${hh(d.getHours())}:${pad2(d.getMinutes())} ${ap(d.getHours())}` : "—");
const hourAt = (d) => `${hh(d.getHours())} ${ap(d.getHours())}`;
const hourRange = (d) => { const h = d.getHours(), h1 = (h + 1) % 24; return ap(h) === ap(h1) ? `${hh(h)}–${hh(h1)} ${ap(h)}` : `${hh(h)} ${ap(h)}–${hh(h1)} ${ap(h1)}`; };
const floorHour = (d) => { const x = new Date(d); x.setMinutes(0, 0, 0); return x; };
const monDay = (day) => { const [y, m, d] = day.split("-").map(Number); return `${MON3[m - 1]} ${d}`; };
const degWord = (n) => (n === 1 ? "a degree" : `${n} degrees`);

class HomesteadPoolCard extends HTMLElement {
  static getStubConfig() { return { water_entity: "sensor.pool_temperature", air_entity: "sensor.weather_station_temperature", weather_entity: "weather.home" }; }

  setConfig(config) {
    if (!config || !config.water_entity) throw new Error("homestead-pool-card: set water_entity (the pool thermometer)");
    const c = Object.assign({
      title: "THE POOL", kicker: "LIFEGUARD ON DUTY: NONE",
      air_entity: "", uv_entity: "", wind_entity: "", gust_entity: "", weather_entity: "", sun_entity: "sun.sun",
      days: 14, air_max: 100, uv_max: 5, storm_hours: 6,
      plate: "", plate_caption: "", plate_number: "II", plate_credit: "Engraving after a photograph", tag_position: "br",
      chores: [], column_rule: false,
      footer: "Readings taken by a float in the deep end every five minutes, by way of a cloud in another state. No lifeguard was consulted.",
    }, config);
    const pl = {};
    for (const k of ["day", "night", "storm"]) { const p = (config.plates || {})[k]; if (p) pl[k] = typeof p === "string" ? { src: p, caption: "" } : { src: p.src || "", caption: p.caption || "" }; }
    if (!pl.day && c.plate) pl.day = { src: c.plate, caption: c.plate_caption || "" };
    c.plates = pl;
    this._cfg = c;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._sig = null; this._hist = null; this._histAt = 0; this._histDay = ""; this._last = null; this._dayAgo = null; this._fc = null;
    this._dropSub();
    if (this._fontsReady === undefined) {
      const fonts = typeof document !== "undefined" && document.fonts;
      this._fontsReady = !fonts;
      if (fonts) Promise.race([fonts.ready, new Promise((r) => setTimeout(r, 3000))]).then(() => { this._fontsReady = true; this._sig = null; this._render(); });
    }
    this._render();
  }
  set hass(hass) { this._hass = hass; this._maybeFetchHistory(); this._maybeSubscribe(); this._render(); }
  getCardSize() { return 9; }
  connectedCallback() { this._tick = setInterval(() => this._render(), 60000); this._maybeSubscribe(); }
  disconnectedCallback() { clearInterval(this._tick); this._dropSub(); }

  // ---------- data ----------
  _st(id) { const s = id && this._hass && this._hass.states[id]; return s && !bad(s.state) ? s : null; }
  _val(id) { const s = this._st(id); return s ? num(s.state) : null; }
  _dropSub() { if (this._unsub) { try { this._unsub(); } catch (e) { /* gone */ } } this._unsub = null; this._subKey = null; }
  _maybeSubscribe() {
    const ent = this._cfg && this._cfg.weather_entity, conn = this._hass && this._hass.connection;
    if (!ent || !conn || !conn.subscribeMessage || this._subKey === ent) return;
    this._subKey = ent;
    try {
      conn.subscribeMessage((m) => { this._fc = (m && m.forecast) || []; this._sig = null; this._render(); },
        { type: "weather/subscribe_forecast", entity_id: ent, forecast_type: "hourly" })
        .then((u) => { this._unsub = u; }).catch(() => { this._subKey = null; });
    } catch (e) { this._subKey = null; }
  }
  async _maybeFetchHistory() {
    const day = ymd(new Date());
    if (this._fetching || !this._hass || !this._hass.callWS || (Date.now() - this._histAt < 30 * 60000 && this._histDay === day)) return;
    this._fetching = true;
    try {
      const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - this._cfg.days);
      const r = await this._hass.callWS({ type: "history/history_during_period", start_time: start.toISOString(), entity_ids: [this._cfg.water_entity], minimal_response: true, no_attributes: true, significant_changes_only: false });
      const rows = (r && r[this._cfg.water_entity]) || [];
      const byDay = new Map(); let last = null, dayAgo = null; const cut = Date.now() / 1000 - 86400;
      for (const x of rows) {
        const v = num(x.s); if (v == null || x.lu == null) continue;
        const t = new Date(x.lu * 1000), k = ymd(t);
        const b = byDay.get(k) || { day: k, hi: -Infinity, lo: Infinity, sum: 0, n: 0 };
        b.hi = Math.max(b.hi, v); b.lo = Math.min(b.lo, v); b.sum += v; b.n++; byDay.set(k, b);
        last = { v, t }; if (x.lu <= cut) dayAgo = v;
      }
      this._hist = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map((b) => ({ day: b.day, hi: b.hi, lo: b.lo, mean: b.sum / b.n }));
      this._last = last; this._dayAgo = dayAgo;
      this._histAt = Date.now(); this._histDay = day; this._sig = null; this._render();
    } catch (e) { /* keep the last rows */ }
    finally { this._fetching = false; }
  }
  _water() {
    const s = this._st(this._cfg.water_entity);
    if (s) return { v: num(s.state), stale: false, at: new Date(s.last_updated || Date.now()) };
    if (this._last) return { v: this._last.v, stale: true, at: this._last.t };
    return { v: null, stale: false, at: null };
  }
  _sun() {
    const s = this._st(this._cfg.sun_entity);
    if (!s) return { up: true, set: null, rise: null, known: false };
    const a = s.attributes || {};
    return { up: s.state !== "below_horizon", set: a.next_setting ? new Date(a.next_setting) : null, rise: a.next_rising ? new Date(a.next_rising) : null, known: true };
  }
  _hours() {
    return (this._fc || []).map((h) => ({ t: new Date(h.datetime), temp: num(h.temperature), uv: num(h.uv_index), pop: num(h.precipitation_probability) || 0, cond: h.condition })).filter((h) => !isNaN(h.t));
  }
  _series() {
    const today = ymd(new Date()), hist = this._hist || [];
    const past = hist.filter((x) => x.day !== today).slice(-this._cfg.days);
    const cur = hist.find((x) => x.day === today) || null;
    const avg = past.length ? past.reduce((a, x) => a + x.mean, 0) / past.length : null;
    return { past, cur, avg };
  }

  // ---------- copy ----------
  _verdict(w) {
    if (w == null) return null;
    if (w < 70) return { key: "closed", adj: "cold", head: "No swimming", tag: "CLOSED BY COLD", short: "CLOSED BY COLD" };
    if (w < 76) return { key: "bracing", adj: "bracing", head: "Bracing swimming", tag: "BRACING · IF YOU MUST", short: "BRACING" };
    if (w < 80) return { key: "brisk", adj: "brisk", head: "Brisk swimming", tag: "BRISK · SWIM ON", short: "BRISK" };
    if (w < 86) return { key: "fine", adj: "fine", head: "Fine swimming", tag: "FINE · SWIM ON", short: "FINE" };
    if (w < 90) return { key: "warm", adj: "warm", head: "Warm swimming", tag: "WARM · SWIM ON", short: "WARM" };
    return { key: "bathwater", adj: "bathwater", head: "Bathwater", tag: "BATHWATER · SWIM ANYWAY", short: "BATHWATER" };
  }
  _sunClause(uv, up) {
    if (!up) return "and the sun has clocked out";
    if (uv == null) return "and the sun is out";
    if (uv >= 8) return "and the sun is not on your side";
    if (uv >= 6) return "and the sun means business";
    if (uv >= 3) return "and the sun is reasonable";
    return "and the sun is barely trying";
  }
  _headline(w, a, uv, sun) {
    const v = this._verdict(w);
    if (!v) return "No reading from the deep end";
    const air = a == null ? "" : `, air ${r0(a)}`;
    if (v.key === "closed") return `No swimming at the deep end: water ${r0(w)}${air}, and nobody is going in`;
    return `${v.head} at the deep end: water ${r0(w)}${air}, ${this._sunClause(uv, sun.up)}`;
  }
  _burn(uv, up) {
    if (!up) return { row: "None · sun clocked out", lede: "The sun has clocked out, so burning is off the table", due: false };
    if (uv == null) return { row: "—", lede: "Burn times are unfiled", due: false };
    const u = Math.round(uv);
    if (u < 1) return { row: "None · UV 0", lede: "Burning is off the table at UV 0", due: false };
    if (u < 3) return { row: `An hour or more · UV ${u}`, lede: "Burning takes an hour or more at this hour", due: false };
    if (u < 6) return { row: `45 min · UV ${u}`, lede: "Burning takes about 45 minutes at this hour", due: false };
    if (u < 8) return { row: `30 min · UV ${u}`, lede: "Burning takes about half an hour at this hour", due: false };
    if (u < 11) return { row: `15–20 min · UV ${u}`, lede: "Burning takes about a quarter of an hour at this hour", due: true };
    return { row: `10 min · UV ${u}`, lede: "Burning takes about ten minutes at this hour", due: true };
  }
  _best(sun, now) {
    const c = this._cfg, hours = this._hours();
    if (!hours.length) return { row: "No forecast filed", lede: "nothing, having no forecast to go on", ok: false };
    const h0 = floorHour(now);
    const fine = (h) => (h.uv == null || h.uv <= c.uv_max) && (h.temp == null || h.temp <= c.air_max) && h.pop < 40 && !STORMY.has(h.cond);
    const score = (h) => (h.uv || 0) * 2 + Math.max(0, (h.temp || 0) - 90) / 2;
    const pick = (list) => list.filter(fine).reduce((b, h) => (!b || score(h) < score(b) ? h : b), null);
    const isNow = (h) => h.t.getTime() === h0.getTime();
    const desc = (h) => `${h.temp == null ? "" : r0(h.temp) + "°"}${h.uv != null ? (h.temp == null ? "" : ", ") + "UV " + r0(h.uv) : ""}`;
    if (sun.up && sun.set) {
      const b = pick(hours.filter((h) => h.t >= h0 && h.t <= sun.set));
      if (b) return { row: `${isNow(b) ? "Now" : hourRange(b.t)} · ${desc(b)}`, lede: isNow(b) ? "now, before the sun changes its mind" : `the hour after ${hh(b.t.getHours())}, ${desc(b)}`, ok: true };
      const after = hours.find((h) => h.t > sun.set && h.temp != null);
      return after ? { row: `After dark · ${r0(after.temp)}° at ${hourAt(after.t)}`, lede: `waiting for dark, when the air drops to ${r0(after.temp)}`, ok: false }
        : { row: "After dark", lede: "waiting for dark", ok: false };
    }
    const rise = sun.rise;
    const night = hours.filter((h) => h.t >= h0 && (!rise || h.t < rise)).filter((h) => h.temp == null || h.temp <= c.air_max);
    if (night.length) { const b = night[0]; return { row: `${isNow(b) ? "Now" : hourRange(b.t)} · ${b.temp == null ? "" : r0(b.temp) + "°, "}after dark`, lede: isNow(b) ? "now, under no sun at all" : `${hourRange(b.t).toLowerCase()}, after dark`, ok: true }; }
    if (rise) {
      const b = pick(hours.filter((h) => h.t >= rise && h.t <= new Date(rise.getTime() + 6 * 3600000)));
      const when = ymd(rise) === ymd(now) ? "This morning" : "Tomorrow";
      if (b) return { row: `${when}, ${hourRange(b.t)} · ${desc(b)}`, lede: `${when.toLowerCase()}'s ${hourRange(b.t)} hour`, ok: true };
    }
    return { row: "Nothing before noon suits", lede: "waiting for a better hour", ok: false };
  }
  _vsAir(w, a, now) {
    if (w == null || a == null) return null;
    const d = r0(w - a);
    if (d === 0) return { lede: "level with the air", row: "Level with the air" };
    const warmer = d > 0;
    const lede = `${degWord(Math.abs(d))} ${warmer ? "warmer" : "cooler"} than the air`;
    const hours = this._hours().filter((h) => h.t >= floorHour(now) && h.t <= new Date(now.getTime() + 24 * 3600000) && h.temp != null);
    if (!hours.length) return { lede, row: warmer ? "Warmer than the air" : "Cooler than the air" };
    const wr = r0(w), flip = hours.find((h) => (warmer ? r0(h.temp) > wr : r0(h.temp) < wr));
    if (!flip) return { lede, row: warmer ? "Warmer than the air all day and night" : "Cooler than the air through tomorrow" };
    return { lede, row: warmer ? `Warmer than the air until ${hourAt(flip.t)}` : `Warmer than the air after ${hourAt(flip.t)}` };
  }
  _chop(gust, wind) {
    const g = gust != null ? gust : wind;
    if (g == null) return { row: "—", due: false };
    const n = r0(g);
    if (n < 8) return { row: "Flat calm", due: false };
    if (n < 15) return { row: `Light · gusts to ${n} mph`, due: false };
    if (n < 25) return { row: `Choppy · gusts to ${n} mph`, due: false };
    return { row: `Whitecaps in the shallow end · gusts to ${n} mph`, due: true };
  }
  _upkeep(now) {
    let best = null;
    for (const ch of this._cfg.chores || []) {
      const s = this._st(ch.entity); if (!s) continue;
      const a = s.attributes || {};
      let days = num(a.days_until_due);
      if (days == null && a.next_due) { const d = new Date(a.next_due + "T00:00:00"); days = Math.round((d - new Date(ymd(now) + "T00:00:00")) / 86400000); }
      if (days == null) continue;
      const item = { name: ch.name || ch.entity, entity: ch.entity, days, due: s.state === "due_soon" || s.state === "overdue" || days <= 0, next: a.next_due };
      if (!best || item.days < best.days) best = item;
    }
    if (!best) return null;
    const d = best.days, dow = best.next ? new Date(best.next + "T00:00:00").getDay() : null;
    const when = d < 0 ? `overdue ${-d} day${-d === 1 ? "" : "s"}` : d === 0 ? "due today" : d === 1 ? "due tomorrow" : `due ${dow != null ? DAY3[dow] : "in " + d + " days"}${dow != null ? ` (${d} days)` : ""}`;
    const owed = d < 0 ? "already" : d === 0 ? "today" : d === 1 ? "by tomorrow" : dow != null ? `by ${DAYS[dow]}` : `in ${d} days`;
    return Object.assign(best, { row: `${best.name} · ${when}`, lede: best.due ? `The ${best.name.toLowerCase()} is owed ${owed}. ` : "" });
  }
  _plateMode(sun, now) {
    const c = this._cfg, cur = this._st(c.weather_entity);
    let storm = !!cur && STORMY.has(cur.state);
    if (!storm) { const until = now.getTime() + c.storm_hours * 3600000, from = now.getTime() - 3600000; storm = this._hours().some((h) => h.t >= from && h.t <= until && (STORMY.has(h.cond) || h.pop >= 50)); }
    const mode = storm ? "storm" : !sun.up ? "night" : "day";
    return { mode, plate: c.plates[mode] || c.plates.day || null };
  }

  // ---------- render ----------
  _render() {
    if (!this._cfg || !this._hass) return;
    const loaded = !!this._fontsReady && this._hist !== null;
    const reserve = loaded ? 0 : this._reserve();
    this.style.minHeight = reserve ? reserve + "px" : "";
    let out;
    try { out = this._article(); }
    catch (e) { out = { sig: "err:" + e.message, html: `<div style="padding:12px;color:#b00;font-family:sans-serif">${esc(e.message)}</div>` }; }
    if (out.sig === this._sig) return;
    this._sig = out.sig;
    this._pin();
    this.shadowRoot.innerHTML = out.html;
    this.shadowRoot.querySelectorAll("[data-entity]").forEach((el) => el.addEventListener("click", (ev) => { ev.stopPropagation(); this._more(el.dataset.entity); }));
    this._unpin(reserve);
    if (loaded) setTimeout(() => this._remember(), 60);
  }
  _more(id) { if (id) this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: id } })); }

  _article() {
    const c = this._cfg, now = new Date();
    const water = this._water(), w = water.v;
    const a = this._val(c.air_entity), uv = this._val(c.uv_entity), wind = this._val(c.wind_entity), gust = this._val(c.gust_entity);
    const sun = this._sun(), s = this._series(), v = this._verdict(w);
    const burn = this._burn(uv, sun.up), best = this._best(sun, now), vs = this._vsAir(w, a, now), chop = this._chop(gust, wind), up = this._upkeep(now);
    const pm = this._plateMode(sun, now);

    // headline / dek / lede
    const head = this._headline(w, a, uv, sun);
    const sunTxt = sun.up ? `sunset ${clock(sun.set)}` : `sunrise ${clock(sun.rise)}`;
    const dek = `Water ${w == null ? "—" : r0(w) + "°"} · air ${a == null ? "—" : r0(a) + "°"} · UV ${uv == null ? "—" : r0(uv)} at press time · wind ${wind == null ? "—" : r0(wind)} mph · ${sunTxt}${water.stale ? ` · water as of ${clock(water.at)}` : ""}`;
    let lede;
    if (w == null) lede = "The deep end filed no reading by press time. Our correspondent, a float, is presumed adrift.";
    else {
      const dy = this._dayAgo == null ? null : r0(w - this._dayAgo);
      const vsY = dy == null ? "" : dy === 0 ? ", level with this time yesterday" : `, ${degWord(Math.abs(dy))} ${dy > 0 ? "over" : "under"} this time yesterday`;
      lede = `The deep end reported a ${v.adj} ${DAYS[now.getDay()]}: ${r0(w)} degrees by press time${vsY}${vs ? (vsY ? " and " : ", ") + vs.lede : ""}. `;
      lede += `${burn.lede}; the paper recommends ${best.lede}. `;
      if (up && up.lede) lede += up.lede;
      lede += "Our correspondent, a float, reports no witnesses.";
    }

    // plate
    let plate = "";
    if (pm.plate && pm.plate.src) {
      const pos = ["br", "bl", "tr", "tl"].includes(c.tag_position) ? c.tag_position : "br";
      const tl = !v ? "NO READING" : pm.mode === "night" ? `${v.short} · AFTER DARK` : pm.mode === "storm" ? `${v.short} · STORM DUE` : v.tag;
      plate = `<div class="fig" data-entity="${esc(c.water_entity)}"><img src="${esc(pm.plate.src)}" alt=""><div class="tag ${pos}"><div class="tv">${w == null ? "—" : r0(w) + "°"}</div><div class="tl">${esc(tl)}</div></div></div>
      <div class="plate"><span><b>PLATE ${esc(c.plate_number)}.</b> <i>${esc(pm.plate.caption || "")}</i></span><span class="r"><i>${esc(c.plate_credit)}</i></span></div>`;
    }

    // chart
    const bars = s.past.map((x) => ({ label: String(parseInt(x.day.slice(8), 10)), hi: x.hi, lo: x.lo, today: false }));
    if (s.cur) bars.push({ label: "TODAY", hi: s.cur.hi, lo: s.cur.lo, today: true });
    let chart = "";
    if (bars.length > 1) {
      const W = 456, H = 112, base = 92.5, top = 6, L = 24, n = bars.length, slot = (W - L - 4) / n, bw = Math.min(22, slot - 8);
      const lo0 = Math.floor(Math.min(...bars.map((b) => b.lo), s.avg == null ? Infinity : s.avg) - 2), hi0 = Math.ceil(Math.max(...bars.map((b) => b.hi), s.avg == null ? -Infinity : s.avg) + 2);
      const y = (t) => base - ((t - lo0) / Math.max(1, hi0 - lo0)) * (base - top);
      let grid = "";
      for (let g = Math.ceil(lo0 / 5) * 5; g <= hi0; g += 5) { const yy = y(g); if (yy < top + 4 || yy > base - 4) continue; grid += `<line x1="${L}" y1="${yy.toFixed(1)}" x2="${W - 4}" y2="${yy.toFixed(1)}" stroke="${DOT}" stroke-width="1" stroke-dasharray="1 3"/><text x="4" y="${(yy + 2.5).toFixed(1)}" font-family="Archivo, sans-serif" font-size="7" font-weight="700" fill="${TAN}">${g}°</text>`; }
      const rects = bars.map((b, i) => { const x = L + i * slot + (slot - bw) / 2, y1 = y(b.hi), h = Math.max(2, y(b.lo) - y1); return `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="url(#${b.today ? "ht" : "hb"})" stroke="${b.today ? TERRA : INK}" stroke-width="1"/>`; }).join("");
      const labels = bars.map((b, i) => `<text x="${(L + i * slot + slot / 2).toFixed(1)}" y="104" text-anchor="middle" font-family="Archivo, sans-serif" font-size="7.5" font-weight="700" fill="${b.today ? TERRA : BROWN}">${b.label}</text>`).join("");
      const avgLine = s.avg != null ? `<line x1="${L}" y1="${y(s.avg).toFixed(1)}" x2="${W - 4}" y2="${y(s.avg).toFixed(1)}" stroke="${BROWN}" stroke-width="1" stroke-dasharray="3 3"/><text x="${W - 4}" y="${(y(s.avg) - 3).toFixed(1)}" text-anchor="end" font-family="Archivo, sans-serif" font-size="7.5" font-weight="700" fill="${BROWN}" letter-spacing="1">AVG</text>` : "";
      chart = `<div class="sub"><span class="subn">${s.past.length} days in the deep end</span><span class="subr">°F · DAILY HIGH–LOW${s.avg != null ? " · AVG " + r0(s.avg) : ""}</span></div>
      <svg class="chart" viewBox="0 0 ${W} ${H}" data-entity="${esc(c.water_entity)}">
        <defs><pattern id="hb" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="${INK}" stroke-width="1.5"/></pattern>
        <pattern id="ht" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="${TERRA}" stroke-width="2.2"/></pattern></defs>
        ${grid}${rects}${avgLine}<line x1="${L}" y1="${base}" x2="${W - 4}" y2="${base}" stroke="${INK}" stroke-width="1"/>${labels}</svg>`;
    }

    // strip
    const strip = `<div class="strip">
      <div class="cell" data-entity="${esc(c.water_entity)}"><div class="cv">${w == null ? "—" : r0(w) + "°"}</div><div class="cl">WATER</div></div>
      <div class="cell" data-entity="${esc(c.air_entity)}"><div class="cv">${a == null ? "—" : r0(a) + "°"}</div><div class="cl">AIR</div></div>
      <div class="cell" data-entity="${esc(c.uv_entity)}"><div class="cv">${uv == null ? "—" : r0(uv)}</div><div class="cl">UV INDEX</div></div>
      <div class="cell" data-entity="${esc(c.wind_entity)}"><div class="cv">${wind == null ? "—" : r0(wind)}</div><div class="cl">WIND · MPH</div></div>
      <div class="cell" data-entity="${esc(c.sun_entity)}"><div class="cv">${clock(sun.up ? sun.set : sun.rise).replace(/ [AP]M$/, "")}</div><div class="cl">${sun.up ? "SUNSET" : "SUNRISE"}</div></div></div>`;

    // notices
    const all = [...s.past, ...(s.cur ? [s.cur] : [])];
    let range = "";
    if (all.length > 1) { const hiD = all.reduce((b, x) => (x.hi > b.hi ? x : b)), lo = Math.min(...all.map((x) => x.lo)); range = `${r0(lo)}°–${r0(hiD.hi)}° · high on ${monDay(hiD.day)}`; }
    const rows = [
      { k: "Burn time, now", v: burn.row, cls: burn.due ? "due" : "", e: c.uv_entity },
      { k: "Best hour today", v: best.row, cls: best.ok ? "ok" : "", e: c.weather_entity },
      vs ? { k: "Water against the air", v: vs.row, cls: "", e: c.air_entity } : null,
      { k: "Chop", v: chop.row, cls: chop.due ? "due" : "", e: c.gust_entity || c.wind_entity },
      range ? { k: "Fortnight's range", v: range, cls: "", e: c.water_entity } : null,
      up ? { k: "Upkeep", v: up.row, cls: up.due ? "due" : "", e: up.entity } : null,
    ].filter(Boolean);
    const notices = `<div class="sub"><span class="subn">Bathing notices</span><span class="subr">FROM THE LIFEGUARD'S DESK, UNOCCUPIED</span></div>
      ${rows.map((r) => `<div class="row" data-entity="${esc(r.e || "")}"><span class="k">${esc(r.k)}</span><span class="v${r.cls ? " " + r.cls : ""}">${esc(r.v)}</span></div>`).join("")}`;

    const body = `<div class="sect"><span>${esc(c.title)}</span><span class="sectr">${esc(c.kicker)}</span></div>
      <h2 class="hed" data-entity="${esc(c.water_entity)}">${esc(head)}</h2>
      <div class="dek">${esc(dek)}</div>
      ${plate}
      <p class="lede">${esc(lede)}</p>
      ${chart}${strip}${notices}
      ${c.footer ? `<div class="foot">${esc(c.footer)}</div>` : ""}`;
    return { sig: body, html: `<style>${this._css()}</style><div class="wrap"><div class="card">${body}</div></div>` };
  }

  // ---------- scroll-jump guards (see homestead-classifieds-card) ----------
  _pin() { try { const h = Math.round(this.getBoundingClientRect().height); if (h > 0) this.style.minHeight = Math.max(h, parseFloat(this.style.minHeight) || 0) + "px"; } catch (e) { /* not in a document */ } }
  _unpin(reserve) { setTimeout(() => { this.style.minHeight = reserve ? reserve + "px" : ""; }, 0); }
  _hkey() { return "hpc-h:" + this._cfg.water_entity; }
  _reserve() { try { const v = parseInt(localStorage.getItem(this._hkey()), 10); return v > 40 ? v : 0; } catch (e) { return 0; } }
  _remember() { try { const h = Math.round(this.getBoundingClientRect().height); if (h > 40) localStorage.setItem(this._hkey(), String(h)); } catch (e) { /* storage unavailable */ } }

  _css() {
    const c = this._cfg;
    return `
  :host { display: block; }
  * { box-sizing: border-box; }
  .wrap { container-type: inline-size; position: relative; }
  .wrap::before { content: ""; position: absolute; top: 0; bottom: 0; left: calc(-1 * var(--almanac-gutter, 16px)); width: 1px; background: ${c.column_rule ? "var(--almanac-column-rule, #2b2118)" : "transparent"}; }
  .card { --px: max(0.5px, 0.1923cqw); background: var(--almanac-paper, ${PAPER}); color: ${INK}; border-radius: var(--ha-card-border-radius, 14px); box-shadow: var(--ha-card-box-shadow, 0 4px 16px rgba(0,0,0,.18)); overflow: hidden; font-family: Archivo, 'Segoe UI', sans-serif; padding: calc(22*var(--px)) calc(32*var(--px)) calc(20*var(--px)); }
  .sect { display: flex; justify-content: space-between; align-items: baseline; font-size: max(8px, calc(10*var(--px))); font-weight: 700; letter-spacing: calc(3*var(--px)); color: ${TAN}; border-bottom: 1.5px solid ${INK}; padding-bottom: calc(5*var(--px)); }
  .sectr { letter-spacing: calc(1*var(--px)); }
  .hed { font-family: Fraunces, Georgia, serif; font-size: max(15px, calc(21*var(--px))); font-weight: 700; line-height: 1.15; margin: calc(12*var(--px)) 0 calc(4*var(--px)); text-wrap: balance; cursor: pointer; }
  .dek { font-family: Fraunces, Georgia, serif; font-style: italic; font-size: max(10px, calc(12.5*var(--px))); color: ${BROWN}; margin-bottom: calc(10*var(--px)); }
  .fig { position: relative; width: 100%; aspect-ratio: 456 / 194; overflow: hidden; cursor: pointer; }
  .fig img { display: block; width: 100%; height: 100%; object-fit: cover; mix-blend-mode: multiply; }
  .tag { position: absolute; background: #f6efdc; border: 1.5px solid ${INK}; box-shadow: 0 0 0 3px #f6efdc; padding: calc(4*var(--px)) calc(9*var(--px)) calc(5*var(--px)); text-align: center; transform: rotate(-1.5deg); }
  .tag.br { right: calc(12*var(--px)); bottom: calc(12*var(--px)); } .tag.bl { left: calc(12*var(--px)); bottom: calc(12*var(--px)); } .tag.tr { right: calc(12*var(--px)); top: calc(12*var(--px)); } .tag.tl { left: calc(12*var(--px)); top: calc(12*var(--px)); }
  .tv { font-family: Fraunces, Georgia, serif; font-weight: 900; font-size: max(12px, calc(16*var(--px))); line-height: 1; }
  .tl { font-size: max(6px, calc(6.5*var(--px))); font-weight: 700; letter-spacing: calc(1.2*var(--px)); color: ${BROWN}; margin-top: 3px; border-top: 1px solid ${DOT}; padding-top: 3px; white-space: nowrap; }
  .plate { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-top: calc(6*var(--px)); font-family: Fraunces, Georgia, serif; font-size: max(8px, calc(10*var(--px))); color: ${BROWN}; }
  .plate b { font-weight: 700; letter-spacing: 1.5px; font-family: Archivo, sans-serif; font-size: max(7px, calc(8*var(--px))); color: ${TAN}; }
  .plate i { font-style: italic; } .plate .r { white-space: nowrap; }
  .lede { font-family: Fraunces, Georgia, serif; font-size: max(10px, calc(12.5*var(--px))); line-height: 1.45; margin: calc(10*var(--px)) 0 0; }
  .lede::first-letter { font-size: 2.7em; font-weight: 900; float: left; line-height: .82; padding: 4px 6px 0 0; }
  .sub { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; column-gap: calc(12*var(--px)); row-gap: 2px; margin-top: calc(14*var(--px)); padding-bottom: 3px; border-bottom: 1px solid ${INK}; }
  .subn { font-family: Fraunces, Georgia, serif; font-size: max(10px, calc(12.5*var(--px))); font-weight: 700; letter-spacing: 1px; text-transform: uppercase; }
  .subr { font-size: max(7px, calc(9*var(--px))); font-weight: 700; letter-spacing: 1.5px; color: ${TAN}; }
  .chart { display: block; width: 100%; margin-top: calc(8*var(--px)); cursor: pointer; }
  .strip { margin-top: calc(12*var(--px)); border-top: 1.5px solid ${INK}; border-bottom: 1.5px solid ${INK}; display: grid; grid-template-columns: repeat(5, 1fr); text-align: center; padding: calc(8*var(--px)) 0; }
  .cell { cursor: pointer; } .cell + .cell { border-left: 1px dotted ${DOT}; }
  .cv { font-family: Fraunces, Georgia, serif; font-size: max(11px, calc(16*var(--px))); font-weight: 700; white-space: nowrap; }
  .cl { font-size: max(7px, calc(8.5*var(--px))); font-weight: 700; letter-spacing: calc(1.5*var(--px)); color: ${TAN}; margin-top: 2px; white-space: nowrap; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: calc(10*var(--px)); padding: calc(6*var(--px)) 0; border-bottom: 1px dotted ${DOT}; cursor: pointer; }
  .row:last-child { border-bottom: none; }
  .k { font-size: max(9px, calc(11.5*var(--px))); color: ${BROWN}; white-space: nowrap; }
  .v { font-family: Fraunces, Georgia, serif; font-size: max(10px, calc(13*var(--px))); font-weight: 600; text-align: right; } .v.due { color: ${TERRA}; } .v.ok { color: ${GREEN}; }
  .foot { font-size: max(7px, calc(9*var(--px))); letter-spacing: .3px; color: ${TAN}; margin-top: calc(12*var(--px)); line-height: 1.5; }`;
  }
}

if (!document.getElementById("hwc-font") && !document.getElementById("hpc-font")) {
  const l = document.createElement("link");
  l.id = "hpc-font"; l.rel = "stylesheet";
  l.href = "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;0,9..144,900;1,9..144,400&family=Archivo:wght@400;600;700&display=swap";
  document.head.appendChild(l);
}
customElements.define("homestead-pool-card", HomesteadPoolCard);
console.info(`%c HOMESTEAD-POOL-CARD %c ${HPC_VERSION} `, "background:#3a2d1f;color:#f3e7d3;font-weight:700", "background:#5f7e94;color:#fff;font-weight:700");
window.customCards = window.customCards || [];
window.customCards.push({ type: "homestead-pool-card", name: "Homestead Pool Card", description: "A newsprint swimming-conditions article: woodcut plate (day/night/storm), verdict headline, hatched 14-day high–low chart and the lifeguard's bathing notices.", preview: true, documentationURL: "https://github.com/LoneWolf345/homestead-pool-card" });
