// A route that changes something requires its method, a same-origin caller and a declared
// content type that requires a browser preflight. The three together are what a page you merely visit cannot produce.

export function originAllowed(req) {
  const origin = req.headers.origin;
  // No origin is not a browser, and the capture-node link's server-side fetches send none.
  if (!origin) return true;
  // Node discards duplicate Host headers, so a second one survives only in rawHeaders.
  const raw = req.rawHeaders ?? [];
  let hostCount = 0;
  for (let i = 0; i < raw.length; i += 2) if (String(raw[i]).toLowerCase() === 'host') hostCount++;
  if (hostCount > 1) return false;
  const rawHost = req.headers.host;
  if (typeof rawHost !== 'string' || rawHost === '') return false;

  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    // `null` is what a sandboxed iframe and a `file://` page send, and it is not a
    // URL. Neither is same-origin with anything.
    return false;
  }

  // A Host header is an authority and nothing else; unchecked the parser eats userinfo or
  // a path. Both sides then compare through the URL parser, scheme included.
  if (/[@/?#\s\\]/.test(rawHost)) return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${rawHost}`);
  } catch {
    return false;
  }
  if (hostUrl.host === '') return false;
  if (hostUrl.pathname !== '/' || hostUrl.search !== '' || hostUrl.username !== '' || hostUrl.password !== '') {
    return false;
  }
  // DNS rebinding: a name re-resolved onto this server makes both headers agree, so a
  // browser has to have arrived at an address. localhost and .local cannot be rebound.
  const { hostname } = hostUrl;
  const isAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[');
  if (!isAddress && hostname !== 'localhost' && !hostname.endsWith('.local')) return false;
  return originUrl.protocol === 'http:' && originUrl.host === hostUrl.host;
}

// A content type a hostile page cannot set without a preflight.
const JSON_TYPE = /^application\/json\s*(?:;|$)/i;

// A cross-origin <img> sends no Origin at all, so only Sec-Fetch-Site separates it from
// the peer node. An absent header passes: a non-browser caller sends nothing.
export function sameOriginBrowser(req) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site !== 'string' || site === '') return true;
  return site === 'same-origin' || site === 'none';
}

export function requireMutation(req, res, methods, contentType = 'application/json') {
  // Origin first, and before the body: a refused request should not stream megabytes in.
  if (!originAllowed(req)) {
    refuse(res, 403, `${req.headers.origin} is not this server, and this route changes something`);
    return false;
  }
  if (!methods.includes(req.method)) {
    res.setHeader('Allow', methods.join(', '));
    refuse(res, 405, `${req.method} is not how this route is called: it changes something, so it takes ${methods.join(' or ')}`);
    return false;
  }
  const typeRule = contentType === 'application/octet-stream'
    ? /^application\/octet-stream\s*(?:;|$)/i : JSON_TYPE;
  if (!typeRule.test(req.headers['content-type'] ?? '')) {
    refuse(res, 415, `this route changes something, so it takes a request declaring ${contentType}`);
    return false;
  }
  return true;
}

function refuse(res, status, message) {
  const text = Buffer.from(JSON.stringify({ error: message }));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': text.length,
    'Cache-Control': 'no-cache',
  });
  res.end(text);
}
