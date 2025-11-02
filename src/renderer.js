import { extractLegacyMetadata } from './validator.js';

function trimText(value) {
  if (typeof value !== 'string') {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value).trim();
  }
  return value.trim();
}

function coerceNumber(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : fallback;
}

function getFirstText(node, tagNames) {
  if (!node) {
    return '';
  }
  const names = Array.isArray(tagNames) ? tagNames : [tagNames];
  for (let index = 0; index < names.length; index += 1) {
    const tagName = names[index];
    const match = node.getElementsByTagName(tagName)[0];
    if (match && match.textContent) {
      const text = trimText(match.textContent);
      if (text) {
        return text;
      }
    }
  }
  return '';
}

function extractHtmlFromModernNavigation(navStructure) {
  if (!navStructure) {
    return '';
  }
  const htmlNodes = Array.from(navStructure.getElementsByTagName('htmlView'));
  const snippets = htmlNodes
    .map((node) => trimText(node.textContent || ''))
    .filter((snippet) => snippet);
  return snippets.join('\n\n');
}

function parseModernPages(xmlDoc) {
  const navigationNodes = Array.from(xmlDoc.getElementsByTagName('odeNavStructure'));
  if (!navigationNodes.length) {
    return [];
  }

  const parentFieldNames = [
    'odeNavStructureParent',
    'odeNavStructureParentId',
    'odeNavParentStructure',
    'odeNavParent',
    'odeParentId',
    'odeParentPageId',
    'parentPageId'
  ];

  return navigationNodes.map((navNode, index) => {
    const id = getFirstText(navNode, 'odePageId') || `page-${index + 1}`;
    const title = getFirstText(navNode, 'pageName') || id || 'Untitled page';
    const parentId = getFirstText(navNode, parentFieldNames) || '';
    const order = coerceNumber(
      getFirstText(navNode, ['odeNavStructureSyncOrder', 'odeNavStructureOrder']),
      index
    );
    const htmlContent = extractHtmlFromModernNavigation(navNode);
    return {
      id,
      title,
      htmlContent,
      parentId: parentId && parentId !== id ? parentId : '',
      order,
      index
    };
  });
}

function ensureArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function extractHtmlFromLegacyNode(node) {
  if (!node || typeof node !== 'object') {
    return '';
  }

  const contentKeys = ['_content', '_body', '_text', '_html'];
  const snippets = [];
  contentKeys.forEach((key) => {
    if (typeof node[key] === 'string' && node[key].trim()) {
      snippets.push(node[key].trim());
    }
  });
  return snippets.join('\n\n');
}

function parseLegacyChildren(children, accumulator, parentId, orderBase) {
  const list = ensureArray(children);
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const id = trimText(entry._id || entry.id || entry.identifier || entry.uid || '');
    const safeId = id || `${parentId || 'legacy'}-${accumulator.length + 1}`;
    const title = trimText(entry._title || entry.title || entry.name || safeId || 'Untitled page');
    const idevices = ensureArray(entry._idevices);
    const ideviceHtml = idevices
      .map((device) => extractHtmlFromLegacyNode(device))
      .filter((snippet) => snippet);
    const fallbackHtml = extractHtmlFromLegacyNode(entry);
    const combinedHtml = (ideviceHtml.length ? ideviceHtml : [fallbackHtml])
      .filter(Boolean)
      .join('\n\n');
    const page = {
      id: safeId,
      title: title || safeId || 'Untitled page',
      htmlContent: combinedHtml,
      parentId: parentId && parentId !== safeId ? parentId : '',
      order: coerceNumber(entry._order, orderBase + index),
      index: accumulator.length
    };
    accumulator.push(page);
    if (entry._children) {
      parseLegacyChildren(entry._children, accumulator, safeId, orderBase + index + 1);
    }
  });
}

function parseLegacyPages(xmlDoc) {
  const metadata = extractLegacyMetadata(xmlDoc);
  const properties = metadata?.properties;
  if (!properties) {
    return [];
  }
  const accumulator = [];
  parseLegacyChildren(properties._children, accumulator, '', 0);
  return accumulator;
}

function sortAscending(a, b) {
  const orderDifference = (a.order ?? 0) - (b.order ?? 0);
  if (orderDifference !== 0) {
    return orderDifference;
  }
  return (a.index ?? 0) - (b.index ?? 0);
}

function sortHierarchy(nodes) {
  nodes.sort(sortAscending);
  nodes.forEach((node) => {
    if (node.children && node.children.length > 1) {
      sortHierarchy(node.children);
    }
  });
}

function assignLevels(nodes, level) {
  nodes.forEach((node) => {
    node.level = level;
    if (node.children?.length) {
      assignLevels(node.children, level + 1);
    }
  });
}

function buildHierarchy(flatPages) {
  const pages = flatPages.map((page) => ({
    id: page.id,
    title: page.title,
    htmlContent: page.htmlContent || '',
    parentId: page.parentId,
    order: page.order,
    index: page.index,
    children: []
  }));

  const byId = new Map();
  pages.forEach((page) => {
    if (!page.id) {
      return;
    }
    byId.set(page.id, page);
  });

  const roots = [];
  pages.forEach((page) => {
    const parentId = page.parentId;
    if (parentId && byId.has(parentId) && parentId !== page.id) {
      const parent = byId.get(parentId);
      parent.children.push(page);
    } else {
      roots.push(page);
    }
  });

  sortHierarchy(roots);
  assignLevels(roots, 0);

  const cleanNode = (node) => {
    delete node.parentId;
    delete node.index;
    if (!node.children.length) {
      node.children = [];
    } else {
      node.children.forEach(cleanNode);
    }
  };

  roots.forEach(cleanNode);
  return roots;
}

export function generateElpViewData(xmlDoc) {
  if (!xmlDoc || !xmlDoc.documentElement) {
    return [];
  }

  const rootName = xmlDoc.documentElement.localName || xmlDoc.documentElement.tagName;
  const flatPages =
    rootName && rootName.toLowerCase() === 'ode'
      ? parseModernPages(xmlDoc)
      : parseLegacyPages(xmlDoc);

  if (!flatPages.length) {
    return [];
  }

  return buildHierarchy(flatPages);
}

export default { generateElpViewData };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generateElpViewData };
}
