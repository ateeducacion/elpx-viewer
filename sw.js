const SESSION_TTL = 30 * 60 * 1000; // 30 minutes
const sessions = new Map();

export function parsePreviewRequest(url) {
  const { pathname, origin } = url instanceof URL ? url : new URL(url);
  const previewPrefix = '/preview/';
  if (!pathname.startsWith(previewPrefix)) {
    return null;
  }
  const remainder = pathname.slice(previewPrefix.length);
  const [sessionId, ...rest] = remainder.split('/');
  if (!sessionId || rest.length === 0) {
    return null;
  }
  const path = rest.join('/') || 'index.html';
  return { sessionId, path, origin };
}

function cleanStaleSessions() {
  const now = Date.now();
  [...sessions.entries()].forEach(([sessionId, data]) => {
    if (now - data.updatedAt > SESSION_TTL) {
      sessions.delete(sessionId);
    }
  });
}

function storeSession(sessionId, files) {
  const fileMap = new Map();
  files.forEach((file) => {
    if (!file.path || !file.blob) {
      return;
    }
    fileMap.set(file.path, {
      blob: file.blob,
      mimeType: file.mimeType || 'application/octet-stream',
      lastModified: file.lastModified || Date.now()
    });
  });
  sessions.set(sessionId, { files: fileMap, updatedAt: Date.now() });
  cleanStaleSessions();
}

const scope = typeof self !== 'undefined' ? self : null;

if (scope) {
  scope.addEventListener('install', (event) => {
    event.waitUntil(scope.skipWaiting());
  });

  scope.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      cleanStaleSessions();
      await scope.clients.claim();
    })());
  });

  scope.addEventListener('message', (event) => {
    const { data } = event;
    if (!data) {
      return;
    }
    if (data.type === 'register-session') {
      if (!data.sessionId || !Array.isArray(data.files)) {
        return;
      }
      storeSession(data.sessionId, data.files);
    } else if (data.type === 'cleanup-sessions') {
      cleanStaleSessions();
    } else if (data.type === 'invalidate-session' && data.sessionId) {
      sessions.delete(data.sessionId);
    }
  });

  scope.addEventListener('fetch', (event) => {
    const requestUrl = new URL(event.request.url);
    if (requestUrl.origin !== scope.location.origin) {
      return;
    }
    const parsed = parsePreviewRequest(requestUrl);
    if (!parsed) {
      return;
    }

    event.respondWith((async () => {
      const session = sessions.get(parsed.sessionId);
      if (!session) {
        return new Response('Not found', { status: 404 });
      }
      session.updatedAt = Date.now();
      const record = session.files.get(parsed.path) || session.files.get(decodeURIComponent(parsed.path));
      if (!record) {
        return new Response('Not found', { status: 404 });
      }
      return new Response(record.blob, {
        status: 200,
        headers: {
          'Content-Type': record.mimeType,
          'Cache-Control': 'no-store'
        }
      });
    })());
  });

  scope.addEventListener('periodicsync', cleanStaleSessions);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parsePreviewRequest };
}
