import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
import {
  checkNavStructures,
  checkPagePresence,
  checkRootElement,
  extractMetadata,
  extractLegacyMetadata,
  extractResourcePaths,
  findMissingResources,
  normalizeLegacyMetadata,
  parseContentXml,
  validateStructuralIntegrity
} from './validator.js';
import { InfoPanel, formatBytes } from './info.js';
import { GitHubPublisher } from './github.js';
import {
  detectFileType,
  inferMimeType,
  hasIndexHtml,
  buildFileRecords
} from './viewer-utils.js';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const previewFrame = document.getElementById('previewFrame');
const previewPlaceholder = document.getElementById('previewPlaceholder');
const statusMessage = document.getElementById('statusMessage');
const toastContainer = document.getElementById('toastContainer');
const publishButton = document.getElementById('publishButton');

const infoPanel = new InfoPanel(document.getElementById('infoContent'));
let githubPublisher = null;
let currentSession = null;

function postToServiceWorker(message) {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  const controller = navigator.serviceWorker.controller;
  if (controller) {
    controller.postMessage(message);
  }
}

function releaseCurrentSession() {
  if (currentSession?.sessionId) {
    postToServiceWorker({ type: 'invalidate-session', sessionId: currentSession.sessionId });
  }
  currentSession = null;
}

function updateStatus(message) {
  if (!statusMessage) return;
  statusMessage.textContent = message || '';
}

function setPreviewState({ showFrame, src }) {
  if (!previewFrame || !previewPlaceholder) {
    return;
  }
  if (showFrame) {
    previewPlaceholder.hidden = true;
    previewFrame.hidden = false;
    if (src) {
      previewFrame.src = src;
    }
  } else {
    previewFrame.hidden = true;
    previewPlaceholder.hidden = false;
    if (previewFrame.src) {
      previewFrame.src = 'about:blank';
    }
  }
}

function showToast(message, variant = 'danger') {
  if (!toastContainer || typeof bootstrap === 'undefined') {
    console.error(message);
    return;
  }
  const toast = document.createElement('div');
  toast.className = `toast align-items-center text-bg-${variant} border-0`;
  toast.role = 'alert';
  toast.ariaLive = 'assertive';
  toast.ariaAtomic = 'true';
  toast.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${message}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>
  `;
  toastContainer.appendChild(toast);
  const bsToast = new bootstrap.Toast(toast, { autohide: true, delay: 5000 });
  bsToast.show();
  toast.addEventListener('hidden.bs.toast', () => {
    toast.remove();
  });
}

function createSessionId() {
  if (crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function buildFileMap(zip, onProgress = () => {}) {
  const entries = Object.values(zip.files).filter((file) => !file.dir);
  return buildFileRecords(entries, onProgress);
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.register('sw.js', { type: 'module' });
    return registration;
  } catch (error) {
    console.error('Service worker registration failed', error);
    return null;
  }
}

async function ensureServiceWorkerController() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service workers are not supported in this browser.');
  }
  if (navigator.serviceWorker.controller) {
    return navigator.serviceWorker.controller;
  }
  await new Promise((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
  });
  if (!navigator.serviceWorker.controller) {
    throw new Error('Unable to obtain service worker controller.');
  }
  return navigator.serviceWorker.controller;
}

function computeCompatibility(metadata) {
  const versionSource = metadata?.resources?.odeVersionName || metadata?.properties?.version || '';
  const versionMatch = versionSource.match(/(\d+)(?:\.(\d+))?/);
  const major = versionMatch ? Number.parseInt(versionMatch[1], 10) : null;
  if (major && major <= 2) {
    return { isUnsupported: true, versionLabel: versionSource || '2.x' };
  }
  return { isUnsupported: false, versionLabel: versionSource || '' };
}

function gatherMessages(manifestKind, xmlDoc, zip) {
  const messages = [];
  if (manifestKind === 'legacy') {
    messages.push({ level: 'warning', text: 'Legacy manifest format detected. Structural validation checks were skipped.' });
    return messages;
  }

  const rootResult = checkRootElement(xmlDoc);
  messages.push({ level: rootResult.status === 'success' ? 'info' : 'error', text: rootResult.message });
  if (rootResult.status === 'error') {
    return messages;
  }

  const navResult = checkNavStructures(xmlDoc);
  messages.push({ level: navResult.status === 'success' ? 'info' : 'error', text: navResult.message });
  if (navResult.status === 'error') {
    return messages;
  }

  const pagesResult = checkPagePresence(xmlDoc);
  messages.push({ level: pagesResult.status === 'success' ? 'info' : pagesResult.status, text: pagesResult.message });

  const structureResult = validateStructuralIntegrity(xmlDoc);
  messages.push({ level: structureResult.status === 'success' ? 'info' : 'error', text: structureResult.message });

  const resourcePaths = extractResourcePaths(xmlDoc);
  const missingResources = findMissingResources(resourcePaths, zip);
  if (missingResources.length > 0) {
    const preview = missingResources.slice(0, 5).join(', ');
    messages.push({
      level: 'warning',
      text: `Missing ${missingResources.length} referenced resource${missingResources.length === 1 ? '' : 's'} (first: ${preview}${missingResources.length > 5 ? ', …' : ''}).`
    });
  } else if (resourcePaths.length > 0) {
    messages.push({ level: 'info', text: `All ${resourcePaths.length} linked resources are present.` });
  } else {
    messages.push({ level: 'info', text: 'No linked resources were detected in the manifest.' });
  }

  return messages;
}

function warnLargeArchive(totalSize) {
  const limit = 200 * 1024 * 1024;
  if (totalSize > limit) {
    showToast('This archive is larger than 200 MB. Preview and publish operations may be slow.', 'warning');
  }
}

function resetInterface() {
  updateStatus('');
  setPreviewState({ showFrame: false });
  infoPanel.update({ status: 'idle' });
  releaseCurrentSession();
  if (publishButton) {
    publishButton.classList.add('d-none');
    publishButton.disabled = true;
  }
  if (githubPublisher) {
    githubPublisher.clearArchive();
  }
}

async function handleElpxFile(file) {
  updateStatus('Unzipping archive…');
  infoPanel.update({ status: 'loading' });

  let zip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch (error) {
    console.error(error);
    throw new Error('The file could not be read as a ZIP archive.');
  }

  const manifestFile = zip.file('content.xml') || zip.file('contentv3.xml');
  if (!manifestFile) {
    throw new Error('Missing content.xml in the ELPX archive.');
  }
  const manifestKind = zip.file('content.xml') ? 'modern' : 'legacy';

  const contentString = await manifestFile.async('string');
  const parseResult = parseContentXml(contentString);
  if (parseResult.status === 'error') {
    throw new Error(parseResult.message);
  }

  const xmlDoc = parseResult.document;
  const metadata = manifestKind === 'legacy'
    ? normalizeLegacyMetadata(extractLegacyMetadata(xmlDoc))
    : extractMetadata(xmlDoc);

  const { isUnsupported, versionLabel } = computeCompatibility(metadata);

  const { fileMap, fileList, totalSize } = await buildFileMap(zip, (current, total) => {
    updateStatus(`Preparing preview… ${current}/${total}`);
  });
  warnLargeArchive(totalSize);

  if (!hasIndexHtml(fileMap)) {
    throw new Error('The archive does not contain an index.html file.');
  }

  const sessionId = createSessionId();

  await ensureServiceWorkerController();
  postToServiceWorker({
    type: 'register-session',
    sessionId,
    files: Array.from(fileMap.entries()).map(([path, record]) => ({
      sessionId,
      path,
      mimeType: record.mimeType,
      lastModified: record.lastModified,
      blob: record.blob
    }))
  });

  setPreviewState({ showFrame: true, src: `/preview/${sessionId}/index.html` });
  updateStatus('Preview ready.');

  const messages = gatherMessages(manifestKind, xmlDoc, zip);
  if (isUnsupported) {
    messages.unshift({
      level: 'warning',
      text: 'The manifest reports ELP v2. Preview is available, but publishing may require manual verification.'
    });
  }

  currentSession = {
    sessionId,
    fileName: file.name,
    fileSize: file.size,
    fileType: 'elpx',
    metadata,
    manifestKind,
    startFile: 'index.html',
    fileMap,
    fileList,
    summary: { totalFiles: fileList.length, totalSize },
    messages,
    versionLabel
  };

  infoPanel.update({
    status: 'ready',
    fileName: file.name,
    fileSize: file.size,
    fileType: 'elpx',
    elpVersion: versionLabel,
    metadata,
    manifestKind,
    startFile: 'index.html',
    fileList,
    summary: { totalFiles: fileList.length, totalSize },
    messages,
    downloadable: true
  });
  infoPanel.setDownloadHandler(() => downloadFileList(currentSession));

  if (publishButton) {
    publishButton.classList.remove('d-none');
    publishButton.disabled = false;
    publishButton.removeAttribute('aria-disabled');
  }

  if (githubPublisher) {
    githubPublisher.setArchive(currentSession, isUnsupported);
  }
}

async function handleElpFile(file) {
  updateStatus('Reading package…');
  infoPanel.update({ status: 'loading' });

  let zip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch (error) {
    console.error(error);
    throw new Error('The file could not be read as a ZIP archive.');
  }

  const manifestFile = zip.file('content.xml') || zip.file('contentv3.xml');
  if (!manifestFile) {
    throw new Error('Unable to find content.xml in the ELP archive.');
  }
  const manifestKind = zip.file('content.xml') ? 'modern' : 'legacy';

  const contentString = await manifestFile.async('string');
  const parseResult = parseContentXml(contentString);
  if (parseResult.status === 'error') {
    throw new Error(parseResult.message);
  }

  const xmlDoc = parseResult.document;
  const metadata = manifestKind === 'legacy'
    ? normalizeLegacyMetadata(extractLegacyMetadata(xmlDoc))
    : extractMetadata(xmlDoc);

  const { isUnsupported, versionLabel } = computeCompatibility(metadata);

  setPreviewState({ showFrame: false });
  infoPanel.update({
    status: isUnsupported ? 'unsupported' : 'ready',
    fileName: file.name,
    fileSize: file.size,
    fileType: 'elp',
    elpVersion: versionLabel,
    metadata,
    manifestKind,
    startFile: 'index.html',
    fileList: [],
    summary: { totalFiles: 0, totalSize: 0 },
    messages: [{
      level: 'info',
      text: 'Upload an .elpx export to render the preview. Only metadata is available for .elp files.'
    }]
  });
  infoPanel.setDownloadHandler(null);

  if (publishButton) {
    publishButton.classList.add('d-none');
    publishButton.disabled = true;
  }

  if (isUnsupported) {
    showToast('ELP v2 packages are not supported by the viewer.', 'warning');
  }
}

function downloadFileList(session) {
  if (!session?.fileList?.length) {
    return;
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    fileName: session.fileName,
    totalFiles: session.fileList.length,
    totalSize: session.summary?.totalSize || 0,
    files: session.fileList
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${session.fileName.replace(/\.[^.]+$/, '')}-inventory.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function handleFile(file) {
  if (!file) {
    return;
  }
  const fileType = detectFileType(file.name);
  if (!fileType) {
    showToast('Please choose a .elp or .elpx file.', 'warning');
    return;
  }

  try {
    if (githubPublisher && githubPublisher.isPublishing()) {
      githubPublisher.cancelPublish('File selection changed.');
    }
    if (previewFrame) {
      setPreviewState({ showFrame: false });
    }
    releaseCurrentSession();
    if (publishButton) {
      publishButton.classList.add('d-none');
      publishButton.disabled = true;
    }
    if (githubPublisher) {
      githubPublisher.clearArchive();
    }
    if (fileType === 'elpx') {
      await handleElpxFile(file);
    } else {
      await handleElpFile(file);
    }
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Unable to load the selected file.');
    infoPanel.update({ status: 'error', error: error.message });
    setPreviewState({ showFrame: false });
    updateStatus('');
    if (publishButton) {
      publishButton.classList.add('d-none');
      publishButton.disabled = true;
    }
  }
}

function setupDragAndDrop() {
  if (!dropzone || !fileInput) {
    return;
  }

  const preventDefault = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  ['dragenter', 'dragover'].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      preventDefault(event);
      dropzone.classList.add('is-dragover');
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      preventDefault(event);
      dropzone.classList.remove('is-dragover');
    });
  });

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });

  dropzone.addEventListener('drop', (event) => {
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      void handleFile(files[0]);
    }
  });

  fileInput.addEventListener('change', (event) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      void handleFile(files[0]);
      fileInput.value = '';
    }
  });
}

async function initialise() {
  resetInterface();
  setupDragAndDrop();
  await registerServiceWorker();
  try {
    await ensureServiceWorkerController();
  } catch (error) {
    showToast('Preview service worker could not start. Reload the page to enable previews.', 'danger');
  }

  postToServiceWorker({ type: 'cleanup-sessions' });

  const modalElement = document.getElementById('publishModal');
  if (publishButton && modalElement) {
    githubPublisher = new GitHubPublisher({
      button: publishButton,
      modalElement,
      toast: showToast,
      formatBytes
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialise, { once: true });
} else {
  void initialise();
}

export { detectFileType, inferMimeType, hasIndexHtml } from './viewer-utils.js';
