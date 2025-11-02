const path = require('path');
const fs = require('fs/promises');
const JSZip = require('jszip');

const {
  parseContentXml,
  checkRootElement,
  checkNavStructures,
  checkPagePresence,
  validateStructuralIntegrity,
  extractMetadata,
  extractResourcePaths,
  findMissingResources
} = require('../src/validator.js');
const { buildFileRecords, hasIndexHtml } = require('../src/viewer-utils.js');

describe('ELPX fixture integration', () => {
  let zip;
  let manifestDoc;
  let manifestXml;
  let metadata;

  beforeAll(async () => {
    const fixturePath = path.join(
      __dirname,
      '..',
      'tests',
      'fixtures',
      'un-contenido-de-ejemplo-para-probar-estilos-y-catalogacion.elpx'
    );
    const archive = await fs.readFile(fixturePath);
    zip = await JSZip.loadAsync(archive);

    const manifestEntry = zip.file('content.xml');
    if (!manifestEntry) {
      throw new Error('Fixture archive is missing content.xml');
    }

    manifestXml = await manifestEntry.async('string');
    const parseResult = parseContentXml(manifestXml);
    if (parseResult.status !== 'success') {
      throw new Error(`Unable to parse fixture manifest: ${parseResult.message}`);
    }

    manifestDoc = parseResult.document;
    metadata = extractMetadata(manifestDoc);
  });

  test('fixture manifest passes structural validations', () => {
    expect(checkRootElement(manifestDoc).status).toBe('success');
    expect(checkNavStructures(manifestDoc).status).toBe('success');
    expect(checkPagePresence(manifestDoc).status).toBe('success');
    expect(validateStructuralIntegrity(manifestDoc).status).toBe('success');

    expect(metadata.properties.pp_title).toBe(
      'Un contenido de ejemplo para probar estilos y catalogación'
    );
    expect(metadata.properties.pp_lang).toBe('es');
    expect(metadata.properties.pp_author).toBe('Ignacio Gros');
    expect(metadata.resources.odeVersionName).toBe('1');
  });

  test('fixture archive exposes all referenced resources', async () => {
    const normalizedManifest = manifestXml.replace(/{{context_path}}/g, 'content/resources');
    const normalizedParse = parseContentXml(normalizedManifest);
    expect(normalizedParse.status).toBe('success');

    const resourcePaths = extractResourcePaths(normalizedParse.document);
    const resolvedPaths = resourcePaths.flatMap((candidate) => {
      if (zip.file(candidate)) {
        return [candidate];
      }
      const match = candidate.match(/(content|custom)\/[^\s"'<>]+/);
      return match ? [match[0]] : [];
    });

    expect(resolvedPaths.length).toBeGreaterThan(0);

    const missing = findMissingResources(resolvedPaths, zip);
    expect(missing).toHaveLength(0);

    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    const { fileMap, fileList, totalSize } = await buildFileRecords(entries);

    expect(totalSize).toBeGreaterThan(0);
    expect(fileList.length).toBe(entries.length);

    expect(hasIndexHtml(fileMap)).toBe(true);
    expect(fileMap.has('content.xml')).toBe(true);

    const indexRecord = fileMap.get('index.html');
    expect(indexRecord.mimeType).toBe('text/html');
    expect(indexRecord.size).toBeGreaterThan(0);
  });
});
