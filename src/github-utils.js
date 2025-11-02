export function isValidBranchName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/') || trimmed.endsWith('/')) return false;
  if (trimmed.includes('..') || trimmed.includes('@{')) return false;
  if (/\s/.test(trimmed)) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(trimmed)) return false;
  return true;
}

export function buildTreeEntriesFromFiles(files) {
  if (!Array.isArray(files)) {
    return [];
  }
  return files.map((file) => ({
    path: file.path,
    mode: '100644',
    type: 'blob',
    sha: file.sha
  }));
}

export function computePagesUrl(owner, repo) {
  if (!owner || !repo) {
    return null;
  }
  const normalizedRepo = repo.toLowerCase();
  const normalizedOwner = owner.toLowerCase();
  if (normalizedRepo === `${normalizedOwner}.github.io`) {
    return `https://${normalizedOwner}.github.io/`;
  }
  return `https://${normalizedOwner}.github.io/${repo}/`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isValidBranchName,
    buildTreeEntriesFromFiles,
    computePagesUrl
  };
}
