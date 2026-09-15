// ===========================================================================
//  Visit beacon.
//
//  Posts one message per page load to the collector, which writes a row with
//  the client's address. See collector/README.md for the endpoint.
//
//  WHAT THIS DOES NOT SEND: the IP. A browser cannot see its own public
//  address, and anything a page claimed about it would be a guess at best and
//  forged at worst. The collector reads the real one off the connection. All
//  this end contributes is which page, which referrer, and the browser-local
//  device id so repeat visits from one browser can be grouped.
//
//  It is off unless an endpoint is configured. The repo ships no endpoint --
//  tools/deploy_pages.sh injects one from $COLLECTOR_ENDPOINT at deploy time
//  -- so `npm run serve` and a plain checkout never phone anywhere.
// ===========================================================================

import { deviceId } from './activity.js';

/** Endpoint from <meta name="collector-endpoint">, or '' when unconfigured. */
function endpoint() {
  const el = document.querySelector('meta[name="collector-endpoint"]');
  const url = (el?.content || '').trim();
  if (!url) return '';
  // A misconfigured endpoint should be inert, not a page error.
  try {
    const u = new URL(url, location.href);
    return u.protocol === 'https:' || u.hostname === 'localhost' ? u.href : '';
  } catch { return ''; }
}

/**
 * Report this page load. Fire-and-forget by design: no await upstream, no
 * retry, no error surfaced. A blocked or failing collector must cost the user
 * nothing -- this is a log line, and the page is the product.
 *
 * @returns {boolean} whether a request was actually issued
 */
export function ping() {
  const url = endpoint();
  if (!url) return false;

  const body = JSON.stringify({
    deviceId: deviceId(),
    path: location.pathname,
    referrer: document.referrer || null,
  });

  // keepalive so the request survives a visitor who leaves immediately.
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
    mode: 'cors',
    credentials: 'omit',
    cache: 'no-store',
  }).catch(() => { /* blocked, offline, or down: not the page's problem */ });

  return true;
}
