const {
  detectFileType,
  inferMimeType,
  hasIndexHtml,
  buildFileRecords
} = require('../src/viewer-utils.js');

describe('Viewer helpers', () => {
  function createEntry(name, content = '') {
    return {
      name,
      dir: false,
      date: new Date('2024-01-01T00:00:00Z'),
      async: jest.fn((type) => {
        expect(type).toBe('blob');
        return Promise.resolve(new Blob([content], { type: 'text/plain' }));
      })
    };
  }

  test('detectFileType accepts .elpx and rejects unsupported extensions', () => {
    expect(detectFileType('lesson.elpx')).toBe('elpx');
    expect(detectFileType('package.elp')).toBe('elp');
    expect(detectFileType('notes.txt')).toBeNull();
  });

  test('buildFileRecords produces a map with blobs and metadata', async () => {
    const entries = [
      createEntry('index.html', '<html></html>'),
      createEntry('content/script.js', 'console.log("ok")')
    ];
    const { fileMap, fileList, totalSize } = await buildFileRecords(entries, () => {});
    expect(fileMap.size).toBe(2);
    expect(hasIndexHtml(fileMap)).toBe(true);
    expect(fileList[0]).toEqual(expect.objectContaining({ path: 'index.html', mimeType: 'text/html' }));
    expect(totalSize).toBeGreaterThan(0);
  });

  test('hasIndexHtml detects missing entry', () => {
    const map = new Map();
    map.set('content/index.html', {});
    expect(hasIndexHtml(map)).toBe(false);
  });

  test('inferMimeType returns expected MIME types', () => {
    expect(inferMimeType('index.html')).toBe('text/html');
    expect(inferMimeType('assets/style.css')).toBe('text/css');
    expect(inferMimeType('media/video.unknown')).toBe('application/octet-stream');
  });
});
