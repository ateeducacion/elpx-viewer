const {
  isValidBranchName,
  buildTreeEntriesFromFiles,
  computePagesUrl
} = require('../src/github-utils.js');

describe('GitHub helper utilities', () => {
  test('isValidBranchName rejects invalid patterns', () => {
    expect(isValidBranchName('feature/new-ui')).toBe(true);
    expect(isValidBranchName(' release ')).toBe(false);
    expect(isValidBranchName('bad..branch')).toBe(false);
    expect(isValidBranchName('/leading')).toBe(false);
    expect(isValidBranchName('trailing/')).toBe(false);
    expect(isValidBranchName('branch@{test}')).toBe(false);
  });

  test('buildTreeEntriesFromFiles maps blobs to tree objects', () => {
    const entries = buildTreeEntriesFromFiles([
      { path: 'index.html', sha: 'abc' },
      { path: 'assets/app.js', sha: 'def' }
    ]);
    expect(entries).toEqual([
      { path: 'index.html', mode: '100644', type: 'blob', sha: 'abc' },
      { path: 'assets/app.js', mode: '100644', type: 'blob', sha: 'def' }
    ]);
  });

  test('computePagesUrl builds canonical GitHub Pages URLs', () => {
    expect(computePagesUrl('AteEducacion', 'elpx-viewer')).toBe('https://ateeducacion.github.io/elpx-viewer/');
    expect(computePagesUrl('AteEducacion', 'ateeducacion.github.io')).toBe('https://ateeducacion.github.io/');
    expect(computePagesUrl('', 'repo')).toBeNull();
  });
});
