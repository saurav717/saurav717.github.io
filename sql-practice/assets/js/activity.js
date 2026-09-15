// ===========================================================================
//  Activity log: who ran what, from where.
//
//  Records every query that EXECUTED WITHOUT ERROR, together with a stable
//  device identifier and -- if the user opts in -- an approximate location.
//
//  ------------------------------------------------------------------------
//  TWO THINGS THIS DELIBERATELY DOES NOT DO, AND WHY
//  ------------------------------------------------------------------------
//
//  1. IT DOES NOT RECORD A MAC ADDRESS. It cannot. No browser exposes the
//     network adapter's hardware address to JavaScript, on any engine, with
//     or without permission -- a globally unique, non-resettable hardware ID
//     is exactly the kind of supercookie the platform is built to withhold.
//     (The old trick -- reading the local interface address out of a WebRTC
//     ICE candidate -- only ever yielded an IP, never a MAC, and every major
//     browser now mDNS-obfuscates even that.)
//
//     So the honest substitute is DEVICE_ID below: a random UUID minted once
//     per browser profile and kept in localStorage. It identifies a browser,
//     not a machine, and the user can reset it. Anything claiming to be a
//     MAC address from inside a web page is guessing.
//
//  2. IT DOES NOT SEND ANYTHING ANYWHERE. This site is static -- there is no
//     server to receive a log. Entries live in this browser's localStorage
//     and leave only when the user exports them. `drain()` at the bottom is
//     the seam to add a POST against if a collector ever exists.
//
//  Location is opt-in and stays off until the user turns it on, at which
//  point the browser runs its own permission prompt on top.
// ===========================================================================

const STORE_KEY = 'sqlpractice.activity.v1';

/** Entries are capped so a long practice session cannot fill localStorage. */
const MAX_ENTRIES = 500;
/** Queries are truncated at this length before being stored. */
const MAX_SQL_CHARS = 4000;
/** A fix is reused for this long before the browser is asked again. */
const LOCATION_TTL_MS = 10 * 60 * 1000;

const nowIso = () => new Date().toISOString();

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Older Safari: same shape, same entropy source.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

// --- persistence ------------------------------------------------------------
function blank() {
  return {
    deviceId: uuid(),
    deviceCreatedAt: nowIso(),
    logging: true,        // local query log: on, like the progress tracking
    locationConsent: false, // location: off until asked for explicitly
    location: null,       // last fix: { lat, lon, accuracyM, capturedAt }
    entries: [],
  };
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return blank();
    const s = { ...blank(), ...raw };
    if (!Array.isArray(s.entries)) s.entries = [];
    if (typeof s.deviceId !== 'string' || !s.deviceId) s.deviceId = uuid();
    return s;
  } catch { return blank(); }
}

const store = load();
let dirty = false;

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
    dirty = false;
  } catch {
    // Quota exceeded, or private mode. Shed the oldest half and try once more
    // rather than losing the whole log to one oversized query.
    try {
      store.entries = store.entries.slice(-Math.floor(store.entries.length / 2));
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
      dirty = false;
    } catch { dirty = true; }
  }
}

// --- device identity --------------------------------------------------------
export const deviceId = () => store.deviceId;
export const deviceCreatedAt = () => store.deviceCreatedAt;

/** Mint a fresh device id. Past entries keep the id they were written with. */
export function resetDeviceId() {
  store.deviceId = uuid();
  store.deviceCreatedAt = nowIso();
  save();
  return store.deviceId;
}

/**
 * What the platform will actually tell us about this client. Coarse, and
 * every field is user-agent-supplied -- treat it as a hint, not an identity.
 */
export function deviceProfile() {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform || null,
    language: navigator.language || null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    screen: `${screen.width}x${screen.height}`,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    // Named so nobody downstream mistakes the device id for a hardware address.
    macAddress: null,
    macAddressNote: 'Not available: browsers do not expose hardware addresses to JavaScript.',
  };
}

// --- location ---------------------------------------------------------------
export const locationConsent = () => store.locationConsent;
export const lastLocation = () => store.location;
export const locationSupported = () => 'geolocation' in navigator;

/**
 * Turn location capture on or off. Turning it ON asks the browser for a fix
 * immediately, so the permission prompt happens at the moment of the click
 * rather than in the middle of a query.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function setLocationConsent(on) {
  store.locationConsent = !!on;
  if (!on) store.location = null;
  save();
  if (!on) return { ok: true };
  try {
    await refreshLocation({ force: true });
    return { ok: true };
  } catch (e) {
    // Denied or unavailable: drop back to off so the UI does not claim more
    // than it can deliver.
    store.locationConsent = false;
    save();
    return { ok: false, error: e.message };
  }
}

function geolocate(timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (!locationSupported()) { reject(new Error('This browser has no Geolocation API.')); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({
        lat: Number(pos.coords.latitude.toFixed(5)),   // ~1 m; finer is noise
        lon: Number(pos.coords.longitude.toFixed(5)),
        accuracyM: pos.coords.accuracy == null ? null : Math.round(pos.coords.accuracy),
        capturedAt: nowIso(),
      }),
      err => reject(new Error({
        1: 'Location permission was denied.',
        2: 'The browser could not determine a position.',
        3: 'Timed out waiting for a position.',
      }[err.code] || err.message || 'Location unavailable.')),
      { enableHighAccuracy: false, timeout, maximumAge: LOCATION_TTL_MS },
    );
  });
}

/** Cached fix, refreshed once the cached one goes stale. */
export async function refreshLocation({ force = false } = {}) {
  if (!store.locationConsent && !force) return null;
  const cur = store.location;
  if (!force && cur && Date.now() - Date.parse(cur.capturedAt) < LOCATION_TTL_MS) return cur;
  store.location = await geolocate();
  save();
  return store.location;
}

// --- the log ----------------------------------------------------------------
export const isLogging = () => store.logging;

export function setLogging(on) {
  store.logging = !!on;
  save();
}

export const entries = () => store.entries;
export const entryCount = () => store.entries.length;

export function clearEntries() {
  store.entries = [];
  save();
}

/**
 * Record one query that ran successfully.
 *
 * Called only from the success paths -- a query that threw is not a
 * submission the user got working, and is not logged.
 *
 * @param {object} e
 * @param {string} e.sql        the query as submitted
 * @param {'run'|'check'} e.action  which button produced it
 * @param {string|null} e.exerciseId  null in the sandbox
 * @param {string} e.target     the portability target engine at the time
 * @param {number} e.rowCount
 * @param {number} e.ms
 * @param {boolean|null} e.passed  grading verdict for a check, else null
 */
export function record(e) {
  if (!store.logging) return null;

  const entry = {
    id: uuid(),
    at: nowIso(),
    deviceId: store.deviceId,
    action: e.action,
    exerciseId: e.exerciseId ?? null,
    exerciseTitle: e.exerciseTitle ?? null,
    target: e.target ?? null,
    sql: String(e.sql ?? '').slice(0, MAX_SQL_CHARS),
    sqlTruncated: String(e.sql ?? '').length > MAX_SQL_CHARS,
    rowCount: e.rowCount ?? null,
    ms: e.ms == null ? null : Math.round(e.ms),
    passed: e.passed ?? null,
    location: store.locationConsent ? store.location : null,
  };

  store.entries.push(entry);
  if (store.entries.length > MAX_ENTRIES) {
    store.entries = store.entries.slice(-MAX_ENTRIES);
  }
  save();

  // Refresh the fix in the background so the NEXT entry is current. Doing it
  // before the write would put a network round-trip in front of the user's
  // results.
  if (store.locationConsent) refreshLocation().catch(() => {});

  return entry;
}

// --- export -----------------------------------------------------------------
/** The whole log, in the shape a collector would receive it. */
export function snapshot() {
  return {
    exportedAt: nowIso(),
    deviceId: store.deviceId,
    deviceCreatedAt: store.deviceCreatedAt,
    device: deviceProfile(),
    locationConsent: store.locationConsent,
    lastLocation: store.location,
    entryCount: store.entries.length,
    entries: store.entries,
  };
}

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const CSV_COLUMNS = [
  'at', 'deviceId', 'action', 'exerciseId', 'exerciseTitle', 'target',
  'rowCount', 'ms', 'passed', 'lat', 'lon', 'accuracyM', 'locationAt', 'sql',
];

export function toCsv() {
  const rows = store.entries.map(e => CSV_COLUMNS.map(col => {
    switch (col) {
      case 'lat':        return e.location?.lat ?? '';
      case 'lon':        return e.location?.lon ?? '';
      case 'accuracyM':  return e.location?.accuracyM ?? '';
      case 'locationAt': return e.location?.capturedAt ?? '';
      default:           return e[col];
    }
  }).map(csvCell).join(','));
  return [CSV_COLUMNS.join(','), ...rows].join('\n');
}

/** Hand the log to the user as a file. */
export function download(format = 'json') {
  const json = format === 'json';
  const body = json ? JSON.stringify(snapshot(), null, 2) : toCsv();
  const blob = new Blob([body], { type: json ? 'application/json' : 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sql-practice-activity-${nowIso().slice(0, 10)}.${json ? 'json' : 'csv'}`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Seam for a future collector: hand every entry to `send`, and drop the ones
 * it accepts. Unused today -- there is no server -- but it keeps the shape of
 * "log locally, ship later" explicit instead of implied.
 *
 * @param {(batch: object) => Promise<void>} send
 */
export async function drain(send) {
  if (!store.entries.length) return 0;
  const batch = snapshot();
  await send(batch);
  const shipped = new Set(batch.entries.map(e => e.id));
  store.entries = store.entries.filter(e => !shipped.has(e.id));
  save();
  return shipped.size;
}

/** True when the last write to localStorage failed (private mode, or quota). */
export const storageFailed = () => dirty;
