import {
  extractMetadata,
  extractLegacyMetadata,
  normalizeLegacyMetadata,
  parseContentXml
} from './validator.js';

const PRIMARY_PROPERTY_KEYS = new Set(['pp_title', 'pp_author', 'pp_lang', 'pp_description', 'license', 'title', 'language', 'version']);
const PRIMARY_RESOURCE_KEYS = new Set(['odeVersionName', 'odeId', 'odeVersionId']);

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const thresh = 1024;
  if (Math.abs(bytes) < thresh) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let unitIndex = -1;
  let value = bytes;
  do {
    value /= thresh;
    unitIndex += 1;
  } while (Math.abs(value) >= thresh && unitIndex < units.length - 1);
  const precision = value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function createDefinitionList(entries) {
  const dl = document.createElement('dl');
  dl.className = 'row row-cols-1 row-cols-md-2 gy-2 text-break';
  entries.forEach(([term, value]) => {
    const dt = document.createElement('dt');
    dt.className = 'col-md-4 fw-semibold';
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.className = 'col-md-8';
    dd.textContent = value ?? '—';
    dl.append(dt, dd);
  });
  return dl;
}

function buildMetadataSections(metadata) {
  if (!metadata) {
    return { highlights: null, extraProperties: null, extraResources: null };
  }

  const properties = metadata.properties || {};
  const resources = metadata.resources || {};

  const highlightEntries = [
    ['Title', properties.pp_title || properties.title || ''],
    ['Author', properties.pp_author || ''],
    ['Language', properties.pp_lang || properties.language || ''],
    ['Description', properties.pp_description || ''],
    ['License', properties.license || ''],
    ['Version', resources.odeVersionName || properties.version || ''],
    ['Identifier', resources.odeId || resources.odeVersionId || '']
  ];

  const extraPropertyEntries = Object.entries(properties).filter(([key]) => !PRIMARY_PROPERTY_KEYS.has(key));
  const extraResourceEntries = Object.entries(resources).filter(([key]) => !PRIMARY_RESOURCE_KEYS.has(key));

  const highlights = createDefinitionList(highlightEntries);

  const extraProperties = extraPropertyEntries.length > 0 ? createKeyValueList(extraPropertyEntries) : null;
  const extraResources = extraResourceEntries.length > 0 ? createKeyValueList(extraResourceEntries) : null;

  return { highlights, extraProperties, extraResources };
}

function createKeyValueList(entries) {
  const list = document.createElement('ul');
  list.className = 'list-group list-group-flush small';
  entries.forEach(([key, value]) => {
    const item = document.createElement('li');
    item.className = 'list-group-item d-flex justify-content-between align-items-start gap-3';
    const term = document.createElement('code');
    term.textContent = key;
    const val = document.createElement('span');
    val.className = 'text-break flex-grow-1 text-body-secondary';
    if (value === null || value === undefined || value === '') {
      val.textContent = '—';
    } else if (typeof value === 'object') {
      try {
        val.textContent = JSON.stringify(value, null, 2);
      } catch (error) {
        val.textContent = String(value);
      }
    } else {
      val.textContent = value;
    }
    item.append(term, val);
    list.appendChild(item);
  });
  return list;
}

function createMessagesList(messages = []) {
  if (!messages.length) {
    return null;
  }
  const list = document.createElement('ul');
  list.className = 'list-group list-group-flush';
  messages.forEach((message) => {
    const item = document.createElement('li');
    item.className = 'list-group-item d-flex align-items-start gap-3';
    const badge = document.createElement('span');
    badge.className = `badge rounded-pill text-bg-${message.level === 'error' ? 'danger' : message.level === 'warning' ? 'warning' : 'secondary'}`;
    badge.textContent = message.level === 'error' ? 'Error' : message.level === 'warning' ? 'Warning' : 'Info';
    const text = document.createElement('p');
    text.className = 'mb-0 flex-grow-1';
    text.textContent = message.text;
    item.append(badge, text);
    list.appendChild(item);
  });
  return list;
}

function createInventorySection(fileList = [], summary = {}) {
  const container = document.createElement('section');
  container.className = 'mt-4';

  const heading = document.createElement('h2');
  heading.className = 'h5';
  heading.textContent = 'File inventory';
  container.appendChild(heading);

  const meta = document.createElement('p');
  meta.className = 'text-muted small mb-3';
  const totalFiles = summary.totalFiles ?? fileList.length;
  const totalSize = formatBytes(summary.totalSize ?? 0);
  meta.textContent = `${totalFiles} file${totalFiles === 1 ? '' : 's'} • ${totalSize}`;
  container.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'd-flex flex-wrap gap-2 align-items-center';
  const downloadButton = document.createElement('button');
  downloadButton.type = 'button';
  downloadButton.className = 'btn btn-sm btn-outline-secondary';
  downloadButton.id = 'downloadInventoryButton';
  downloadButton.textContent = 'Download JSON';
  actions.append(downloadButton);
  container.appendChild(actions);

  const details = document.createElement('details');
  details.className = 'mt-3';
  const summaryEl = document.createElement('summary');
  summaryEl.textContent = `Show file list (${totalFiles})`;
  details.appendChild(summaryEl);

  const tableWrapper = document.createElement('div');
  tableWrapper.className = 'table-responsive mt-3';
  const table = document.createElement('table');
  table.className = 'table table-sm table-striped align-middle mb-0';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th scope="col">Path</th><th scope="col">Size</th><th scope="col">MIME type</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  const maxRows = Math.min(fileList.length, 500); // Keep rendering fast
  for (let index = 0; index < maxRows; index += 1) {
    const entry = fileList[index];
    const row = document.createElement('tr');
    const pathCell = document.createElement('td');
    pathCell.textContent = entry.path;
    const sizeCell = document.createElement('td');
    sizeCell.textContent = formatBytes(entry.size ?? 0);
    const mimeCell = document.createElement('td');
    mimeCell.textContent = entry.mimeType || '—';
    row.append(pathCell, sizeCell, mimeCell);
    tbody.appendChild(row);
  }
  if (fileList.length > maxRows) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.className = 'text-center text-muted';
    cell.textContent = `Only showing the first ${maxRows} entries.`;
    row.appendChild(cell);
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  tableWrapper.appendChild(table);
  details.appendChild(tableWrapper);
  container.appendChild(details);

  return { container, downloadButton };
}

export class InfoPanel {
  constructor(root) {
    this.root = root;
    this.downloadHandler = null;
    this.state = { status: 'idle' };
    this.render();
  }

  setDownloadHandler(handler) {
    this.downloadHandler = handler;
  }

  update(state) {
    this.state = state;
    this.render();
  }

  render() {
    if (!this.root) {
      return;
    }

    const { status } = this.state;
    this.root.innerHTML = '';

    switch (status) {
      case 'loading':
        this.renderLoading();
        break;
      case 'unsupported':
        this.renderUnsupported();
        break;
      case 'error':
        this.renderError(this.state.error || 'Something went wrong while reading the package.');
        break;
      case 'ready':
        this.renderReady();
        break;
      default:
        this.renderIdle();
    }
  }

  renderIdle() {
    const message = document.createElement('p');
    message.className = 'text-muted mb-0';
    message.textContent = 'Load an .elpx package to inspect its metadata and structure.';
    this.root.appendChild(message);
  }

  renderLoading() {
    const spinner = document.createElement('div');
    spinner.className = 'd-flex align-items-center gap-3';
    spinner.innerHTML = '<div class="spinner-border text-secondary" role="status" aria-hidden="true"></div><p class="mb-0">Reading archive…</p>';
    this.root.appendChild(spinner);
  }

  renderUnsupported() {
    const alert = document.createElement('div');
    alert.className = 'alert alert-warning';
    alert.role = 'alert';
    alert.innerHTML = '<strong>ELP v2 is not supported by the viewer.</strong> You can still review the package metadata below.';
    this.root.appendChild(alert);
    if (this.state.metadata) {
      this.renderMetadataOnly(this.state);
    }
  }

  renderError(message) {
    const alert = document.createElement('div');
    alert.className = 'alert alert-danger';
    alert.role = 'alert';
    alert.textContent = message;
    this.root.appendChild(alert);
  }

  renderMetadataOnly(state) {
    const wrapper = document.createElement('div');
    const { highlights, extraProperties, extraResources } = buildMetadataSections(state.metadata);

    const heading = document.createElement('h2');
    heading.className = 'h5';
    heading.textContent = 'Metadata';
    wrapper.appendChild(heading);
    if (highlights) {
      wrapper.appendChild(highlights);
    }

    if (extraProperties) {
      const subtitle = document.createElement('h3');
      subtitle.className = 'h6 mt-3';
      subtitle.textContent = 'Additional properties';
      wrapper.appendChild(subtitle);
      wrapper.appendChild(extraProperties);
    }

    if (extraResources) {
      const subtitle = document.createElement('h3');
      subtitle.className = 'h6 mt-3';
      subtitle.textContent = 'Resources';
      wrapper.appendChild(subtitle);
      wrapper.appendChild(extraResources);
    }

    this.root.appendChild(wrapper);
  }

  renderReady() {
    const state = this.state;
    const container = document.createElement('div');

    const overview = document.createElement('section');
    overview.className = 'mb-4';
    const heading = document.createElement('h2');
    heading.className = 'h5';
    heading.textContent = 'Package overview';
    overview.appendChild(heading);

    const entries = [
      ['File name', state.fileName || '—'],
      ['File size', formatBytes(state.fileSize)],
      ['Package type', state.fileType === 'elpx' ? 'ELPX (exported site)' : 'ELP'],
      ['ELP version', state.elpVersion || '—'],
      ['Start file', state.startFile || 'index.html'],
      ['Manifest', state.manifestKind === 'legacy' ? 'Legacy (contentv3.xml)' : 'Modern (content.xml)']
    ];

    overview.appendChild(createDefinitionList(entries));

    container.appendChild(overview);

    if (state.messages && state.messages.length > 0) {
      const messageSection = document.createElement('section');
      messageSection.className = 'mb-4';
      const messageHeading = document.createElement('h2');
      messageHeading.className = 'h5';
      messageHeading.textContent = 'Validation messages';
      messageSection.appendChild(messageHeading);
      const list = createMessagesList(state.messages);
      if (list) {
        messageSection.appendChild(list);
      }
      container.appendChild(messageSection);
    }

    const { highlights, extraProperties, extraResources } = buildMetadataSections(state.metadata);
    const metadataSection = document.createElement('section');
    metadataSection.className = 'mb-4';
    const metadataHeading = document.createElement('h2');
    metadataHeading.className = 'h5';
    metadataHeading.textContent = 'Metadata';
    metadataSection.appendChild(metadataHeading);
    if (highlights) {
      metadataSection.appendChild(highlights);
    }
    if (extraProperties) {
      const subtitle = document.createElement('h3');
      subtitle.className = 'h6 mt-3';
      subtitle.textContent = 'Additional properties';
      metadataSection.appendChild(subtitle);
      metadataSection.appendChild(extraProperties);
    }
    if (extraResources) {
      const subtitle = document.createElement('h3');
      subtitle.className = 'h6 mt-3';
      subtitle.textContent = 'Resources';
      metadataSection.appendChild(subtitle);
      metadataSection.appendChild(extraResources);
    }
    container.appendChild(metadataSection);

    if (state.fileList && state.fileList.length > 0) {
      const inventory = createInventorySection(state.fileList, state.summary);
      container.appendChild(inventory.container);
      if (inventory.downloadButton) {
        inventory.downloadButton.addEventListener('click', () => {
          if (!this.downloadHandler) {
            return;
          }
          this.downloadHandler();
        });
      }
    }

    this.root.appendChild(container);
  }
}

export function deriveMetadata(xmlString, kind = 'modern') {
  if (!xmlString) {
    return null;
  }
  const { document, status, message } = parseContentXml(xmlString);
  if (status === 'error') {
    throw new Error(message);
  }
  if (kind === 'legacy') {
    return normalizeLegacyMetadata(extractLegacyMetadata(document));
  }
  return extractMetadata(document);
}

export { formatBytes };
