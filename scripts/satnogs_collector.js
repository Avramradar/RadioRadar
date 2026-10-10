'use strict';
/* RadioRadar / SatNOGS: public historical satellite observations only.
 * Node 20+; no NPM dependencies, no secrets, no near-real-time data.
 * On fetch failure exits non-zero and does not overwrite previous snapshot.
 */
const fs = require('node:fs');
const path = require('node:path');
const BASE = 'https://network.satnogs.org/api/observations/';
const OUT = path.join(process.cwd(), 'data', 'satnogs.json');
const MIN_AGE_MS = 48 * 3600 * 1000;
const MAX_PAGES = 12;
const MAX_ITEMS = 40;
const timeoutMs = 20000;
function iso(s) { const d = new Date(s); return Number.isFinite(d.getTime()) ? d.toISOString() : null; }
function safeText(x, n = 120) { return String(x == null ? '' : x).slice(0,n); }
function httpsLink(x) { const s = String(x || ''); try { const u = new URL(s); return u.protocol === 'https:' ? u.href : null; } catch { return null; } }
function normalize(r, cutoff) {
  if (!r || !Number.isInteger(Number(r.id))) return null;
  const end = iso(r.end), start = iso(r.start);
  if (!end || !start || Date.parse(end) > cutoff || Date.parse(start) > Date.parse(end)) return null;
  const id = Number(r.id);
  const freqLow = Number(r.transmitter_downlink_low);
  const freqHigh = Number(r.transmitter_downlink_high);
  return {
    id, start, end,
    station: safeText(r.station_name || `Station ${r.ground_station || '?'}`),
    satellite_norad: safeText(r.norad_cat_id, 32),
    frequency_mhz: Number.isFinite(freqLow) && freqLow > 0 ? Math.round(freqLow / 1e4)/100 : null,
    band_high_mhz: Number.isFinite(freqHigh) && freqHigh > 0 ? Math.round(freqHigh / 1e4)/100 : null,
    mode: safeText(r.transmitter_mode || '', 40),
    status: safeText(r.status || 'unknown', 40),
    waterfall_available: Boolean(r.waterfall),
    source_url: `https://network.satnogs.org/observations/${id}/`
  };
}
async function fetchPage(page) {
  const url = new URL(BASE);
  url.searchParams.set('page', String(page));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers:{'Accept':'application/json','User-Agent':'RadioRadar-Historical-Archive/1.0'}, signal:controller.signal });
    if (!r.ok) throw new Error(`SatNOGS HTTP ${r.status} (page ${page})`);
    const body = await r.json();
    if (!body || !Array.isArray(body.results)) throw new Error('Unexpected SatNOGS JSON schema: results[] missing');
    return body;
  } finally { clearTimeout(timer); }
}
async function collect(fetcher=fetchPage, now=Date.now()) {
  const cutoff=now-MIN_AGE_MS, seen=new Set(), items=[];
  let inspectedPages=0, reachedArchive=false;
  for (let page=1;page<=MAX_PAGES;page++) {
    const response=await fetcher(page); inspectedPages++;
    for (const raw of response.results) {
      const observation=normalize(raw,cutoff);
      if (observation && !seen.has(observation.id)) { seen.add(observation.id); items.push(observation); }
      if (observation) reachedArchive=true;
    }
    if (!response.next || items.length >= MAX_ITEMS) break;
  }
  items.sort((a,b)=>b.end.localeCompare(a.end));
  return { schema_version:1,source:'SatNOGS Network',dataset:'archived satellite observations',
    license:'CC BY-SA (source metadata)',license_url:'https://creativecommons.org/licenses/by-sa/4.0/',
    api_url:BASE,generated_at:new Date(now).toISOString(),minimum_age_hours:48,
    note:'Observations of satellites only. No RF power in dBm is asserted. No ground transmitter locations or real-time monitoring.',
    latest_status: items.length ? 'ok' : 'no_matching_archival_records',
    inspected_pages:inspectedPages,exhaustive:false,
    observations:items.slice(0,MAX_ITEMS)};
}
async function main(){
  const result=await collect();
  fs.mkdirSync(path.dirname(OUT),{recursive:true});
  const tmp=OUT+'.tmp';fs.writeFileSync(tmp,JSON.stringify(result,null,2)+'\n','utf8');fs.renameSync(tmp,OUT);
  console.log(`Saved ${result.observations.length} historical satellite observations; ${result.inspected_pages} pages inspected.`);
}
if(require.main===module) main().catch(e=>{console.error('Data not updated:',e.message);process.exitCode=1;});
module.exports={collect,normalize};
