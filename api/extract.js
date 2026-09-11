const { resolveListing } = require('../server');

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10000) reject(new Error('Request is too large.'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { reject(new Error('Please send a valid request.')); }
    });
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendJson(res, 405, { message: 'Method not allowed.' });
    return;
  }

  try {
    const payload = await readBody(req);
    if (!payload || typeof payload.url !== 'string' || payload.url.length > 4096) {
      throw new Error('Please enter a valid Google Maps or Business Profile link.');
    }
    sendJson(res, 200, await resolveListing(payload.url));
  } catch (error) {
    sendJson(res, 400, { message: error.message || 'Unable to read this public listing.' });
  }
};
