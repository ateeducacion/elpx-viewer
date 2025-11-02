const REQUIRED_NAV_FIELDS = [
  'odePageId',
  'pageName',
  ['odeNavStructureSyncOrder', 'odeNavStructureOrder']
];
const REQUIRED_BLOCK_FIELDS = ['odeBlockId', 'blockName'];
const REQUIRED_COMPONENT_FIELDS = ['odeIdeviceId', 'odeIdeviceTypeName', 'htmlView', 'jsonProperties'];

export function parseContentXml(xmlString) {
  if (typeof xmlString !== 'string') {
    return { status: 'error', message: 'The provided XML payload is not a string.' };
  }

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlString, 'application/xml');
  const parserError = xmlDoc.querySelector('parsererror');

  if (parserError) {
    const detail = (parserError.textContent || '').trim();
    const message = detail
      ? `The XML document is not well-formed: ${detail}`
      : 'The XML document is not well-formed.';
    return { status: 'error', message };
  }

  return { status: 'success', document: xmlDoc };
}

export function checkRootElement(xmlDoc) {
  if (!xmlDoc || !xmlDoc.documentElement) {
    return { status: 'error', message: 'Unable to read the XML root element.' };
  }

  const tagName = xmlDoc.documentElement.tagName;
  if (!tagName) {
    return { status: 'error', message: 'The XML root element is missing a tag name.' };
  }

  if (tagName.toLowerCase() !== 'ode') {
    return {
      status: 'error',
      message: `Expected the root element to be <ode>, found <${tagName}> instead.`
    };
  }

  return { status: 'success', message: 'The root element is <ode>.' };
}

export function checkNavStructures(xmlDoc) {
  const navStructures = xmlDoc.getElementsByTagName('odeNavStructures');
  if (!navStructures || navStructures.length === 0) {
    return { status: 'error', message: 'The <odeNavStructures> element is missing.' };
  }

  return { status: 'success', message: 'Navigation structures found.' };
}

export function checkPagePresence(xmlDoc) {
  const pages = xmlDoc.getElementsByTagName('odeNavStructure');
  if (!pages || pages.length === 0) {
    return {
      status: 'warning',
      message: 'No <odeNavStructure> entries were found. The project appears to be empty.'
    };
  }

  return { status: 'success', message: `Found ${pages.length} page${pages.length === 1 ? '' : 's'}.` };
}

export function extractPageTitles(xmlDoc) {
  if (!xmlDoc) {
    return [];
  }
  const navStructures = Array.from(xmlDoc.getElementsByTagName('odeNavStructure'));
  return navStructures.map((nav) => {
    const nameNode = nav.getElementsByTagName('pageName')[0];
    const idNode = nav.getElementsByTagName('odePageId')[0];
    const title = nameNode && nameNode.textContent ? nameNode.textContent.trim() : '';
    if (title) return title;
    const fallback = idNode && idNode.textContent ? idNode.textContent.trim() : '';
    return fallback || '(untitled)';
  });
}

function formatRequirement(requirement) {
  return Array.isArray(requirement) ? requirement.join(' / ') : requirement;
}

function ensureChildTags(node, requiredTags) {
  const missing = [];
  requiredTags.forEach((requirement) => {
    const tags = Array.isArray(requirement) ? requirement : [requirement];
    const hasAny = tags.some((tag) => node.getElementsByTagName(tag)[0]);
    if (!hasAny) {
      missing.push(formatRequirement(requirement));
    }
  });
  return missing;
}

export function validateStructuralIntegrity(xmlDoc) {
  const issues = [];
  const navStructures = Array.from(xmlDoc.getElementsByTagName('odeNavStructure'));

  navStructures.forEach((navStructure, index) => {
    const missingNavFields = ensureChildTags(navStructure, REQUIRED_NAV_FIELDS);
    if (missingNavFields.length > 0) {
      issues.push(`Navigation structure #${index + 1} is missing fields: ${missingNavFields.join(', ')}`);
    }

    const pageStructures = navStructure.getElementsByTagName('odePagStructure');
    Array.from(pageStructures).forEach((pageStructure, blockIndex) => {
      const missingBlockFields = ensureChildTags(pageStructure, REQUIRED_BLOCK_FIELDS);
      if (missingBlockFields.length > 0) {
        issues.push(`Block #${blockIndex + 1} in page #${index + 1} is missing fields: ${missingBlockFields.join(', ')}`);
      }

      const components = pageStructure.getElementsByTagName('odeComponent');
      Array.from(components).forEach((component, componentIndex) => {
        const missingComponentFields = ensureChildTags(component, REQUIRED_COMPONENT_FIELDS);
        if (missingComponentFields.length > 0) {
          issues.push(`Component #${componentIndex + 1} in block #${blockIndex + 1} of page #${index + 1} is missing fields: ${missingComponentFields.join(', ')}`);
        }
      });
    });
  });

  if (issues.length > 0) {
    return {
      status: 'error',
      message: issues.join(' ')
    };
  }

  return { status: 'success', message: 'The internal XML structure matches the expected layout.' };
}

const RESOURCE_ATTRIBUTE_REGEX = /(?:src|href)=["']([^"']+)["']/gi;
const RESOURCE_FOLDER_REGEX = /(content|custom)\//i;

export function extractResourcePaths(xmlDoc) {
  const resourcePaths = new Set();
  const htmlNodes = Array.from(xmlDoc.getElementsByTagName('htmlView'));
  const jsonNodes = Array.from(xmlDoc.getElementsByTagName('jsonProperties'));

  htmlNodes.forEach((node) => {
    const text = node.textContent || '';
    let match;
    while ((match = RESOURCE_ATTRIBUTE_REGEX.exec(text)) !== null) {
      const value = match[1];
      if (RESOURCE_FOLDER_REGEX.test(value)) {
        resourcePaths.add(normalizeResourcePath(value));
      }
    }
  });

  jsonNodes.forEach((node) => {
    const text = node.textContent || '';
    try {
      const json = JSON.parse(text);
      collectPathsFromJson(json, resourcePaths);
    } catch (error) {
      let match;
      while ((match = RESOURCE_ATTRIBUTE_REGEX.exec(text)) !== null) {
        const value = match[1];
        if (RESOURCE_FOLDER_REGEX.test(value)) {
          resourcePaths.add(normalizeResourcePath(value));
        }
      }
    }
  });

  return Array.from(resourcePaths);
}

function collectPathsFromJson(value, accumulator) {
  if (!value) {
    return;
  }

  if (typeof value === 'string') {
    if (RESOURCE_FOLDER_REGEX.test(value)) {
      accumulator.add(normalizeResourcePath(value));
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectPathsFromJson(item, accumulator));
    return;
  }

  if (typeof value === 'object') {
    Object.values(value).forEach((item) => collectPathsFromJson(item, accumulator));
  }
}

export function normalizeResourcePath(path) {
  return decodeURIComponent(path.trim())
    .replace(/^\.\//, '')
    .replace(/^\//, '')
    .replace(/\\/g, '/');
}

export function findMissingResources(paths, zip) {
  if (!paths || paths.length === 0) {
    return [];
  }

  const missing = [];
  paths.forEach((path) => {
    const normalized = normalizeResourcePath(path);
    if (!zip.file(normalized)) {
      const encoded = encodeURI(normalized);
      if (!zip.file(encoded)) {
        missing.push(path);
      }
    }
  });
  return missing;
}

export function extractMetadata(xmlDoc) {
  const metadata = { properties: {}, resources: {} };

  const propertyNodes = Array.from(xmlDoc.getElementsByTagName('odeProperty'));
  propertyNodes.forEach((property) => {
    const keyNode = property.getElementsByTagName('key')[0];
    if (!keyNode || !keyNode.textContent) {
      return;
    }
    const valueNode = property.getElementsByTagName('value')[0];
    const key = keyNode.textContent.trim();
    const value = valueNode && valueNode.textContent ? valueNode.textContent.trim() : '';
    if (key) {
      metadata.properties[key] = value;
    }
  });

  const resourceNodes = Array.from(xmlDoc.getElementsByTagName('odeResource'));
  resourceNodes.forEach((resource) => {
    const keyNode = resource.getElementsByTagName('key')[0];
    if (!keyNode || !keyNode.textContent) {
      return;
    }
    const valueNode = resource.getElementsByTagName('value')[0];
    const key = keyNode.textContent.trim();
    const value = valueNode && valueNode.textContent ? valueNode.textContent.trim() : '';
    if (key) {
      metadata.resources[key] = value;
    }
  });

  return metadata;
}

export function extractLegacyMetadata(xmlDoc) {
  if (!xmlDoc || !xmlDoc.documentElement) {
    return null;
  }

  const metadata = { properties: {}, resources: {} };
  const root = xmlDoc.documentElement;
  const topDictionary = findFirstChildByLocalName(root, 'dictionary');

  if (!topDictionary) {
    return metadata;
  }

  metadata.properties = extractLegacyDictionary(topDictionary);

  const version = root.getAttribute('version');
  if (version) {
    metadata.properties.legacy_manifest_version = version;
  }

  const legacyClass = root.getAttribute('class');
  if (legacyClass) {
    metadata.properties.legacy_manifest_class = legacyClass;
  }

  return metadata;
}

export function normalizeLegacyMetadata(metadata) {
  if (!metadata) {
    return null;
  }

  const normalized = {
    properties: {},
    resources: { ...(metadata.resources || {}) }
  };

  const properties = { ...(metadata.properties || {}) };

  if (properties._title && !properties.pp_title) {
    properties.pp_title = properties._title;
  }
  if (properties._author && !properties.pp_author) {
    properties.pp_author = properties._author;
  }
  if (properties._lang && !properties.pp_lang) {
    properties.pp_lang = properties._lang;
  }
  if (properties._description && !properties.pp_description) {
    properties.pp_description = properties._description;
  }
  if (properties._newlicense && !properties.license) {
    properties.license = properties._newlicense;
  }

  normalized.properties = properties;
  return normalized;
}

function findFirstChildByLocalName(node, localName) {
  if (!node || !node.children) {
    return null;
  }
  return Array.from(node.children).find((child) => child.localName === localName);
}

function extractLegacyDictionary(dictionaryNode) {
  const result = {};
  if (!dictionaryNode || !dictionaryNode.children) {
    return result;
  }

  const children = Array.from(dictionaryNode.children);
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!child.getAttribute) {
      continue; // Skip nodes without attributes (e.g., whitespace)
    }
    const role = child.getAttribute('role');
    if (role !== 'key') {
      continue;
    }

    const key = child.getAttribute('value') || child.textContent || '';
    if (!key) {
      continue;
    }

    const valueNode = children[index + 1];
    if (valueNode) {
      result[key] = extractLegacyValue(valueNode);
      index += 1;
    }
  }

  return result;
}

function extractLegacyInstance(instanceNode) {
  if (!instanceNode || !instanceNode.children) {
    return {};
  }

  const dictionary = findFirstChildByLocalName(instanceNode, 'dictionary');
  return dictionary ? extractLegacyDictionary(dictionary) : {};
}

function extractLegacyList(listNode) {
  if (!listNode || !listNode.children) {
    return [];
  }
  return Array.from(listNode.children).map((child) => extractLegacyValue(child));
}

function extractLegacyValue(node) {
  if (!node) {
    return '';
  }

  const name = node.localName || node.tagName;
  switch (name) {
    case 'unicode':
    case 'string':
    case 'bool':
    case 'int':
      return node.getAttribute('value') ?? (node.textContent || '');
    case 'list':
      return extractLegacyList(node);
    case 'dictionary':
      return extractLegacyDictionary(node);
    case 'instance':
      return extractLegacyInstance(node);
    default:
      return node.textContent || '';
  }
}

export default {
  parseContentXml,
  checkRootElement,
  checkNavStructures,
  checkPagePresence,
  validateStructuralIntegrity,
  extractResourcePaths,
  findMissingResources,
  normalizeResourcePath,
  extractMetadata,
  extractLegacyMetadata,
  normalizeLegacyMetadata,
  extractPageTitles
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseContentXml,
    checkRootElement,
    checkNavStructures,
    checkPagePresence,
    validateStructuralIntegrity,
    extractResourcePaths,
    findMissingResources,
    normalizeResourcePath,
    extractMetadata,
    extractLegacyMetadata,
    normalizeLegacyMetadata,
    extractPageTitles
  };
}
