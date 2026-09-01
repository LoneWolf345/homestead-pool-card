// smoke.mjs — node harness for homestead-pool-card
import fs from "node:fs"; import vm from "node:vm";
const src = fs.readFileSync(new URL("./homestead-pool-card.js", import.meta.url), "utf8");
class HTMLElement { constructor() { this._sr = null; this.style = {}; this._h = 700; } attachShadow() { this._sr = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null }; return this._sr; } get shadowRoot() { return this._sr; } dispatchEvent() {} getBoundingClientRect() { return { height: this._h }; } }
const defs = {}; const store = new Map();
const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
// A clock we can set: the card only ever calls new Date() / Date.now() for "now".
class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(FakeDate._now); } static now() { return FakeDate._now; } }
FakeDate._now = Date.now();
const ctx = { HTMLElement, customElements: { define: (n, c) => (defs[n] = c) }, document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } }, console, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } }, setInterval: () => 0, clearInterval() {}, setTimeout, Date: FakeDate, localStorage };
ctx.window = ctx; vm.createContext(ctx); vm.runInContext(src, ctx);
const Card = defs["homestead-pool-card"];
let fails = 0;
const check = (name, cond) => { console.log((cond ? "ok  " : "FAIL") + " " + name); if (!cond) fails++; };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ---- fixed "now": today at 14:00 local ----
const day0 = new Date(); day0.setHours(0, 0, 0, 0);
const at = (h, off = 0) => new Date(day0.getTime() + off * 86400000 + h * 3600000);
const setNow = (d) => { FakeDate._now = d.getTime(); };
setNow(at(14));

// ---- history: 15 days of 2-hourly samples; yesterday 14:00 = 89, today ends 14:00 = 88 ----
const rows = [];
for (let k = -14; k <= 0; k++) {
  const base = 86 + (((k % 3) + 3) % 3);
  for (let h = 0; h <= (k === 0 ? 14 : 22); h += 2) {
    let v = base + 3 * Math.sin(((h - 6) / 24) * 2 * Math.PI);
    if (k === -1 && h === 14) v = 89; if (k === 0 && h === 14) v = 88;
    rows.push({ s: v.toFixed(1), lu: at(h, k).getTime() / 1000 });
  }
}
const history = async (m) => (m.type === "history/history_during_period" ? { "sensor.pool_temperature": rows } : {});

// ---- hourly forecast: local-hour temperature / UV profile, sunny ----
const T = { 0: 85, 1: 84, 2: 83, 3: 82, 4: 81, 5: 80, 6: 79, 7: 82, 8: 86, 9: 90, 10: 94, 11: 97, 12: 99, 13: 100, 14: 100, 15: 103, 16: 104, 17: 103, 18: 98, 19: 96, 20: 93, 21: 90, 22: 88, 23: 86 };
const U = { 7: 1, 8: 3, 9: 5, 10: 7, 11: 9, 12: 10, 13: 9, 14: 8, 15: 7, 16: 5, 17: 3, 18: 1 };
const forecast = (mut) => { const out = []; for (let i = -2; i < 34; i++) { const t = new Date(at(14).getTime() + i * 3600000); const h = t.getHours(); const f = { datetime: t.toISOString(), temperature: T[h], uv_index: U[h] || 0, condition: "sunny", precipitation_probability: 0 }; if (mut) mut(f, i); out.push(f); } return out; };
const conn = (fc) => ({ subscribeMessage: async (cb, msg) => { if (msg.type === "weather/subscribe_forecast") setTimeout(() => cb({ forecast: fc }), 5); return () => {}; } });

const S = (v, extra) => ({ state: String(v), attributes: extra || {}, last_updated: at(14).toISOString() });
const base = () => ({
  "sensor.pool_temperature": S(88.2), "sensor.weather_station_temperature": S(100.4), "sensor.weather_station_uv_index": S(8.0),
  "sensor.weather_station_wind_speed": S(6.2), "sensor.weather_station_wind_gust": S(12.1),
  "sun.sun": S("above_horizon", { next_setting: at(18.9).toISOString(), next_rising: at(6.02, 1).toISOString() }),
  "weather.home": S("sunny"),
  "sensor.pool_add_chlorine": S("ok", { next_due: ymd(at(0, 5)), days_until_due: 5 }),
  "sensor.pool_clean_pool_filter": S("ok", { next_due: ymd(at(0, 9)), days_until_due: 9 }),
});
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
const cfg = () => ({ water_entity: "sensor.pool_temperature", air_entity: "sensor.weather_station_temperature", uv_entity: "sensor.weather_station_uv_index", wind_entity: "sensor.weather_station_wind_speed", gust_entity: "sensor.weather_station_wind_gust", weather_entity: "weather.home", sun_entity: "sun.sun",
  plates: { day: { src: "/local/pool/plate-lawn.jpg", caption: "The pool on its lawn." }, night: { src: "/local/pool/plate-night.jpg", caption: "By moonlight." }, storm: { src: "/local/pool/plate-storm.jpg", caption: "Under a thunderhead." } },
  chores: [{ name: "Chlorine", entity: "sensor.pool_add_chlorine" }, { name: "Filter clean", entity: "sensor.pool_clean_pool_filter" }] });
const make = async (states, c, fc) => { const el = new Card(); el.setConfig(c || cfg()); el.hass = { states, callWS: history, connection: conn(fc || forecast()) }; await tick(); await tick(); return el; };
const DAY3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

check("card registered", typeof Card === "function");
check("setConfig rejects missing water_entity", (() => { try { new Card().setConfig({}); return false; } catch (e) { return /water_entity/.test(e.message); } })());

{ const el = await make(base()); const h = el.shadowRoot.innerHTML;
  check("kicker", h.includes("THE POOL") && h.includes("LIFEGUARD ON DUTY: NONE"));
  check("headline: warm, air 100, UV 8 clause", h.includes("Warm swimming at the deep end: water 88, air 100, and the sun is not on your side"));
  check("dek with sunset", h.includes("Water 88° · air 100° · UV 8 at press time · wind 6 mph · sunset 6:54 PM"));
  check("day plate + tag", h.includes('src="/local/pool/plate-lawn.jpg"') && h.includes('<div class="tv">88°</div>') && h.includes("WARM · SWIM ON") && h.includes("PLATE II.") && h.includes("The pool on its lawn."));
  check("lede: yesterday + air comparison", h.includes(`The deep end reported a warm ${DAYS[at(14).getDay()]}: 88 degrees by press time, a degree under this time yesterday and 12 degrees cooler than the air.`));
  check("lede: burn + best hour", h.includes("Burning takes about a quarter of an hour at this hour; the paper recommends the hour after 6, 98°, UV 1."));
  check("burn row due", h.includes('class="v due">15–20 min · UV 8'));
  check("best hour row ok", h.includes('class="v ok">6–7 PM · 98°, UV 1'));
  check("water vs air flips after 11 PM", h.includes("Warmer than the air after 11 PM"));
  check("chop light", h.includes("Light · gusts to 12 mph"));
  check("fortnight range row", /Fortnight&#39;s range<\/span><span class="v">\d+°–\d+° · high on [A-Z][a-z]{2} \d+/.test(h));
  check("upkeep: soonest chore, not due", h.includes(`Chlorine · due ${DAY3[at(0, 5).getDay()]} (5 days)`) && !/class="v due">Chlorine/.test(h) && !h.includes("is owed"));
  check("chart: 14 range bars + today, AVG, gridlines", (h.match(/fill="url\(#hb\)"/g) || []).length === 14 && (h.match(/fill="url\(#ht\)"/g) || []).length === 1 && h.includes(">AVG<") && /<text x="4" y="[\d.]+" [^>]*>\d+°<\/text>/.test(h) && h.includes("days in the deep end"));
  check("strip sunset cell", h.includes('<div class="cv">6:54</div><div class="cl">SUNSET</div>'));
  check("height remembered after load", store.get("hpc-h:sensor.pool_temperature") === "700"); }

{ setNow(at(21)); const st = base(); st["sun.sun"] = S("below_horizon", { next_setting: at(18.9, 1).toISOString(), next_rising: at(6.02, 1).toISOString() }); st["sensor.weather_station_uv_index"] = S(0);
  const el = await make(st); const h = el.shadowRoot.innerHTML;
  check("night: plate + AFTER DARK tag", h.includes('src="/local/pool/plate-night.jpg"') && h.includes("WARM · AFTER DARK") && h.includes("By moonlight."));
  check("night: headline clocked out + burn none", h.includes("and the sun has clocked out") && h.includes("None · sun clocked out"));
  check("night: best hour is now", h.includes('class="v ok">Now · 90°, after dark') && h.includes("the paper recommends now, under no sun at all"));
  check("night: dek sunrise + strip", h.includes("sunrise 6:01 AM") && h.includes('<div class="cl">SUNRISE</div>'));
  setNow(at(14)); }

{ const el = await make(base(), null, forecast((f, i) => { if (i === 2) f.condition = "lightning-rainy"; })); const h = el.shadowRoot.innerHTML;
  check("storm in forecast → storm plate + tag", h.includes('src="/local/pool/plate-storm.jpg"') && h.includes("WARM · STORM DUE") && h.includes("Under a thunderhead."));
  const st = base(); st["weather.home"] = S("lightning"); const el2 = await make(st); const h2 = el2.shadowRoot.innerHTML;
  check("current condition stormy → storm plate", h2.includes('src="/local/pool/plate-storm.jpg"'));
  const el3 = await make(base(), null, forecast((f, i) => { if (i === 12) f.condition = "lightning-rainy"; })); check("storm beyond window → day plate", el3.shadowRoot.innerHTML.includes('src="/local/pool/plate-lawn.jpg"')); }

{ const st = base(); st["sensor.pool_temperature"] = S("unavailable"); const el = await make(st); const h = el.shadowRoot.innerHTML;
  check("stale water: last history reading + as-of", h.includes("water 88, air 100") && h.includes("water as of 2:00 PM")); }

{ const st = base(); st["sensor.pool_temperature"] = S(62); const el = await make(st); const h = el.shadowRoot.innerHTML;
  check("closed by cold", h.includes("No swimming at the deep end: water 62, air 100, and nobody is going in") && h.includes("CLOSED BY COLD") && h.includes("reported a cold"));
  st["sensor.pool_temperature"] = S(93.4); const el2 = await make(st); const h2 = el2.shadowRoot.innerHTML;
  check("bathwater", h2.includes("Bathwater at the deep end: water 93, air 100, and the sun is not on your side") && h2.includes("BATHWATER · SWIM ANYWAY")); }

{ const c = cfg(); c.air_max = 90; const el = await make(base(), c); const h = el.shadowRoot.innerHTML;
  check("no hour suits before sunset → after dark", h.includes("After dark · 96° at 7 PM") && h.includes("recommends waiting for dark, when the air drops to 96")); }

{ const st = base(); st["sensor.pool_add_chlorine"] = S("overdue", { next_due: ymd(at(0, -2)), days_until_due: -2 }); st["sensor.weather_station_wind_gust"] = S(31);
  const el = await make(st); const h = el.shadowRoot.innerHTML;
  check("overdue chore: row due + lede", h.includes('class="v due">Chlorine · overdue 2 days') && h.includes("The chlorine is owed already."));
  check("whitecaps due", h.includes('class="v due">Whitecaps in the shallow end · gusts to 31 mph')); }

{ const c = cfg(); c.weather_entity = ""; const el = await make(base(), c); const h = el.shadowRoot.innerHTML;
  check("no forecast: rows degrade", h.includes("No forecast filed") && h.includes(">Cooler than the air<")); }

{ store.delete("hpc-h:sensor.pool_temperature"); const el = new Card(); el.setConfig(cfg()); el.hass = { states: base(), callWS: () => new Promise(() => {}), connection: conn(forecast()) };
  check("history pending: pinned at current height", el.style.minHeight === "700px"); await tick();
  check("history pending, no memory: no reservation after the tick", el.style.minHeight === "");
  store.set("hpc-h:sensor.pool_temperature", "812");
  const el2 = new Card(); el2.setConfig(cfg()); el2.hass = { states: base(), callWS: () => new Promise(() => {}), connection: conn(forecast()) }; await tick();
  check("history pending: reserves remembered height", el2.style.minHeight === "812px"); }

console.log(fails ? `\n${fails} FAILED` : "\nall passed"); process.exit(fails ? 1 : 0);
