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
const MIME_TYPES = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8' };

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...securityHeaders() });
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

function assertGoogleUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Please enter a valid Google Maps or Business Profile link.'); }
  const host = parsed.hostname.toLowerCase();
  const isGoogle = host === 'share.google' || host.endsWith('.share.google') || host === 'goo.gl' || host.endsWith('.goo.gl') || host === 'g.page' || host.endsWith('.g.page') || host === 'g.co' || host.endsWith('.g.co') || host === 'maps.app.goo.gl' || host.endsWith('.google.com');
  if (!isGoogle || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('Please enter a Google Maps or Business Profile link.');
  return parsed;
}

async function get(url) {
  const response = await fetch(url, { headers: GOOGLE_HEADERS, redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('Google could not open this listing. Please try the link again.');
  return { url: response.url, text: await response.text() };
}

function previewUrlFromPage(html) {
  const match = html.match(/<link href="([^"]*\/maps\/preview\/place[^"]*)/i);
  return match ? `https://www.google.com${match[1].replace(/&amp;/g, '&')}` : null;
}

function mapSearchUrlFromPage(html) {
  const match = html.match(/<link href="([^\"]*\/search\?tbm=map[^\"]*)/i);
  return match ? `https://www.google.com${match[1].replace(/&amp;/g, '&')}` : null;
}

function recordCompleteness(record) {
  return [record.address, record.phones.length, record.rating, record.reviewCount, record.website]
    .filter((value) => value !== null && value !== undefined && value !== '' && value !== 0).length;
}

function extractListing(page) {
  const placeMatch = page.match(/"(0x[0-9a-f]+:0x[0-9a-f]+)","((?:\\.|[^"\\])+)"/i);
  const name = placeMatch ? decodeGoogleString(placeMatch[2]) : null;
  const addressPattern = name ? new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},\\s*([^\"]+)"`) : null;
  const addressMatch = addressPattern && page.match(addressPattern);
  const address = addressMatch ? `${name}, ${decodeGoogleString(addressMatch[1])}` : null;
  const ratingAndReviews = page.match(/"([\d,]+) reviews"[\s\S]{0,140}?\b([1-5](?:\.\d)?)\s*,\s*([\d,]+)\s*,/i);
  const reviewLabel = page.match(/"([\d,]+) reviews"/i);
  const ratingNearReview = reviewLabel && page.slice(reviewLabel.index, reviewLabel.index + 400).match(/,([1-5](?:\.\d)?),([\d,]+),/);
  const phoneMatches = [...page.matchAll(/\[\["([^"\\]+)",\d+\],\["([^"\\]+)",\d+\]\]/g)]
    .map((match) => decodeGoogleString(match[2]))
    .filter((phone) => /\d{5,}/.test(phone));
  const phones = [...new Set(phoneMatches)];
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
  };
}

async function extractWithFallback(url) {
  const first = extractListing((await get(url)).text);
  // Anonymous Google requests can return a partial payload. Retry once and
  // retain whichever response contains the most public listing fields.
  if (recordCompleteness(first) >= 4) return first;
  try {
    const retryUrl = new URL(url);
    retryUrl.searchParams.set('_extractRetry', Date.now().toString());
    const second = extractListing((await get(retryUrl)).text);
    return recordCompleteness(second) > recordCompleteness(first) ? second : first;
  } catch { return first; }
}

async function resolveListing(input) {
  assertGoogleUrl(input);
  const resolved = await get(input);
  const resolvedUrl = new URL(resolved.url);

  // Google Share links land on a Search result. Use that result's query to
  // request Maps' public result payload directly; Search HTML can contain
  // unrelated preview links.
  if (resolvedUrl.pathname === '/search' && resolvedUrl.searchParams.has('q')) {
    const mapsPage = (await get(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(resolvedUrl.searchParams.get('q'))}`)).text;
    const searchUrl = mapSearchUrlFromPage(mapsPage);
    if (!searchUrl) throw new Error('Google did not return a public Maps listing for this link.');
    return extractWithFallback(searchUrl);
  }

  let mapsPage = resolved.text;
  let previewUrl = previewUrlFromPage(mapsPage);

  // share.google links resolve to a Google Search result. Its q parameter is
  // enough to open the same public Maps listing without an API or API key.
  if (!previewUrl) {
    const query = new URL(resolved.url).searchParams.get('q');
    if (!query) throw new Error('This Google link did not contain a public business listing.');
    mapsPage = (await get(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`)).text;
    previewUrl = previewUrlFromPage(mapsPage);
    // Search result pages contain a public Maps search endpoint. Unlike the
    // rendered page, it has the result data in its response body.
    if (!previewUrl) {
      const searchUrl = mapSearchUrlFromPage(mapsPage);
      if (searchUrl) return extractWithFallback(searchUrl);
    }
  }
  if (!previewUrl) throw new Error('Google did not return a public Maps listing for this link.');
  return extractWithFallback(previewUrl);
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
