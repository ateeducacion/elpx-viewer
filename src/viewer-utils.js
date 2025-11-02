const MIME_LOOKUP = new Map([
  ['html', 'text/html'],
  ['htm', 'text/html'],
  ['css', 'text/css'],
  ['js', 'application/javascript'],
  ['mjs', 'application/javascript'],
  ['json', 'application/json'],
  ['svg', 'image/svg+xml'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['ico', 'image/x-icon'],
  ['mp3', 'audio/mpeg'],
  ['ogg', 'audio/ogg'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['wasm', 'application/wasm'],
  ['xml', 'application/xml'],
  ['woff', 'font/woff'],
  ['woff2', 'font/woff2'],
  ['txt', 'text/plain'],
  ['pdf', 'application/pdf']
]);

const SUPPORTED_EXTENSIONS = new Set(['elp', 'elpx']);

function getExtension(name = '') {
  const match = /\.([^.]+)$/.exec(name.toLowerCase());
  return match ? match[1] : '';
}

export function detectFileType(name) {
  const ext = getExtension(name);
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return null;
  }
  return ext;
}

export function inferMimeType(path) {
  const ext = getExtension(path);
  if (!ext) return 'application/octet-stream';
  return MIME_LOOKUP.get(ext) || 'application/octet-stream';
}

export function hasIndexHtml(fileMap) {
  if (!fileMap) {
    return false;
  }
  if (fileMap instanceof Map) {
    return fileMap.has('index.html');
  }
  return Object.prototype.hasOwnProperty.call(fileMap, 'index.html');
}

function fileEntryToRecord(entry, blob) {
  return {
    path: entry.name,
    size: blob.size,
    mimeType: inferMimeType(entry.name),
    lastModified: entry.date ? entry.date.getTime() : Date.now(),
    blob
  };
}

async function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function buildFileRecords(entries, onProgress = () => {}) {
  const fileMap = new Map();
  const fileList = [];
  let totalSize = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.dir) {
      continue;
    }
    const blob = await entry.async('blob');
    const record = fileEntryToRecord(entry, blob);
    totalSize += record.size;
    fileMap.set(entry.name, record);
    fileList.push({ path: record.path, size: record.size, mimeType: record.mimeType });
    onProgress(index + 1, entries.length, record.path);
    if ((index + 1) % 25 === 0) {
      await yieldToBrowser();
    }
  }

  return { fileMap, fileList, totalSize };
}

export { SUPPORTED_EXTENSIONS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    detectFileType,
    inferMimeType,
    hasIndexHtml,
    buildFileRecords,
    SUPPORTED_EXTENSIONS
  };
}
