const { parsePreviewRequest } = require('../sw.js');

describe('Service worker helpers', () => {
  test('parsePreviewRequest extracts session id and path', () => {
    const url = new URL('https://example.com/preview/abc123/index.html');
    const result = parsePreviewRequest(url);
    expect(result).toEqual({
      sessionId: 'abc123',
      path: 'index.html',
      origin: 'https://example.com'
    });
  });

  test('parsePreviewRequest handles nested paths', () => {
    const url = new URL('https://example.com/preview/xyz/assets/style.css');
    const result = parsePreviewRequest(url);
    expect(result.sessionId).toBe('xyz');
    expect(result.path).toBe('assets/style.css');
  });

  test('parsePreviewRequest returns null for unrelated routes', () => {
    const result = parsePreviewRequest(new URL('https://example.com/assets/app.js'));
    expect(result).toBeNull();
  });

  test('parsePreviewRequest honours base path', () => {
    const url = new URL('https://example.com/app/preview/foo/index.html');
    const result = parsePreviewRequest(url, { basePath: '/app/' });
    expect(result).toEqual({ sessionId: 'foo', path: 'index.html', origin: 'https://example.com' });
  });
});
