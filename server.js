/*
 * Dependency-free local server for the downloaded site.
 * It uses only public Google Maps pages; no API key or Places API is used.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const port = Number(process.env.PORT) || 3000;
const GOOGLE_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
};
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...securityHeaders()
  });
  res.end(JSON.stringify(body));
}

function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  };
}

function decodeGoogleString(value) {
  try { return JSON.parse(`"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`); } catch { return value; }
}

function parseGoogleJson(text) {
  try {
    const cleaned = text.replace(/^\)\]\}'\s*/, '');
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function assertGoogleUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Please enter a valid Google Maps or Business Profile link.'); }
  const host = parsed.hostname.toLowerCase();
  const isGoogle = host === 'share.google' || host.endsWith('.share.google') ||
    host === 'goo.gl' || host.endsWith('.goo.gl') ||
    host === 'g.page' || host.endsWith('.g.page') ||
    host === 'g.co' || host.endsWith('.g.co') ||
    host === 'maps.app.goo.gl' || host.endsWith('.google.com');
  if (!isGoogle || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Please enter a Google Maps or Business Profile link.');
  }
  return parsed;
}

async function get(url, extraHeaders = {}) {
  const response = await fetch(url, {
    headers: { ...GOOGLE_HEADERS, ...extraHeaders },
    redirect: 'follow',
    cache: 'no-store',
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error('Google could not open this listing. Please try the link again.');
  return { url: response.url, text: await response.text() };
}

function previewUrlFromPage(html) {
  const match = html.match(/<link href="([^"]*\/maps\/preview\/place[^"]*)/i);
  return match ? `https://www.google.com${match[1].replace(/&amp;/g, '&')}` : null;
}

function mapSearchUrlFromPage(html) {
  const match = html.match(/<link href="([^"]*\/search\?tbm=map[^"]*)/i);
  return match ? `https://www.google.com${match[1].replace(/&amp;/g, '&')}` : null;
}

function mapsLookupUrl({ query, kgs, kgmid, hl, gl }) {
  const url = new URL(`https://www.google.com/maps/search/${encodeURIComponent(query)}`);
  if (kgmid) url.searchParams.set('kgmid', kgmid);
  if (kgs) url.searchParams.set('kgs', kgs);
  if (hl) url.searchParams.set('hl', hl);
  if (gl) url.searchParams.set('gl', gl);
  return url.toString();
}

function extractFromPlaceInfo(info) {
  if (!info || !Array.isArray(info)) return null;

  const name = (info[11] && typeof info[11] === 'string') ? decodeGoogleString(info[11]) : null;
  const address = info[18] ? decodeGoogleString(info[18]) : (info[2] && Array.isArray(info[2]) ? info[2].map(decodeGoogleString).join(', ') : null);

  let rating = null;
  let reviewCount = null;
  if (info[4] && Array.isArray(info[4])) {
    const rArr = info[4];
    if (typeof rArr[7] === 'number') rating = rArr[7];
    if (typeof rArr[8] === 'number') reviewCount = rArr[8];
    if (reviewCount === null && rArr[3] && typeof rArr[3][1] === 'string') {
      const m = rArr[3][1].match(/([\d,]+)/);
      if (m) reviewCount = Number(m[1].replace(/,/g, ''));
    }
  }

  const phones = [];
  if (info[178] && Array.isArray(info[178])) {
    for (const p of info[178]) {
      if (Array.isArray(p)) {
        if (p[0] && typeof p[0] === 'string') phones.push(p[0]);
        if (p[1] && Array.isArray(p[1])) {
          for (const sub of p[1]) {
            if (Array.isArray(sub) && typeof sub[0] === 'string') phones.push(sub[0]);
          }
        }
      }
    }
  }

  let website = null;
  if (info[7] && Array.isArray(info[7]) && typeof info[7][0] === 'string') {
    website = decodeGoogleString(info[7][0]);
  } else if (typeof info[7] === 'string') {
    website = decodeGoogleString(info[7]);
  }

  const rawPhones = phones.map(decodeGoogleString).filter((p) => /\d{5,}/.test(p));
  const phoneMap = new Map();
  for (const phone of rawPhones) {
    const digits = phone.replace(/\D/g, '');
    const key = digits.length >= 7 ? digits.slice(-10) : digits;
    const existing = phoneMap.get(key);
    if (!existing || (phone.includes('+') && !existing.includes('+')) || phone.length > existing.length) {
      phoneMap.set(key, phone);
    }
  }
  const uniquePhones = Array.from(phoneMap.values());

  if (!name && !address) return null;

  return {
    name,
    address,
    phones: uniquePhones,
    rating,
    reviewCount,
    website,
    placeId: (info[78] && typeof info[78] === 'string') ? info[78] : null,
    hexId: (info[10] && typeof info[10] === 'string') ? info[10] : null,
    _placeUrl: info[42] || null,
  };
}

function extractFromJsonPayload(json) {
  if (!json || !Array.isArray(json)) return null;

  // Place preview response
  if (json[6] && Array.isArray(json[6])) {
    const res = extractFromPlaceInfo(json[6]);
    if (res && res.name) return res;
  }

  // Search results response
  if (json[0] && Array.isArray(json[0]) && Array.isArray(json[0][1])) {
    const results = json[0][1];
    for (const item of results) {
      if (item && Array.isArray(item) && item[14]) {
        const res = extractFromPlaceInfo(item[14]);
        if (res && res.name) return res;
      }
    }
  }

  return null;
}

function extractListingRegex(page) {
  const placeMatch = page.match(/"(0x[0-9a-f]+:0x[0-9a-f]+)","((?:\\.|[^"\\])+)"/i);
  const name = placeMatch ? decodeGoogleString(placeMatch[2]) : null;
  const addressPattern = name ? new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},\\s*([^"]+)"`) : null;
  const addressMatch = addressPattern && page.match(addressPattern);
  const address = addressMatch ? `${name}, ${decodeGoogleString(addressMatch[1])}` : null;
  const ratingAndReviews = page.match(/"([\d,]+) reviews"[\s\S]{0,140}?\b([1-5](?:\.\d)?)\s*,\s*([\d,]+)\s*,/i);
  const reviewLabel = page.match(/"([\d,]+) reviews"/i);
  const ratingNearReview = reviewLabel && page.slice(reviewLabel.index, reviewLabel.index + 400).match(/,([1-5](?:\.\d)?),([\d,]+),/);
  const phoneMatches = [];
  if (name) {
    const nameIdx = page.indexOf(name);
    const windowText = nameIdx !== -1 ? page.slice(Math.max(0, nameIdx - 500), nameIdx + 2000) : page;
    const directMatches = [...windowText.matchAll(/\[\["([^"\\]+)",\d+\],\["([^"\\]+)",\d+\]\]/g)]
      .map((match) => decodeGoogleString(match[2] || match[1]))
      .filter((phone) => /\d{5,}/.test(phone));
    phoneMatches.push(...directMatches);
  } else {
    const firstMatch = page.match(/\[\["([^"\\]+)",\d+\],\["([^"\\]+)",\d+\]\]/);
    if (firstMatch) phoneMatches.push(decodeGoogleString(firstMatch[2] || firstMatch[1]));
  }

  const rawPhones = phoneMatches.map(decodeGoogleString).filter((p) => /\d{5,}/.test(p));
  const phoneMap = new Map();
  for (const phone of rawPhones) {
    const digits = phone.replace(/\D/g, '');
    const key = digits.length >= 7 ? digits.slice(-10) : digits;
    const existing = phoneMap.get(key);
    if (!existing || (phone.includes('+') && !existing.includes('+')) || phone.length > existing.length) {
      phoneMap.set(key, phone);
    }
  }
  const phones = Array.from(phoneMap.values());
  const websiteMatch = page.match(/\["(https?:\\?\/\\?\/[^"\\]+)",null,null,"[^"]*"\][\s\S]{0,80}?\[7,2,\["https:\\?\/\\?\/www\.gstatic\.com[^\]]+"Website"/i);
  const website = websiteMatch ? decodeGoogleString(websiteMatch[1]).replace(/\\\//g, '/') : null;

  if (!name) throw new Error('The public listing details were not available for this link.');
  return {
    name,
    address,
    phones,
    rating: ratingAndReviews ? Number(ratingAndReviews[2]) : (ratingNearReview ? Number(ratingNearReview[1]) : null),
    reviewCount: ratingAndReviews ? Number(ratingAndReviews[3].replace(/,/g, '')) : (reviewLabel ? Number(reviewLabel[1].replace(/,/g, '')) : null),
    website,
    hexId: placeMatch ? placeMatch[1] : null,
  };
}

function extractListing(page) {
  const json = parseGoogleJson(page);
  if (json) {
    const extracted = extractFromJsonPayload(json);
    if (extracted && extracted.name) {
      return extracted;
    }
  }
  return extractListingRegex(page);
}

function recordCompleteness(record) {
  if (!record) return 0;
  return (record.name ? 1 : 0) +
    (record.address ? 1 : 0) +
    (record.phones && record.phones.length > 0 ? 1 : 0) +
    (record.rating !== null && record.rating !== undefined ? 1 : 0) +
    (record.reviewCount !== null && record.reviewCount !== undefined ? 1 : 0) +
    (record.website ? 1 : 0);
}

async function extractWithFallback(url, headers = {}) {
  let first = extractListing((await get(url, headers)).text);
  
  // If placeId or hexId is present and ratings/reviews are missing, fetch exact place details
  if (first && (first.placeId || first.hexId) && (first.rating === null || first.reviewCount === null || !first.address)) {
    try {
      const placeQueryUrl = first.placeId
        ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(first.placeId)}`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(first.name || '')}&query_place_id=${encodeURIComponent(first.hexId)}`;
      const pPage = (await get(placeQueryUrl, headers)).text;
      const subPreviewUrl = previewUrlFromPage(pPage);
      if (subPreviewUrl) {
        const detailed = extractListing((await get(subPreviewUrl, headers)).text);
        if (detailed && detailed.name && recordCompleteness(detailed) >= recordCompleteness(first)) {
          first = detailed;
        }
      }
    } catch {}
  }

  if (recordCompleteness(first) >= 4) return first;

  try {
    const retryUrl = new URL(url);
    retryUrl.searchParams.set('_extractRetry', Date.now().toString());
    const second = extractListing((await get(retryUrl, headers)).text);
    return recordCompleteness(second) > recordCompleteness(first) ? second : first;
  } catch { return first; }
}

async function resolveListing(input) {
  assertGoogleUrl(input);
  const resolved = await get(input);
  const resolvedUrl = new URL(resolved.url);

  let hl = resolvedUrl.searchParams.get('hl');
  let gl = resolvedUrl.searchParams.get('gl');
  if (!gl && hl && hl.includes('-')) {
    gl = hl.split('-')[1].toLowerCase();
  }

  const kgmid = resolvedUrl.searchParams.get('kgmid');
  const kgs = resolvedUrl.searchParams.get('kgs');
  const query = resolvedUrl.searchParams.get('q');

  const reqHeaders = {};
  if (hl) reqHeaders['accept-language'] = `${hl},en;q=0.9`;

  let mapsPage = resolved.text;
  let previewUrl = previewUrlFromPage(mapsPage);
  let searchUrl = mapSearchUrlFromPage(mapsPage);

  // If redirected to Google Search, use Maps lookup with query, kgmid, locale
  if (resolvedUrl.pathname === '/search' && query) {
    const lookup = mapsLookupUrl({ query, kgs, kgmid, hl, gl });
    mapsPage = (await get(lookup, reqHeaders)).text;
    previewUrl = previewUrlFromPage(mapsPage);
    searchUrl = mapSearchUrlFromPage(mapsPage);
  }

  if (!previewUrl && !searchUrl && query) {
    const lookup = mapsLookupUrl({ query, kgs, kgmid, hl, gl });
    mapsPage = (await get(lookup, reqHeaders)).text;
    previewUrl = previewUrlFromPage(mapsPage);
    searchUrl = mapSearchUrlFromPage(mapsPage);
  }

  let finalListing = null;
  if (previewUrl) {
    finalListing = await extractWithFallback(previewUrl, reqHeaders);
  } else if (searchUrl) {
    finalListing = await extractWithFallback(searchUrl, reqHeaders);
  }

  if (!finalListing || !finalListing.name) {
    throw new Error('Google did not return a public Maps listing for this link.');
  }

  delete finalListing._placeUrl;
  delete finalListing.placeId;
  delete finalListing.hexId;
  return finalListing;
}

function serveStatic(req, res) {
  const requestPath = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.resolve(root, `.${requestPath}`);
  if (!filePath.startsWith(root + path.sep) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, { 'content-type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream', ...securityHeaders() });
  fs.createReadStream(filePath).pipe(res);
}

async function requestHandler(req, res) {
  if (req.method === 'POST' && req.url === '/extract') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 10000) req.destroy(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        if (!payload || typeof payload.url !== 'string' || payload.url.length > 4096) throw new Error('Please enter a valid Google Maps or Business Profile link.');
        json(res, 200, await resolveListing(payload.url));
      }
      catch (error) { json(res, 400, { message: error.message || 'Unable to read this public listing.' }); }
    });
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405); res.end('Method not allowed');
}

if (require.main === module) {
  http.createServer(requestHandler).listen(port, () => console.log(`Business Data Extractor running at http://localhost:${port}`));
}

module.exports = { resolveListing };
