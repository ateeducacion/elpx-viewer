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
import { InfoPanel } from './info.js';
import { detectFileType, hasIndexHtml, buildFileRecords } from './viewer-utils.js';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const previewFrame = document.getElementById('previewFrame');
const previewPlaceholder = document.getElementById('previewPlaceholder');
const statusMessage = document.getElementById('statusMessage');
const toastContainer = document.getElementById('toastContainer');
const publishButton = document.getElementById('publishButton');
const uploadButton = document.getElementById('uploadButton');
const appHeader = document.getElementById('sdHeader');

const infoPanel = new InfoPanel(document.getElementById('infoContent'));
let currentSession = null;

const ERROR_SILENCE_PATTERNS = [/content-scripts\.js/i, /:has-text\(/i, /##body:has-text/i];

function getAppBaseUrl() {
  return new URL('./', window.location.href);
}

function postToServiceWorker(message) {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  const controller = navigator.serviceWorker.controller;
  if (controller) {
    controller.postMessage(message);
  }
}

async function registerPreviewSession(sessionId, files, transferList = []) {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    throw new Error('Preview service worker is not available.');
  }
  await new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.onmessage = null;
      console.warn('Preview session acknowledgement timed out. Proceeding anyway.');
      try {
        channel.port1.close();
      } catch {
        // ignore
      }
      resolve();
    }, SW_ACK_TIMEOUT);
    channel.port1.onmessage = (event) => {
      const { data } = event;
      if (!data || typeof data !== 'object') {
        return;
      }
      if (data.type === 'register-session:ready' && data.sessionId === sessionId) {
        clearTimeout(timer);
        channel.port1.onmessage = null;
        try {
          channel.port1.close();
        } catch {
          // ignore
        }
        resolve();
      } else if (data.type === 'register-session:error') {
        clearTimeout(timer);
        channel.port1.onmessage = null;
        try {
          channel.port1.close();
        } catch {
          // ignore
        }
        reject(new Error(data.message || 'The preview session could not be prepared.'));
      }
    };
    controller.postMessage(
      {
        type: 'register-session',
        sessionId,
        files,
        replyPort: channel.port2
      },
      [channel.port2, ...transferList]
    );
  });
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

function shouldSilenceError(source, message) {
  const haystack = `${source || ''} ${message || ''}`;
  return ERROR_SILENCE_PATTERNS.some((pattern) => pattern.test(haystack));
}

function installErrorGuards() {
  if (installErrorGuards.installed) {
    return;
  }
  window.addEventListener(
    'error',
    (event) => {
      if (shouldSilenceError(event.filename, event.message)) {
        event.preventDefault();
      }
    },
    true
  );
  window.addEventListener('unhandledrejection', (event) => {
    const reason =
      event.reason && typeof event.reason === 'object' ? event.reason.message : event.reason;
    if (shouldSilenceError('', String(reason || ''))) {
      event.preventDefault();
    }
  });
  installErrorGuards.installed = true;
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

function updateHeaderOffset() {
  if (!appHeader) {
    return;
  }
  const height = appHeader.offsetHeight;
  document.documentElement.style.setProperty('--sd-header-height', `${height}px`);
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

const GITHUB_TOKEN_KEY = 'github_device_token';
const GITHUB_USER_KEY = 'github_device_user';
const ENCODE_CHUNK_SIZE = 25;
const SW_ACK_TIMEOUT = 5000;
const SW_CONTROLLER_TIMEOUT = 6000;

function getStoredGitHubToken() {
  const directToken = window.APP_CONFIG?.githubToken;
  if (typeof directToken === 'string' && directToken.trim()) {
    return directToken.trim();
  }
  return sessionStorage.getItem(GITHUB_TOKEN_KEY) || '';
}

function clearStoredGitHubAuth(showNotice = false) {
  sessionStorage.removeItem(GITHUB_TOKEN_KEY);
  sessionStorage.removeItem(GITHUB_USER_KEY);
  if (showNotice) {
    showToast('Signed out from GitHub.', 'info');
  }
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

async function buildPublishFilesForSession(session) {
  if (!session?.fileMap || session.fileMap.size === 0) {
    return [];
  }
  if (Array.isArray(session.publishFiles) && session.publishFiles.length === session.fileMap.size) {
    return session.publishFiles;
  }
  if (!session.publishFilesPromise) {
    session.publishFilesPromise = (async () => {
      if (typeof window.logStep === 'function') {
        window.logStep('Preparing files…');
      }
      if (typeof window.setProgress === 'function') {
        window.setProgress(30, 'Preparing…');
      }
      const entries = Array.from(session.fileMap.entries());
      const files = [];
      for (let index = 0; index < entries.length; index += 1) {
        const [path, record] = entries[index];
        const base64Content = await blobToBase64(record.blob);
        files.push({ path, base64Content });
        if (typeof window.setProgress === 'function' && entries.length > 0) {
          const progress = 30 + Math.floor(((index + 1) / entries.length) * 5);
          window.setProgress(progress, 'Preparing…');
        }
        if ((index + 1) % ENCODE_CHUNK_SIZE === 0) {
          // Yield to keep the UI responsive for large archives.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      session.publishFiles = files;
      return files;
    })();
  }
  try {
    const files = await session.publishFilesPromise;
    session.publishFilesPromise = null;
    return files;
  } catch (error) {
    session.publishFilesPromise = null;
    throw error;
  }
}

function createSessionId() {
  if (crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function buildFileMap(zip, onProgress = () => {}) {
  const entries = Object.values(zip.files).filter((file) => !file.dir);
  let lastReport = Date.now();
  const wrappedOnProgress = (current, total, path) => {
    onProgress(current, total, path);
    const now = Date.now();
    if (now - lastReport > 5000) {
      console.info(`[preview] Prepared ${current}/${total}: ${path}`);
      lastReport = now;
    }
  };
  return buildFileRecords(entries, wrappedOnProgress);
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return null;
  }
  try {
    const swUrl = new URL('../sw.js', import.meta.url);
    const registration = await navigator.serviceWorker.register(swUrl.href, { type: 'module' });
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
    sessionStorage.removeItem('viewer-sw-reload');
    return navigator.serviceWorker.controller;
  }
  const reloadFlagKey = 'viewer-sw-reload';
  const awaitController = () =>
    new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const cleanup = () => {
        settled = true;
        navigator.serviceWorker.removeEventListener('controllerchange', onChange);
        clearTimeout(timer);
      };
      const onChange = () => {
        cleanup();
        resolve(navigator.serviceWorker.controller);
      };
      navigator.serviceWorker.addEventListener('controllerchange', onChange);

      navigator.serviceWorker.ready
        .then(() => {
          if (!settled && navigator.serviceWorker.controller) {
            cleanup();
            resolve(navigator.serviceWorker.controller);
          }
        })
        .catch((error) => {
          console.warn('navigator.serviceWorker.ready rejected', error);
        });

      timer = setTimeout(() => {
        cleanup();
        reject(new Error('Service worker did not take control in time.'));
      }, SW_CONTROLLER_TIMEOUT);
    });

  try {
    const controller = await awaitController();
    if (controller) {
      sessionStorage.removeItem(reloadFlagKey);
      return controller;
    }
  } catch (error) {
    console.warn(error.message);
  }

  if (!navigator.serviceWorker.controller) {
    const reloadAttempted = sessionStorage.getItem(reloadFlagKey) === '1';
    if (!reloadAttempted) {
      sessionStorage.setItem(reloadFlagKey, '1');
      console.info('Reloading the page so the preview service worker can take control.');
      window.location.reload();
      throw new Error('Reloading to allow service worker control.');
    }
    sessionStorage.removeItem(reloadFlagKey);
  }

  if (!navigator.serviceWorker.controller) {
    throw new Error('Unable to obtain service worker controller.');
  }
  sessionStorage.removeItem(reloadFlagKey);
  return navigator.serviceWorker.controller;
}

function computeCompatibility(metadata) {
  const versionSource = metadata?.resources?.odeVersionName || metadata?.properties?.version || '';
  return { isUnsupported: false, versionLabel: versionSource || '' };
}

function gatherMessages(manifestKind, xmlDoc, zip) {
  const messages = [];
  if (manifestKind === 'legacy') {
    messages.push({
      level: 'warning',
      text: 'Legacy manifest format detected. Structural validation checks were skipped.'
    });
    return messages;
  }

  const rootResult = checkRootElement(xmlDoc);
  messages.push({
    level: rootResult.status === 'success' ? 'info' : 'error',
    text: rootResult.message
  });
  if (rootResult.status === 'error') {
    return messages;
  }

  const navResult = checkNavStructures(xmlDoc);
  messages.push({
    level: navResult.status === 'success' ? 'info' : 'error',
    text: navResult.message
  });
  if (navResult.status === 'error') {
    return messages;
  }

  const pagesResult = checkPagePresence(xmlDoc);
  messages.push({
    level: pagesResult.status === 'success' ? 'info' : pagesResult.status,
    text: pagesResult.message
  });

  const structureResult = validateStructuralIntegrity(xmlDoc);
  messages.push({
    level: structureResult.status === 'success' ? 'info' : 'error',
    text: structureResult.message
  });

  const resourcePaths = extractResourcePaths(xmlDoc);
  const missingResources = findMissingResources(resourcePaths, zip);
  if (missingResources.length > 0) {
    const preview = missingResources.slice(0, 5).join(', ');
    messages.push({
      level: 'warning',
      text: `Missing ${missingResources.length} referenced resource${missingResources.length === 1 ? '' : 's'} (first: ${preview}${missingResources.length > 5 ? ', …' : ''}).`
    });
  } else if (resourcePaths.length > 0) {
    messages.push({
      level: 'info',
      text: `All ${resourcePaths.length} linked resources are present.`
    });
  } else {
    messages.push({ level: 'info', text: 'No linked resources were detected in the manifest.' });
  }

  return messages;
}

function warnLargeArchive(totalSize) {
  const limit = 200 * 1024 * 1024;
  if (totalSize > limit) {
    showToast(
      'This archive is larger than 200 MB. Preview and publish operations may be slow.',
      'warning'
    );
  }
}

function resetInterface() {
  updateStatus('');
  setPreviewState({ showFrame: false });
  infoPanel.update({ status: 'idle' });
  releaseCurrentSession();
  if (publishButton) {
    publishButton.disabled = true;
    publishButton.setAttribute('aria-disabled', 'true');
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
  const metadata =
    manifestKind === 'legacy'
      ? normalizeLegacyMetadata(extractLegacyMetadata(xmlDoc))
      : extractMetadata(xmlDoc);

  const { versionLabel } = computeCompatibility(metadata);

  const { fileMap, fileList, totalSize } = await buildFileMap(zip, (current, total, path) => {
    updateStatus(`Preparing preview… ${current}/${total}`);
    if ((current % 50 === 0 || current === total) && path) {
      console.info(`[preview] Extracted ${current}/${total}: ${path}`);
    }
  });
  warnLargeArchive(totalSize);

  if (!hasIndexHtml(fileMap)) {
    throw new Error('The archive does not contain an index.html file.');
  }

  const sessionId = createSessionId();

  await ensureServiceWorkerController();
  const sessionFiles = [];
  const transferList = [];
  const fileEntries = Array.from(fileMap.entries());
  for (let i = 0; i < fileEntries.length; i += 1) {
    const [path, record] = fileEntries[i];
    const buffer = await record.blob.arrayBuffer();
    sessionFiles.push({
      path,
      mimeType: record.mimeType,
      lastModified: record.lastModified,
      buffer
    });
    transferList.push(buffer);
    if ((i > 0 && i % 50 === 0) || i === fileEntries.length - 1) {
      updateStatus(`Transferring preview files… ${i + 1}/${fileEntries.length}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  let ackReceived = false;
  try {
    await registerPreviewSession(sessionId, sessionFiles, transferList);
    ackReceived = true;
  } catch (error) {
    console.warn('Preview session wait timed out, proceeding anyway.', error);
  }

  const previewUrl = new URL(`preview/${sessionId}/index.html`, getAppBaseUrl());
  setPreviewState({ showFrame: true, src: previewUrl.toString() });
  updateStatus('Preview ready.');
  console.info(`[preview] Session ${sessionId} ready${ackReceived ? '' : ' (no ack)'}.`);

  const messages = gatherMessages(manifestKind, xmlDoc, zip);

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
    versionLabel,
    publishFiles: null,
    publishFilesPromise: null
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
    publishButton.disabled = false;
    publishButton.removeAttribute('aria-disabled');
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
  const metadata =
    manifestKind === 'legacy'
      ? normalizeLegacyMetadata(extractLegacyMetadata(xmlDoc))
      : extractMetadata(xmlDoc);

  const { versionLabel } = computeCompatibility(metadata);

  setPreviewState({ showFrame: false });
  infoPanel.update({
    status: 'ready',
    fileName: file.name,
    fileSize: file.size,
    fileType: 'elp',
    elpVersion: versionLabel,
    metadata,
    manifestKind,
    startFile: 'index.html',
    fileList: [],
    summary: { totalFiles: 0, totalSize: 0 },
    messages: [
      {
        level: 'info',
        text: 'Upload an .elpx export to render the preview. Only metadata is available for .elp files.'
      }
    ]
  });
  infoPanel.setDownloadHandler(null);

  if (publishButton) {
    publishButton.disabled = true;
    publishButton.setAttribute('aria-disabled', 'true');
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
    if (previewFrame) {
      setPreviewState({ showFrame: false });
    }
    releaseCurrentSession();
    if (publishButton) {
      publishButton.disabled = true;
      publishButton.setAttribute('aria-disabled', 'true');
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
      publishButton.disabled = true;
      publishButton.setAttribute('aria-disabled', 'true');
    }
  }
}

function setupDragAndDrop() {
  if (!dropzone || !fileInput) {
    return;
  }

  dropzone.setAttribute('aria-hidden', 'true');

  const isFileDrag = (event) => {
    const types = event.dataTransfer?.types;
    if (!types) {
      return false;
    }
    return Array.from(types).includes('Files');
  };

  const showOverlay = () => {
    dropzone.classList.add('is-visible');
    dropzone.setAttribute('aria-hidden', 'false');
  };

  const hideOverlay = () => {
    dropzone.classList.remove('is-visible', 'is-dragover');
    dropzone.setAttribute('aria-hidden', 'true');
  };

  const extractFirstFile = (dataTransfer) => {
    if (!dataTransfer) {
      return null;
    }
    if (dataTransfer.items && dataTransfer.items.length > 0) {
      for (const item of Array.from(dataTransfer.items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            return file;
          }
        }
      }
    }
    const files = dataTransfer.files;
    if (files && files.length > 0) {
      return files[0];
    }
    return null;
  };

  const preventDefault = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  document.addEventListener('dragenter', (event) => {
    if (!isFileDrag(event)) {
      return;
    }
    preventDefault(event);
    showOverlay();
  });

  document.addEventListener('dragover', (event) => {
    if (!isFileDrag(event)) {
      return;
    }
    preventDefault(event);
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  });

  document.addEventListener('drop', (event) => {
    if (!isFileDrag(event)) {
      return;
    }
    preventDefault(event);
    const droppedFile = extractFirstFile(event.dataTransfer);
    hideOverlay();
    if (droppedFile) {
      void handleFile(droppedFile);
    }
  });

  document.addEventListener('dragend', () => {
    hideOverlay();
  });

  document.addEventListener('dragleave', (event) => {
    // Only hide overlay when leaving the window entirely
    if (event.target === document.documentElement || event.target === document.body) {
      if (!event.relatedTarget || event.relatedTarget.nodeName === 'HTML') {
        hideOverlay();
      }
    }
  });

  dropzone.addEventListener('dragenter', (event) => {
    if (!isFileDrag(event)) {
      return;
    }
    preventDefault(event);
    dropzone.classList.add('is-dragover');
  });

  dropzone.addEventListener('dragover', (event) => {
    if (!isFileDrag(event)) {
      return;
    }
    preventDefault(event);
    dropzone.classList.add('is-dragover');
  });

  dropzone.addEventListener('dragleave', (event) => {
    if (!isFileDrag(event)) {
      return;
    }
    preventDefault(event);
    dropzone.classList.remove('is-dragover');
  });

  dropzone.addEventListener('drop', (event) => {
    if (!isFileDrag(event)) {
      return;
    }
    preventDefault(event);
    dropzone.classList.remove('is-dragover');
    const file = extractFirstFile(event.dataTransfer);
    hideOverlay();
    if (file) {
      void handleFile(file);
    }
  });

  dropzone.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (event) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      hideOverlay();
      void handleFile(files[0]);
      fileInput.value = '';
    }
  });
}

async function initialise() {
  installErrorGuards();
  updateHeaderOffset();
  window.addEventListener('resize', updateHeaderOffset);
  window.addEventListener('load', updateHeaderOffset);
  if (document.fonts?.ready) {
    document.fonts.ready.then(updateHeaderOffset).catch(() => {});
  }

  resetInterface();
  setupDragAndDrop();

  if (uploadButton && fileInput) {
    uploadButton.addEventListener('click', () => {
      fileInput.click();
    });
  }

  const registration = await registerServiceWorker();
  if (!registration) {
    showToast(
      'Preview service worker could not start. Reload the page to enable previews.',
      'danger'
    );
    return;
  }
  try {
    await ensureServiceWorkerController();
  } catch (error) {
    console.warn('Service worker controller unavailable', error);
    showToast(
      'Preview service worker could not start. Reload the page to enable previews.',
      'danger'
    );
    return;
  }
  if (!navigator.serviceWorker.controller) {
    showToast(
      'Preview will be available after a reload so the service worker can activate.',
      'warning'
    );
    return;
  }

  postToServiceWorker({ type: 'cleanup-sessions' });
}

if (typeof window.getGitHubToken !== 'function') {
  window.getGitHubToken = () => getStoredGitHubToken();
}

if (typeof window.getFilesToPublish !== 'function') {
  window.getFilesToPublish = async () => {
    if (!currentSession) {
      return [];
    }
    return buildPublishFilesForSession(currentSession);
  };
}

if (typeof window.onSignOut !== 'function') {
  window.onSignOut = () => {
    clearStoredGitHubAuth(true);
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialise, { once: true });
} else {
  void initialise();
}

export { detectFileType, inferMimeType, hasIndexHtml } from './viewer-utils.js';
