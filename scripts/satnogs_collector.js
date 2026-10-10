'use strict';
/* RadioRadar SatNOGS historical satellite observations collector.
 * Node >= 20. No credentials or external packages.
 * Uses cursor pagination via Link header (SatNOGS changed pagination in 2024).
 * Delays displayed observations by at least 48 hours.
 * Never invents observations; leaves old output intact on HTTP error.
 */
const fs = require('node:fs');
const path = require('node:path');
const BASE = 'https://network.satnogs.org/api/observations/';
const OUT = path.join(process.cwd(), 'data', 'satnogs.json');
const AGE_MS = 48 * 3600 * 1000;
const MAX_PAGES = 12;
const MAX_ITEMS = 40;
const TIMEOUT_MS = 25000;
function parseDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function short(value, max=120) { return String(value ?? '').slice(0,max); }
function normalize(r, cutoff) {
  if (!r || !Number.isSafeInteger(Number(r.id)) || Number(r.id) < 1) return null;
  const start=parseDate(r.start), end=parseDate(r.end);
  if (!start || !end || Date.parse(end) > cutoff || Date.parse(start)>Date.parse(end)) return null;
  const id=Number(r.id);
  const low=Number(r.transmitter_downlink_low);
  const high=Number(r.transmitter_downlink_high);
  return {
    id,start,end,
    station:short(r.station_name || `Station ${r.ground_station || '?'}`),
    satellite_norad:short(r.norad_cat_id,32),
    frequency_mhz:Number.isFinite(low)&&low>0 ? Math.round(low/1e4)/100 : null,
    band_high_mhz:Number.isFinite(high)&&high>0 ? Math.round(high/1e4)/100 : null,
    mode:short(r.transmitter_mode || '',40),
    status:short(r.status || 'unknown',40),
    waterfall_available:Boolean(r.waterfall || r.waterfall_status === true || r.waterfall_status === 'good'),
    source_url:`https://network.satnogs.org/observations/${id}/`
  };
}
function nextFromLink(link) {
  // RFC 8288 Link header, e.g. <https://.../?cursor=...>; rel="next"
  for (const entry of String(link || '').split(',')) {
    if (!/\brel\s*=\s*["']?next["']?(?:\s*;|\s*$)/i.test(entry)) continue;
    const found=entry.match(/<([^>]+)>/);
    if (found) return found[1];
  }
  return null;
}
function safeApiUrl(raw) {
  const url=new URL(raw,BASE);
  if (url.origin !== 'https://network.satnogs.org' || url.pathname !== '/api/observations/' || url.protocol !== 'https:') {
    throw new Error('Pagination URL points outside SatNOGS observations API');
  }
  return url.href;
}
async function fetchPage(url) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(), TIMEOUT_MS);
  try {
    const response=await fetch(safeApiUrl(url), {
      headers:{Accept:'application/json','User-Agent':'RadioRadar-Historical-Archive/1.1'},
      signal:controller.signal
    });
    if (!response.ok) {
      const detail=(await response.text()).replace(/\s+/g,' ').slice(0,180);
      throw new Error(`SatNOGS HTTP ${response.status}: ${detail}`);
    }
    const body=await response.json();
    // Current API: paginated array + Link header. Older schema: {results,next}.
    const records=Array.isArray(body) ? body : body?.results;
    if (!Array.isArray(records)) throw new Error('Unexpected SatNOGS response: expected array of observations');
    const next=nextFromLink(response.headers.get('link')) || (!Array.isArray(body) ? body?.next : null);
    return {records, next: next ? safeApiUrl(next) : null};
  } finally { clearTimeout(timer); }
}
async function collect(fetcher=fetchPage,now=Date.now()) {
  const cutoff=now-AGE_MS;
  const items=[], ids=new Set(), visited=new Set();
  let url=BASE, pages=0, scanned=0;
  while (url && pages<MAX_PAGES && items.length<MAX_ITEMS) {
    const normalizedUrl=safeApiUrl(url);
    if (visited.has(normalizedUrl)) throw new Error('Repeated pagination cursor detected');
    visited.add(normalizedUrl);
    const page=await fetcher(normalizedUrl);
    if (!page || !Array.isArray(page.records)) throw new Error('Unexpected page response');
    pages++;
    for (const r of page.records) {
      scanned++;
      const item=normalize(r,cutoff);
      if (item && !ids.has(item.id)) { ids.add(item.id);items.push(item); }
    }
    url=page.next;
  }
  items.sort((a,b)=>b.end.localeCompare(a.end));
  return {
    schema_version:1, source:'SatNOGS Network',dataset:'archived satellite observations',
    license:'CC BY-SA (source metadata)',license_url:'https://creativecommons.org/licenses/by-sa/4.0/',
    api_url:BASE,generated_at:new Date(now).toISOString(),minimum_age_hours:48,
    note:'Satellite observations only; no direct ground-radio detection or transmitter location. Absence of matching records is not absence of RF activity.',
    latest_status:items.length?'ok':'no_matching_archival_records',
    inspected_pages:pages,scanned_records:scanned,exhaustive:!url,
    observations:items.slice(0,MAX_ITEMS)
  };
}
async function main() {
  const result=await collect();
  fs.mkdirSync(path.dirname(OUT),{recursive:true});
  const temp=OUT+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(result,null,2)+'\n','utf8');
  fs.renameSync(temp,OUT);
  console.log(`Saved ${result.observations.length} historical satellite observations; scanned ${result.scanned_records} across ${result.inspected_pages} pages.`);
  if (!result.observations.length) console.log('No records older than 48h in scanned pages. This is not an API failure.');
}
if (require.main===module) main().catch(e=>{console.error('Data not updated:',e.message);process.exitCode=1;});
module.exports={collect,normalize,nextFromLink,safeApiUrl};
