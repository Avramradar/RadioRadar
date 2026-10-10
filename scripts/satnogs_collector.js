'use strict';
/* RadioRadar / SatNOGS — historical satellite observation importer.
 * Node.js 20+, no additional dependencies, no authentication.
 * Searches bounded historical observation windows, using SatNOGS-supported
 * start/end parameters and RFC 8288 Link-header cursor pagination.
 * Only accepts observations that ended at least 48 hours before collection.
 * Satellite observations only. No terrestrial transmitter monitoring.
 */
const fs = require('node:fs');
const path = require('node:path');
const API = 'https://network.satnogs.org/api/observations/';
const OUTPUT = path.join(process.cwd(), 'data', 'satnogs.json');
const AGE_HOURS = 48;
const WINDOW_HOURS = 24;
const MAX_PAGES_PER_WINDOW = 8;
const MAX_RECORDS = 40;
const REQUEST_TIMEOUT_MS = 30000;

function iso(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function field(value, length=100) { return String(value ?? '').slice(0, length); }
function safeURL(raw) {
  const url = new URL(raw, API);
  if (url.protocol !== 'https:' || url.hostname !== 'network.satnogs.org' || url.port || url.pathname !== '/api/observations/') {
    throw Error('Pagination URL is outside the official observations API');
  }
  return url.toString();
}
function nextLink(header) {
  for (const entry of String(header || '').split(/,(?=\s*<)/)) {
    if (!/;\s*rel\s*=\s*["']?next["']?(?:\s*;|\s*$)/i.test(entry)) continue;
    const match = entry.match(/<([^>]+)>/);
    if (match) return match[1];
  }
  return null;
}
function observation(row, olderThan, windowStart, windowEnd) {
  if (!row || !Number.isSafeInteger(Number(row.id)) || Number(row.id) <= 0) return null;
  const start = iso(row.start), end = iso(row.end);
  if (!start || !end) return null;
  const s = Date.parse(start), e = Date.parse(end);
  if (e > olderThan || e < s || s < windowStart || s >= windowEnd || e >= windowEnd) return null;
  const frequency = Number(row.transmitter_downlink_low);
  const frequencyHigh = Number(row.transmitter_downlink_high);
  const id = Number(row.id);
  return {
    id, start, end,
    station: field(row.station_name || `Station ${row.ground_station || '?'}`),
    satellite_norad: field(row.norad_cat_id,32),
    frequency_mhz: Number.isFinite(frequency) && frequency > 0 ? Math.round(frequency / 1e4) / 100 : null,
    band_high_mhz: Number.isFinite(frequencyHigh) && frequencyHigh > 0 ? Math.round(frequencyHigh / 1e4) / 100 : null,
    mode: field(row.transmitter_mode || '',40),
    status: field(row.status || 'unknown',40),
    waterfall_available: Boolean(row.waterfall || row.waterfall_status === true || row.waterfall_status === 'good'),
    source_url: `https://network.satnogs.org/observations/${id}/`
  };
}
function makeWindowUrl(start, end) {
  const url = new URL(API);
  url.searchParams.set('start',new Date(start).toISOString());
  url.searchParams.set('end',new Date(end).toISOString());
  return safeURL(url.toString());
}
async function fetchPage(rawUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(),REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(safeURL(rawUrl), {
      headers: {Accept: 'application/json', 'User-Agent': 'RadioRadar-Historical-Archive/1.2'},
      signal: controller.signal
    });
    if (!response.ok) {
      const body = (await response.text()).replace(/\s+/g,' ').slice(0,180);
      throw Error(`SatNOGS HTTP ${response.status}: ${body}`);
    }
    const body = await response.json();
    const records = Array.isArray(body) ? body : body?.results;
    if (!Array.isArray(records)) throw Error('Unexpected API response: observations list missing');
    const next = nextLink(response.headers.get('link')) || (!Array.isArray(body) ? body?.next : null);
    return {records, next: next ? safeURL(next) : null};
  } finally { clearTimeout(timer); }
}
async function collect(fetcher=fetchPage, now=Date.now()) {
  const cutoff = now - AGE_HOURS * 3600000;
  // Three archived day-windows, all older than 48h; no current/live data.
  const windows = [
    [cutoff - WINDOW_HOURS*3600000, cutoff],
    [cutoff - 3*WINDOW_HOURS*3600000, cutoff - 2*WINDOW_HOURS*3600000],
    [cutoff - 8*WINDOW_HOURS*3600000, cutoff - 7*WINDOW_HOURS*3600000]
  ];
  const entries = [], seenIDs = new Set();
  let scanned = 0, pages = 0, fullyChecked = true, windowsChecked = 0;
  for (const [start,end] of windows) {
    let url = makeWindowUrl(start,end), windowPages = 0;
    const visited = new Set();
    while (url && windowPages < MAX_PAGES_PER_WINDOW && entries.length < MAX_RECORDS) {
      if (visited.has(url)) throw Error('Repeated pagination cursor');
      visited.add(url);
      const result = await fetcher(url);
      if (!result || !Array.isArray(result.records)) throw Error('Malformed page');
      pages++; windowPages++;
      for (const row of result.records) {
        scanned++;
        const item = observation(row,cutoff,start,end);
        if (item && !seenIDs.has(item.id)) { entries.push(item);seenIDs.add(item.id); }
      }
      url = result.next ? safeURL(result.next) : null;
    }
    windowsChecked++;
    if (url) fullyChecked = false;
    if (entries.length >= MAX_RECORDS) {fullyChecked = false;break;}
  }
  entries.sort((a,b) => b.end.localeCompare(a.end));
  return {
    schema_version:1,source:'SatNOGS Network',dataset:'archived satellite observations',
    license:'CC BY-SA (source metadata)',license_url:'https://creativecommons.org/licenses/by-sa/4.0/',
    api_url:API, generated_at:new Date(now).toISOString(), minimum_age_hours:AGE_HOURS,
    note:'Historical satellite observations only. No terrestrial radio detection or localization.',
    latest_status:entries.length ? 'ok' : 'no_matching_archival_records',
    inspected_pages:pages, scanned_records:scanned, exhaustive:fullyChecked && windowsChecked===windows.length,
    observations:entries.slice(0,MAX_RECORDS)
  };
}
async function main() {
  const output = await collect();
  // Never fabricate a successful update; absence of archived records is explicit.
  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});
  const temporary = OUTPUT+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(output,null,2)+'\n','utf8');
  fs.renameSync(temporary,OUTPUT);
  console.log(`Historical SatNOGS: ${output.observations.length} observations, ${output.scanned_records} scanned, ${output.inspected_pages} pages.`);
  if (!output.observations.length) console.log('No observations matched the selected historical windows. Data is empty, not a radio-silence finding.');
}
if (require.main===module) main().catch(error=>{console.error('Archive NOT updated:',error.message);process.exitCode=1;});
module.exports = {collect,observation,makeWindowUrl,nextLink,safeURL};
