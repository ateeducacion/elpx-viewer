(function () {
  const API_BASE = 'https://api.github.com';
  const NEW_REPO_PREFIX = '__create__:';
  const RATE_LIMIT_THRESHOLD = 10;
  const DEVICE_AUTH_ENDPOINT = 'https://github.com/login/device/code';
  const DEVICE_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
  const DEVICE_SCOPE = 'repo';
  const DEVICE_POLL_BUFFER = 1000;
  const TOKEN_STORAGE_KEY = 'github_device_token';
  const USER_STORAGE_KEY = 'github_device_user';

  const state = {
    account: null,
    owners: [],
    userReposLoaded: false,
    repoOptions: [],
    orgRepoCache: new Map(),
    isCreatingRepo: false,
    selectedRepo: null,
    selectedBranch: 'gh-pages',
    branchExists: false,
    branchHasContent: false,
    isPublishing: false,
    rateLimitWarned: false,
    branchList: [],
    deviceFlowState: null,
    devicePollingTimer: null,
    deviceProxyUsed: false,
    publishSuccessInfo: null,
    publishAbortController: null,
    publishCancelled: false
  };

  const ui = {};

  function githubHeaders() {
    const token = readStoredToken();
    if (!token) {
      throw new Error('Missing GitHub token');
    }
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };
  }

  async function githubRequest(
    path,
    { method = 'GET', body, headers = {}, rawResponse = false } = {}
  ) {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { ...githubHeaders(), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: state.publishAbortController?.signal
    });
    logRateLimitIfNeeded(response);
    if (!response.ok) {
      const error = new Error(`GitHub request failed: ${response.status}`);
      error.status = response.status;
      try {
        error.body = await response.json();
      } catch {
        error.body = null;
      }
      throw error;
    }
    if (rawResponse) {
      return response;
    }
    if (response.status === 204) {
      return null;
    }
    return response.json();
  }

  function logRateLimitIfNeeded(response) {
    const remaining = parseInt(response.headers.get('X-RateLimit-Remaining') || '', 10);
    if (!Number.isNaN(remaining) && remaining <= RATE_LIMIT_THRESHOLD && !state.rateLimitWarned) {
      state.rateLimitWarned = true;
      logStep('Warning: GitHub rate limit is running low.', 'warning');
    }
  }

  function readStoredToken() {
    const stored = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored && stored.trim()) {
      return stored.trim();
    }
    const configToken =
      typeof window.APP_CONFIG?.githubToken === 'string'
        ? window.APP_CONFIG.githubToken.trim()
        : '';
    if (configToken) {
      return configToken;
    }
    if (typeof getGitHubToken === 'function') {
      try {
        const runtimeToken = getGitHubToken();
        if (typeof runtimeToken === 'string' && runtimeToken.trim()) {
          return runtimeToken.trim();
        }
      } catch (error) {
        console.warn('getGitHubToken() threw an error', error);
      }
    }
    return null;
  }

  function getDeviceProxy() {
    const proxy =
      typeof window.APP_CONFIG?.deviceFlowProxy === 'string'
        ? window.APP_CONFIG.deviceFlowProxy.trim()
        : '';
    return proxy ? proxy.replace(/\/$/, '') : '';
  }

  function applyDeviceProxy(url) {
    const proxy = getDeviceProxy();
    if (!proxy) {
      return url;
    }
    return `${proxy}/${url}`;
  }

  function isLikelyCorsError(error) {
    return error instanceof TypeError || /Failed to fetch/i.test(error?.message || '');
  }

  async function requestDeviceEndpoint(url, params) {
    const attempt = async (targetUrl) => {
      const body = new URLSearchParams(params);
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        body
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const error = new Error(`GitHub responded with ${response.status}`);
        error.status = response.status;
        error.body = text;
        throw error;
      }
      return response.json();
    };

    if (state.deviceProxyUsed && getDeviceProxy()) {
      return attempt(applyDeviceProxy(url));
    }

    try {
      return await attempt(url);
    } catch (error) {
      if (!state.deviceProxyUsed && getDeviceProxy() && isLikelyCorsError(error)) {
        state.deviceProxyUsed = true;
        return attempt(applyDeviceProxy(url));
      }
      throw error;
    }
  }

  function parseLinkHeader(header) {
    if (!header) return {};
    return header.split(',').reduce((acc, part) => {
      const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
      if (match) {
        acc[match[2]] = match[1];
      }
      return acc;
    }, {});
  }

  async function fetchAllPages(path, params = {}) {
    let page = 1;
    let results = [];
    let nextUrl = `${API_BASE}${path}?${new URLSearchParams({ ...params, page }).toString()}`;

    while (nextUrl) {
      const response = await fetch(nextUrl, { headers: githubHeaders() });
      logRateLimitIfNeeded(response);
      if (!response.ok) {
        const error = new Error(`GitHub pagination failed: ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const data = await response.json();
      if (Array.isArray(data)) {
        results = results.concat(data);
      }
      const links = parseLinkHeader(response.headers.get('link'));
      nextUrl = links.next || null;
      page += 1;
    }
    return results;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function encodeContentPath(path) {
    return path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  function initSelect2() {
    const $modal = $('#publishModal');

    ui.repoSelect = $('#publishRepo').select2({
      dropdownParent: $modal,
      width: '100%',
      minimumInputLength: 0,
      placeholder: $('#publishRepo').data('placeholder') || 'Search repositories',
      allowClear: false,
      tags: true,
      ajax: {
        transport: function (params, success, failure) {
          const term = params.data.term || '';
          const page = params.data.page || 1;
          searchRepos(term, page)
            .then((result) => success(result))
            .catch((err) => failure(err));
        },
        processResults: function (data, params) {
          params.page = params.page || 1;
          return {
            results: data.results,
            pagination: {
              more: data.more
            }
          };
        }
      },
      createTag: function (params) {
        const term = (params.term || '').trim();
        if (!term) return null;
        return {
          id: `${NEW_REPO_PREFIX}${term}`,
          text: term,
          isNew: true
        };
      },
      templateResult: renderRepoOption,
      templateSelection: renderRepoSelection,
      escapeMarkup: function (markup) {
        return markup;
      }
    });

    ui.branchSelect = $('#publishBranch').select2({
      dropdownParent: $modal,
      width: '100%',
      minimumResultsForSearch: 0,
      tags: true,
      placeholder: $('#publishBranch').data('placeholder') || 'Choose a branch'
    });
  }

  function renderRepoOption(opt) {
    if (opt.loading) {
      return 'Loading…';
    }
    if (opt.isNew) {
      return `<span>Create new repository '${escapeHtml(opt.text)}'</span>`;
    }
    const avatar = opt.avatar
      ? `<img src="${escapeHtml(opt.avatar)}" alt="" class="rounded-circle me-2" width="24" height="24" />`
      : '';
    return `<div class="d-flex align-items-center">${avatar}<span>${escapeHtml(opt.text)}</span></div>`;
  }

  function renderRepoSelection(opt) {
    if (!opt.id) return opt.text;
    if (opt.isNew) {
      return `Create new repository '${opt.text}'`;
    }
    return opt.text;
  }

  function cacheRepoOption(repo) {
    return {
      id: repo.full_name,
      text: repo.full_name,
      owner: repo.owner.login,
      repo: repo.name,
      avatar: repo.owner.avatar_url,
      private: repo.private
    };
  }

  async function ensureUserReposLoaded() {
    if (state.userReposLoaded) return;
    const repos = await fetchAllPages('/user/repos', {
      per_page: 100,
      affiliation: 'owner,collaborator,organization_member',
      sort: 'full_name'
    });
    state.repoOptions = repos.map(cacheRepoOption);
    state.userReposLoaded = true;
  }

  async function ensureOrgReposLoaded() {
    const loaders = state.owners
      .filter((owner) => owner.type === 'Organization')
      .map(async (owner) => {
        if (state.orgRepoCache.has(owner.login)) {
          return;
        }
        const repos = await fetchAllPages(`/orgs/${encodeURIComponent(owner.login)}/repos`, {
          per_page: 100,
          type: 'all',
          sort: 'full_name'
        });
        state.orgRepoCache.set(owner.login, repos.map(cacheRepoOption));
      });
    await Promise.all(loaders);
  }

  async function searchRepos(term = '', page = 1) {
    await ensureUserReposLoaded();
    await ensureOrgReposLoaded();

    const allRepos = state.repoOptions.concat(Array.from(state.orgRepoCache.values()).flat());
    const normalizedTerm = term.trim().toLowerCase();
    const filtered = normalizedTerm
      ? allRepos.filter((item) => item.text.toLowerCase().includes(normalizedTerm))
      : allRepos.slice();

    const pageSize = 20;
    const offset = (page - 1) * pageSize;
    const paginated = filtered.slice(offset, offset + pageSize);

    return Promise.resolve({
      results: paginated,
      more: offset + pageSize < filtered.length
    });
  }

  async function loadAccount() {
    const data = await githubRequest('/user');
    state.account = data;
    ui.accountName.textContent = `Signed in as ${data.login}`;
    if (ui.accountStatus) {
      ui.accountStatus.textContent = 'You are ready to publish.';
    }
    if (ui.accountAvatar) {
      ui.accountAvatar.src = data.avatar_url;
      ui.accountAvatar.alt = `${data.login} avatar`;
      ui.accountAvatar.classList.remove('d-none');
    }
    sessionStorage.setItem(
      USER_STORAGE_KEY,
      JSON.stringify({ login: data.login, avatar_url: data.avatar_url })
    );
    hideDevicePanel();
    stopDeviceFlow();
    ui.errorAlert.classList.add('d-none');
    if (ui.signInButton) {
      ui.signInButton.classList.add('d-none');
      ui.signInButton.disabled = false;
    }
    if (ui.signOutButton) {
      ui.signOutButton.classList.remove('d-none');
      ui.signOutButton.disabled = false;
    }
    if (ui.formWrapper) {
      ui.formWrapper.classList.remove('d-none');
      ui.formWrapper.removeAttribute('aria-hidden');
    }
    if (ui.repoSelect) {
      ui.repoSelect.prop('disabled', false);
    }
    if (ui.branchSelect) {
      ui.branchSelect.prop('disabled', false);
    }
    return data;
  }

  async function loadOwners() {
    if (!state.account) {
      await loadAccount();
    }
    const orgs = await fetchAllPages('/user/orgs', { per_page: 100 });
    state.owners = [
      {
        type: 'User',
        login: state.account.login,
        avatar_url: state.account.avatar_url
      },
      ...orgs.map((org) => ({
        type: 'Organization',
        login: org.login,
        avatar_url: org.avatar_url
      }))
    ];
    renderOwnerOptions();
    return state.owners;
  }

  function renderOwnerOptions() {
    const container = ui.ownerOptions;
    container.innerHTML = '';
    state.owners.forEach((owner, index) => {
      const id = `publishOwner-${owner.login}`;
      const wrapper = document.createElement('div');
      wrapper.className = 'form-check';
      wrapper.innerHTML = `
        <input class="form-check-input" type="radio" name="publishOwner" id="${id}" value="${escapeHtml(
          owner.login
        )}" ${index === 0 ? 'checked' : ''}>
        <label class="form-check-label" for="${id}">
          <span class="d-inline-flex align-items-center gap-2">
            <img src="${escapeHtml(owner.avatar_url)}" alt="" width="24" height="24" class="rounded-circle">
            <span>${escapeHtml(owner.login)}</span>
          </span>
        </label>
      `;
      container.appendChild(wrapper);
    });
  }

  async function ensureRepo(owner, name, options) {
    const payload = {
      name,
      private: options.private,
      auto_init: options.autoInit
    };
    if (owner === state.account.login) {
      return githubRequest('/user/repos', { method: 'POST', body: payload });
    }
    return githubRequest(`/orgs/${encodeURIComponent(owner)}/repos`, {
      method: 'POST',
      body: payload
    });
  }

  async function loadBranches(owner, repo) {
    const branches = await fetchAllPages(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
      { per_page: 100 }
    );
    state.branchList = branches.map((branch) => branch.name);
    updateBranchSelectOptions();
    return state.branchList;
  }

  function updateBranchSelectOptions() {
    const currentValue = state.selectedBranch || 'gh-pages';
    const options = new Set(['gh-pages', ...state.branchList]);
    const select = ui.branchSelect;
    select.empty();
    options.forEach((branch) => {
      const option = new Option(branch, branch, false, branch === currentValue);
      select.append(option);
    });
    select.val(currentValue).trigger('change');
  }

  async function ensureBranch(owner, repo, branch) {
    const branchName = branch.trim();
    try {
      return await githubRequest(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(
          branchName
        )}`
      );
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
      const repoData = await githubRequest(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
      );
      const defaultBranch = repoData.default_branch;

      let baseSha;
      try {
        const ref = await githubRequest(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
            repo
          )}/git/ref/heads/${encodeURIComponent(defaultBranch)}`
        );
        baseSha = ref.object.sha;
      } catch (refError) {
        // 404 = branch doesn't exist, 409 = branch exists but has no commits
        if (refError.status !== 404 && refError.status !== 409) {
          throw refError;
        }
        // Repository is empty - inform user
        const error = new Error('Git Repository is empty. The repo should have at least one file, add a readme');
        error.status = 400;
        throw error;

      }

      await githubRequest(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
        {
          method: 'POST',
          body: {
            ref: `refs/heads/${branchName}`,
            sha: baseSha
          }
        }
      );
      return { name: branchName };
    }
  }

  async function branchHasFiles(owner, repo, branch) {
    try {
      const res = await fetch(
        `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
          repo
        )}/contents?ref=${encodeURIComponent(branch)}`,
        { headers: githubHeaders() }
      );
      logRateLimitIfNeeded(res);
      if (res.status === 404) {
        return false;
      }
      if (!res.ok) {
        const err = new Error(`Failed to inspect branch contents: ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      if (Array.isArray(data)) {
        return data.length > 0;
      }
      return Boolean(data);
    } catch (error) {
      if (error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  async function publishToGitHub({ owner, repo, branch, files, force }) {
    if (!files || !files.length) {
      throw new Error('Nothing to publish.');
    }
    const message = 'Publish site with eXeLearning viewer';

    if (files.length <= 50) {
      setProgress(60, 'Uploading files…');
      await uploadWithContentsApi(owner, repo, branch, files, message, force);
    } else {
      setProgress(60, 'Uploading files…');
      await uploadWithGitDataApi(owner, repo, branch, files, message, force);
    }

    if (branch === 'gh-pages') {
      setProgress(90, 'Enabling GitHub Pages…');
      await enablePages(owner, repo);
    }
    setProgress(100, 'Done.');
  }

  async function uploadWithContentsApi(owner, repo, branch, files, message, force) {
    const totalFiles = files.length;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const encodedPath = encodeContentPath(file.path);
      const resource = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
        repo
      )}/contents/${encodedPath}`;
      let existingSha = undefined;
      if (force) {
        try {
          const res = await githubRequest(`${resource}?ref=${encodeURIComponent(branch)}`, {});
          existingSha = res.sha;
        } catch (error) {
          if (error.status !== 404) {
            throw error;
          }
        }
      }
      await githubRequest(resource, {
        method: 'PUT',
        body: {
          message,
          content: file.base64Content,
          branch,
          sha: existingSha
        }
      });
      logStep(`${file.path} uploaded`);
      // Update progress: 60% to 90% range distributed across files
      const progress = 60 + Math.floor((30 * (i + 1)) / totalFiles);
      setProgress(progress, `Uploading files… (${i + 1}/${totalFiles})`);
    }
  }

  async function uploadWithGitDataApi(owner, repo, branch, files, message, force) {
    const ref = await githubRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(
        branch
      )}`
    );
    const baseCommitSha = ref.object.sha;
    const baseCommit = await githubRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${baseCommitSha}`
    );

    const treeEntries = [];
    const totalFiles = files.length;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const blob = await githubRequest(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`,
        {
          method: 'POST',
          body: {
            content: file.base64Content,
            encoding: 'base64'
          }
        }
      );
      treeEntries.push({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha
      });
      // Update progress: 60% to 85% range distributed across blob uploads
      const progress = 60 + Math.floor((25 * (i + 1)) / totalFiles);
      setProgress(progress, `Uploading blobs… (${i + 1}/${totalFiles})`);
    }

    setProgress(86, 'Creating tree…');
    const tree = await githubRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`,
      {
        method: 'POST',
        body: {
          base_tree: baseCommit.tree.sha,
          tree: treeEntries
        }
      }
    );

    setProgress(88, 'Creating commit…');
    const commit = await githubRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`,
      {
        method: 'POST',
        body: {
          message,
          tree: tree.sha,
          parents: [baseCommitSha]
        }
      }
    );

    setProgress(90, 'Updating branch…');
    await githubRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(
        branch
      )}`,
      {
        method: 'PATCH',
        body: {
          sha: commit.sha,
          force
        }
      }
    );

    logStep('Atomic commit created');
  }

  async function enablePages(owner, repo) {
    try {
      await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pages`, {
        method: 'POST',
        body: {
          source: {
            branch: 'gh-pages',
            path: '/'
          }
        }
      });
      logStep('GitHub Pages enabled');
    } catch (error) {
      if (error.status === 409) {
        logStep('GitHub Pages already enabled');
        return;
      }
      throw error;
    }
  }

  function logStep(message, ok = true) {
    if (!ui.logList) return;
    const item = document.createElement('li');
    let statusClass = 'text-success';
    let icon = '✓';
    if (ok === false) {
      statusClass = 'text-danger';
      icon = '⚠️';
    } else if (ok === 'warning') {
      statusClass = 'text-warning';
      icon = '⚠️';
    }
    item.className = statusClass;
    item.innerHTML = `<span class="me-2">${icon}</span>${escapeHtml(message)}`;
    ui.logList.appendChild(item);
  }

  function stopProgressAnimation() {
    if (!ui.progressBar) {
      return;
    }
    ui.progressBar.classList.remove('progress-bar-striped', 'progress-bar-animated');
    ui.progressBar.classList.add('bg-success');
  }

  function startProgressAnimation() {
    if (!ui.progressBar) {
      return;
    }
    ui.progressBar.classList.add('progress-bar-striped', 'progress-bar-animated');
    ui.progressBar.classList.remove('bg-success');
  }

  function updateSuccessActions() {
    if (!ui.defaultActions || !ui.successActions) {
      return;
    }

    const info = state.publishSuccessInfo;
    if (!info) {
      ui.defaultActions.classList.remove('d-none');
      ui.successActions.classList.add('d-none');
      if (ui.successRepoButton) {
        ui.successRepoButton.href = '#';
      }
      if (ui.successSiteButton) {
        ui.successSiteButton.href = '#';
        ui.successSiteButton.classList.add('d-none');
      }
      if (ui.successHint) {
        ui.successHint.classList.add('d-none');
      }
      return;
    }

    const { owner, repo, branch } = info;
    ui.defaultActions.classList.add('d-none');
    ui.successActions.classList.remove('d-none');
    if (ui.successRepoButton) {
      ui.successRepoButton.href = `https://github.com/${owner}/${repo}`;
    }

    const isGhPages = branch === 'gh-pages';
    if (ui.successSiteButton) {
      if (isGhPages) {
        ui.successSiteButton.href = `https://${owner}.github.io/${repo}/`;
        ui.successSiteButton.classList.remove('d-none');
      } else {
        ui.successSiteButton.href = '#';
        ui.successSiteButton.classList.add('d-none');
      }
    }
    if (ui.successHint) {
      if (isGhPages) {
        ui.successHint.classList.remove('d-none');
      } else {
        ui.successHint.classList.add('d-none');
      }
    }
  }

  function setProgress(percent, message) {
    ui.progressSection.classList.remove('d-none');
    ui.progressBar.style.width = `${percent}%`;
    ui.progressBar.setAttribute('aria-valuenow', String(percent));
    ui.progressBar.textContent = `${percent}%`;
    if (message) {
      ui.progressMessage.textContent = message;
    }
  }

  function showDevicePanel(payload) {
    if (!ui.devicePanel) {
      console.error('publishDevicePanel element not found!');
      return;
    }
    console.log('Showing device panel with payload:', payload);
    ui.devicePanel.classList.remove('d-none');
    ui.devicePanel.removeAttribute('aria-hidden');
    if (ui.deviceCode) {
      ui.deviceCode.textContent = payload?.user_code || '—';
    }
    if (ui.deviceLink) {
      const uri = payload?.verification_uri || 'https://github.com/login/device';
      ui.deviceLink.href = uri;
      ui.deviceLink.textContent = uri.replace(/^https?:\/\//i, '');
    }
    if (ui.deviceExpiry) {
      const expiresIn = Number(payload?.expires_in) || 0;
      const minutes = Math.max(1, Math.round(expiresIn / 60));
      ui.deviceExpiry.textContent = `Code expires in approximately ${minutes} minute${minutes === 1 ? '' : 's'}.`;
    }
  }

  function hideDevicePanel() {
    if (!ui.devicePanel) {
      return;
    }
    ui.devicePanel.classList.add('d-none');
    ui.devicePanel.setAttribute('aria-hidden', 'true');
    if (ui.deviceCode) {
      ui.deviceCode.textContent = '—';
    }
    if (ui.deviceExpiry) {
      ui.deviceExpiry.textContent = '';
    }
  }

  function stopDeviceFlow() {
    if (state.devicePollingTimer) {
      clearTimeout(state.devicePollingTimer);
      state.devicePollingTimer = null;
    }
    state.deviceFlowState = null;
    state.deviceProxyUsed = false;
  }

  async function startDeviceFlow() {
    const clientId = window.APP_CONFIG?.githubClientId;
    if (!clientId) {
      ui.errorAlert.classList.remove('d-none');
      ui.errorAlert.textContent =
        'Missing GitHub OAuth Client ID. Update the configuration to continue.';
      logStep('Missing GitHub OAuth Client ID.', false);
      return;
    }

    stopDeviceFlow();
    hideDevicePanel();
    state.deviceProxyUsed = false;
    ui.errorAlert.classList.add('d-none');
    if (ui.signInButton) {
      ui.signInButton.disabled = true;
      ui.signInButton.classList.add('d-none');
    }
    if (ui.accountStatus) {
      ui.accountStatus.textContent = 'Connecting to GitHub...';
    }
    if (ui.formWrapper) {
      ui.formWrapper.classList.add('d-none');
      ui.formWrapper.setAttribute('aria-hidden', 'true');
    }

    try {
      const payload = await requestDeviceEndpoint(DEVICE_AUTH_ENDPOINT, {
        client_id: clientId,
        scope: DEVICE_SCOPE
      });
      state.deviceFlowState = payload;
      logStep('GitHub sign-in started. Waiting for authorization…');
      showDevicePanel(payload);
      if (ui.accountStatus) {
        ui.accountStatus.textContent = 'Open the link below and enter the code to authenticate.';
      }
      pollDeviceFlow();
    } catch (error) {
      console.error('Device flow start failed', error);
      ui.errorAlert.classList.remove('d-none');
      ui.errorAlert.textContent = 'Unable to start GitHub sign-in. Please try again.';
      logStep('Unable to start GitHub sign-in.', false);
      if (ui.signInButton) {
        ui.signInButton.disabled = false;
        ui.signInButton.classList.remove('d-none');
      }
      hideDevicePanel();
      state.deviceFlowState = null;
    }
  }

  function pollDeviceFlow() {
    if (!state.deviceFlowState) {
      return;
    }
    const clientId = window.APP_CONFIG?.githubClientId;
    if (!clientId) {
      return;
    }
    const interval = Math.max(Number(state.deviceFlowState.interval) || 5, 1);
    const delay = interval * 1000 + DEVICE_POLL_BUFFER;

    state.devicePollingTimer = setTimeout(async () => {
      state.devicePollingTimer = null;
      try {
        const response = await requestDeviceEndpoint(DEVICE_TOKEN_ENDPOINT, {
          client_id: clientId,
          device_code: state.deviceFlowState.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        });

        if (response.error) {
          if (response.error === 'authorization_pending') {
            pollDeviceFlow();
            return;
          }
          if (response.error === 'slow_down') {
            state.deviceFlowState.interval = interval + 5;
            pollDeviceFlow();
            return;
          }
          throw new Error(response.error_description || 'Authorization denied.');
        }

        sessionStorage.setItem(TOKEN_STORAGE_KEY, response.access_token);
        state.deviceFlowState = null;
        hideDevicePanel();
        logStep('GitHub authorization received.');

        if (ui.accountStatus) {
          ui.accountStatus.textContent = 'Signing in…';
        }

        try {
          await loadAccount();
          await loadOwners();
          ui.errorAlert.classList.add('d-none');
          stopDeviceFlow();
        } catch (error) {
          console.error('Account load failed after sign-in', error);
          setSignedOutState('Unable to load GitHub account. Check your access token.');
          ui.errorAlert.classList.remove('d-none');
          ui.errorAlert.textContent = 'Unable to load GitHub account. Check your access token.';
          stopDeviceFlow();
          return;
        }

        if (ui.signInButton) {
          ui.signInButton.disabled = false;
          ui.signInButton.classList.add('d-none');
        }
        if (ui.signOutButton) {
          ui.signOutButton.classList.remove('d-none');
          ui.signOutButton.disabled = false;
        }
      } catch (error) {
        console.error('Device flow polling failed', error);
        ui.errorAlert.classList.remove('d-none');
        ui.errorAlert.textContent = error.message || 'GitHub sign-in failed. Please try again.';
        logStep('GitHub sign-in failed.', false);
        if (ui.signInButton) {
          ui.signInButton.disabled = false;
        }
        stopDeviceFlow();
        state.deviceFlowState = null;
      }
    }, delay);
  }

  function resetProgress() {
    ui.progressSection.classList.add('d-none');
    ui.progressBar.style.width = '0%';
    ui.progressBar.removeAttribute('aria-valuenow');
    ui.progressBar.textContent = '';
    ui.progressMessage.textContent = 'Preparing…';
    ui.logList.innerHTML = '';
    ui.successAlert.classList.add('d-none');
    ui.errorAlert.classList.add('d-none');
    state.rateLimitWarned = false;
    state.publishSuccessInfo = null;
    startProgressAnimation();
    updateSuccessActions();
  }

  function getSelectedOwner() {
    const checked = ui.ownerOptions.querySelector('input[name="publishOwner"]:checked');
    return checked ? checked.value : null;
  }

  function getRepositoryFormState() {
    if (!state.account) {
      return null;
    }
    const selectData = ui.repoSelect?.select2('data')[0];
    if (!selectData || !selectData.id) {
      return null;
    }
    if (selectData.isNew || String(selectData.id).startsWith(NEW_REPO_PREFIX)) {
      return {
        isNew: true,
        name: selectData.isNew
          ? selectData.text
          : String(selectData.id).replace(NEW_REPO_PREFIX, '')
      };
    }
    return {
      isNew: false,
      owner: selectData.owner,
      repo: selectData.repo,
      fullName: selectData.text,
      data: selectData
    };
  }

  function updateRepoSelectionUI() {
    if (!state.account) {
      state.selectedRepo = null;
      validateForm();
      return;
    }
    const repoState = getRepositoryFormState();
    state.isCreatingRepo = repoState ? repoState.isNew : false;
    if (state.isCreatingRepo) {
      ui.newRepoCard.hidden = false;
      ui.newRepoCard.removeAttribute('aria-hidden');
      ui.repoValidation.hidden = true;
      ui.repoValidation.textContent = '';
      if (!getSelectedOwner()) {
        const firstRadio = ui.ownerOptions.querySelector('input[name="publishOwner"]');
        if (firstRadio) {
          firstRadio.checked = true;
        }
      }
    } else {
      ui.newRepoCard.hidden = true;
      ui.newRepoCard.setAttribute('aria-hidden', 'true');
    }
    state.selectedRepo = repoState;
    validateForm();
  }

  function showBranchMessage() {
    if (!state.branchExists) {
      ui.branchHint.textContent = 'This branch will be created from the default branch.';
    } else {
      ui.branchHint.textContent = '';
    }

    if (state.branchHasContent) {
      ui.branchWarning.classList.remove('d-none');
      ui.overwriteGroup.classList.remove('d-none');
    } else {
      ui.branchWarning.classList.add('d-none');
      ui.overwriteGroup.classList.add('d-none');
      ui.overwriteCheckbox.checked = false;
    }
  }

  function validateForm() {
    if (!state.account) {
      ui.submitButton.disabled = true;
      return;
    }
    const repoState = state.selectedRepo;
    const branch = state.selectedBranch && state.selectedBranch.trim();
    let valid = true;

    if (!repoState) {
      valid = false;
    } else if (repoState.isNew) {
      const owner = getSelectedOwner();
      if (!owner) {
        ui.ownerValidation.hidden = false;
        ui.ownerValidation.textContent = 'Pick an owner to continue.';
        valid = false;
      } else {
        ui.ownerValidation.hidden = true;
      }
    }

    if (!branch) {
      valid = false;
    }

    if (state.branchHasContent && !ui.overwriteCheckbox.checked) {
      valid = false;
    }

    if (state.isPublishing) {
      valid = false;
    }

    ui.submitButton.disabled = !valid;
  }

  function clearValidation() {
    ui.repoValidation.hidden = true;
    ui.repoValidation.textContent = '';
    ui.ownerValidation.hidden = true;
    ui.ownerValidation.textContent = '';
  }

  function disableFormControls() {
    state.isPublishing = true;
    state.publishAbortController = new AbortController();
    state.publishCancelled = false;

    // Prevent closing modal by clicking outside
    const modalInstance = bootstrap.Modal.getInstance(ui.modal);
    if (modalInstance) {
      modalInstance._config.backdrop = 'static';
      modalInstance._config.keyboard = false;
    }

    ui.submitButton.disabled = true;
    ui.submitButton.innerHTML =
      '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Publishing…';
    ui.modal.querySelectorAll('input, select, button, textarea').forEach((el) => {
      if (el.id !== 'publishSuccessDismiss' && !el.hasAttribute('data-bs-dismiss') && el.className.indexOf('btn-close') === -1) {
        el.disabled = true;
      }
    });

    // Enable close buttons but change their behavior
    const closeButtons = ui.modal.querySelectorAll('[data-bs-dismiss="modal"], .btn-close');
    closeButtons.forEach((btn) => {
      btn.disabled = false;
    });
  }

  function enableFormControls(keepSuccessState = false) {
    state.isPublishing = false;
    state.publishAbortController = null;
    state.publishCancelled = false;

    // Re-enable closing modal by clicking outside
    const modalInstance = bootstrap.Modal.getInstance(ui.modal);
    if (modalInstance) {
      modalInstance._config.backdrop = true;
      modalInstance._config.keyboard = true;
    }

    ui.modal.querySelectorAll('input, select, button, textarea').forEach((el) => {
      if (el.dataset.bsDismiss === 'modal' || el.closest('#publishProgressSection')) {
        el.disabled = false;
        return;
      }
      el.disabled = false;
    });

    if (!keepSuccessState) {
      ui.submitButton.innerHTML = 'Publish';
      validateForm();
      if (!state.account) {
        if (ui.repoSelect) {
          ui.repoSelect.prop('disabled', true);
        }
        if (ui.branchSelect) {
          ui.branchSelect.prop('disabled', true);
        }
        ui.submitButton.disabled = true;
      }
    }
    updateSuccessActions();
  }

  function resetModal() {
    hideDevicePanel();
    stopDeviceFlow();
    state.isCreatingRepo = false;
    state.selectedRepo = null;
    state.selectedBranch = 'gh-pages';
    state.branchExists = false;
    state.branchHasContent = false;
    state.isPublishing = false;
    ui.repoSelect.val(null).trigger('change');
    ui.branchSelect.val('gh-pages').trigger('change');
    ui.overwriteCheckbox.checked = false;
    ui.overwriteGroup.classList.add('d-none');
    ui.branchWarning.classList.add('d-none');
    ui.branchHint.textContent = '';
    ui.newRepoCard.hidden = true;
    ui.errorAlert.classList.add('d-none');
    clearValidation();
    resetProgress();
    enableFormControls();
  }

  async function handleRepoChange() {
    if (!state.account) {
      return;
    }
    clearValidation();
    const repoState = getRepositoryFormState();
    state.branchList = [];
    state.branchExists = false;
    state.branchHasContent = false;
    updateRepoSelectionUI();
    if (!repoState || repoState.isNew) {
      ui.branchSelect.val('gh-pages').trigger('change');
      state.selectedBranch = 'gh-pages';
      state.branchExists = false;
      state.branchHasContent = false;
      showBranchMessage();
      return;
    }
    try {
      const branches = await loadBranches(repoState.owner, repoState.repo);
      state.branchExists = branches.includes(state.selectedBranch);
      if (state.branchExists) {
        state.branchHasContent = await branchHasFiles(
          repoState.owner,
          repoState.repo,
          state.selectedBranch
        );
      } else {
        state.branchHasContent = false;
      }
      showBranchMessage();
      validateForm();
    } catch (error) {
      handleError(error);
    }
  }

  function handleBranchChange(event) {
    if (!state.account) {
      return;
    }
    const value = event.target ? event.target.value : ui.branchSelect.val();
    const branch = (value || '').trim();
    state.selectedBranch = branch;
    state.branchExists = state.branchList.includes(branch);
    if (!state.selectedRepo || state.selectedRepo.isNew || !branch) {
      state.branchHasContent = false;
      showBranchMessage();
      validateForm();
      return;
    }
    const { owner, repo } = state.selectedRepo;
    state.branchExists = state.branchList.includes(branch);
    if (!state.branchExists) {
      state.branchHasContent = false;
      showBranchMessage();
      validateForm();
      return;
    }
    branchHasFiles(owner, repo, branch)
      .then((hasFiles) => {
        state.branchHasContent = hasFiles;
        showBranchMessage();
        validateForm();
      })
      .catch((error) => {
        handleError(error);
      });
  }

  function handleOverwriteChange() {
    validateForm();
  }

  function setSignedOutState(message = 'Sign in with GitHub to continue.', options = {}) {
    const { clearToken = true } = options;
    state.account = null;
    state.owners = [];
    state.userReposLoaded = false;
    state.repoOptions = [];
    state.orgRepoCache.clear();
    state.branchList = [];
    state.selectedRepo = null;
    state.selectedBranch = 'gh-pages';
    state.branchExists = false;
    state.branchHasContent = false;
    state.isPublishing = false;
    hideDevicePanel();
    stopDeviceFlow();
    if (clearToken) {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      sessionStorage.removeItem(USER_STORAGE_KEY);
    }
    resetProgress();
    clearValidation();
    ui.repoValidation.hidden = true;
    ui.repoValidation.textContent = '';
    ui.ownerValidation.hidden = true;
    ui.ownerValidation.textContent = '';
    if (ui.repoSelect) {
      ui.repoSelect.val(null).trigger('change');
      ui.repoSelect.prop('disabled', true);
    }
    if (ui.branchSelect) {
      ui.branchSelect.val('gh-pages').trigger('change');
      ui.branchSelect.prop('disabled', true);
    }
    if (ui.formWrapper) {
      ui.formWrapper.classList.add('d-none');
      ui.formWrapper.setAttribute('aria-hidden', 'true');
    }
    ui.branchHint.textContent = '';
    ui.branchWarning.classList.add('d-none');
    ui.overwriteGroup.classList.add('d-none');
    ui.overwriteCheckbox.checked = false;
    ui.newRepoCard.hidden = true;
    ui.newRepoCard.setAttribute('aria-hidden', 'true');
    if (ui.ownerOptions) {
      ui.ownerOptions.innerHTML = '';
    }
    if (ui.accountName) {
      ui.accountName.textContent = 'Not signed in.';
    }
    if (ui.accountStatus) {
      ui.accountStatus.textContent = message;
    }
    if (ui.accountAvatar) {
      ui.accountAvatar.src = '';
      ui.accountAvatar.alt = '';
      ui.accountAvatar.classList.add('d-none');
    }
    if (ui.signInButton) {
      ui.signInButton.classList.remove('d-none');
      ui.signInButton.disabled = false;
    }
    if (ui.signOutButton) {
      ui.signOutButton.classList.add('d-none');
      ui.signOutButton.disabled = true;
    }
    ui.errorAlert.classList.add('d-none');
    ui.submitButton.innerHTML = 'Publish';
    ui.submitButton.disabled = true;
  }

  function handleSuccess({ owner, repo, branch }) {
    state.publishSuccessInfo = { owner, repo, branch };
    stopProgressAnimation();
    updateSuccessActions();

    // Enable form controls but keep success state
    enableFormControls(true);

    ui.successAlert.classList.remove('d-none');
    const focusTarget =
      (ui.successSiteButton && !ui.successSiteButton.classList.contains('d-none') && ui.successSiteButton) ||
      ui.successRepoButton ||
      ui.successClose;
    focusTarget?.focus();

    if (ui.submitButton) {
      ui.submitButton.disabled = true;
    }
  }

  function handleError(error) {
    if (error && error.status === 401) {
      setSignedOutState('Sign in again to continue.');
      ui.errorAlert.classList.remove('d-none');
      ui.errorAlert.textContent = 'Your GitHub session expired. Please sign in again.';
      logStep('Authentication required', false);
      return;
    }
    ui.errorAlert.classList.remove('d-none');
    if (error && error.message) {
      ui.errorAlert.textContent = error.message;
      logStep(error.message, false);
    } else if (error && error.body && error.body.message) {
      ui.errorAlert.textContent = error.body.message;
      logStep(error.body.message, false);
    } else if (error && error.status === 403) {
      ui.errorAlert.textContent =
        "You don't have permission to create repositories under this owner. Try another owner.";
      logStep('Permission denied', false);
    } else {
      ui.errorAlert.textContent = 'Something went wrong. Please try again.';
      logStep('Error encountered', false);
    }
    enableFormControls();
  }

  function cancelPublishing() {
    if (!state.isPublishing) {
      return;
    }
    state.publishCancelled = true;
    if (state.publishAbortController) {
      state.publishAbortController.abort();
    }
    logStep('Publishing cancelled by user', false);
    ui.errorAlert.classList.remove('d-none');
    ui.errorAlert.textContent = 'Publishing was cancelled.';
    enableFormControls();
  }

  async function handleSubmit() {
    const repoState = state.selectedRepo;
    const branch = state.selectedBranch.trim();
    if (!repoState || !branch) {
      return;
    }
    clearValidation();
    ui.errorAlert.classList.add('d-none');
    resetProgress();
    disableFormControls();
    logStep('Preparing…');
    setProgress(10, 'Preparing…');

    let ownerLogin = repoState.owner;
    let repoName = repoState.repo;
    let repoData = repoState.data;

    try {
      if (repoState.isNew) {
        setProgress(20, 'Creating repository…');
        logStep('Creating repository…');
        const owner = getSelectedOwner();
        if (!owner) {
          throw new Error('Owner is required.');
        }
        const options = {
          private: ui.repoVisibility.checked,
          autoInit: true
        };
        try {
          repoData = await ensureRepo(owner, repoState.name, options);
          ownerLogin = repoData.owner.login;
          repoName = repoData.name;
          const cachedRepo = cacheRepoOption(repoData);
          if (repoData.owner.type === 'Organization') {
            const orgRepos = state.orgRepoCache.get(repoData.owner.login) || [];
            orgRepos.push(cachedRepo);
            state.orgRepoCache.set(repoData.owner.login, orgRepos);
          } else {
            state.repoOptions.push(cachedRepo);
          }
          logStep('Repository created');
        } catch (error) {
          if (error.status === 403) {
            ui.errorAlert.classList.remove('d-none');
            ui.errorAlert.textContent =
              'You don’t have permission to create repositories under this owner. Try another owner.';
            logStep('Permission denied while creating repository', false);
          } else {
            ui.errorAlert.classList.remove('d-none');
            ui.errorAlert.textContent =
              error.body?.message || 'Something went wrong. Please try again.';
            logStep('Repository creation failed', false);
          }
          throw error;
        }
      }

      setProgress(40, 'Creating branch…');
      logStep('Creating branch…');
      await ensureBranch(ownerLogin, repoName, branch);
      if (!state.branchList.includes(branch)) {
        state.branchList.push(branch);
        updateBranchSelectOptions();
      }
      logStep('Branch ready');

      const hasFiles = await branchHasFiles(ownerLogin, repoName, branch);
      state.branchHasContent = hasFiles;
      const force = hasFiles;

      const files = typeof getFilesToPublish === 'function' ? await getFilesToPublish() : [];
      if (!files || !files.length) {
        throw new Error('No files to publish. Please prepare your site first.');
      }

      logStep('Uploading files…');
      await publishToGitHub({ owner: ownerLogin, repo: repoName, branch, files, force });

      logStep('Done.');
      handleSuccess({ owner: ownerLogin, repo: repoName, branch });
    } catch (error) {
      if (error.name === 'AbortError' || state.publishCancelled) {
        // Already handled in cancelPublishing
        return;
      }
      handleError(error);
      return;
    }
  }

  function bindEvents() {
    ui.repoSelect.on('select2:select', handleRepoChange);
    ui.repoSelect.on('select2:clear', handleRepoChange);
    ui.branchSelect.on('change', handleBranchChange);
    ui.overwriteCheckbox.addEventListener('change', handleOverwriteChange);
    ui.submitButton.addEventListener('click', handleSubmit);
    ui.successDismiss.addEventListener('click', () => ui.successAlert.classList.add('d-none'));
    ui.ownerOptions.addEventListener('change', () => {
      ui.ownerValidation.hidden = true;
      validateForm();
    });
    if (ui.signInButton) {
      ui.signInButton.addEventListener('click', startDeviceFlow);
    }
    ui.signOutButton.addEventListener('click', () => {
      try {
        if (typeof onSignOut === 'function') {
          const result = onSignOut();
          if (result && typeof result.then === 'function') {
            result.catch((error) => {
              console.error('Sign out failed', error);
            });
          }
        }
      } catch (error) {
        console.error('Sign out handler threw an error', error);
      } finally {
        setSignedOutState();
        logStep('Signed out.');
      }
    });

    $('#publishModal').on('shown.bs.modal', async () => {
      if (!state.account) {
        const token = readStoredToken();
        if (token) {
          try {
            await loadAccount();
            await loadOwners();
          } catch (error) {
            console.error('Failed to refresh GitHub account', error);
            setSignedOutState('Sign in with GitHub to continue.');
            ui.errorAlert.classList.remove('d-none');
            ui.errorAlert.textContent = 'Unable to load GitHub account. Check your access token.';
            return;
          }
        } else {
          setSignedOutState('Sign in with GitHub to continue.', { clearToken: false });
        }
      }
      if (state.account) {
        setTimeout(() => {
          ui.repoSelect.select2('open');
        }, 0);
      }
    });

    $('#publishModal').on('hide.bs.modal', (event) => {
      if (state.isPublishing) {
        // Prevent modal from closing
        event.preventDefault();
        // Cancel the publishing process
        cancelPublishing();
        // Now allow it to close
        setTimeout(() => {
          $('#publishModal').modal('hide');
        }, 100);
      }
    });

    $('#publishModal').on('hidden.bs.modal', () => {
      resetModal();
      if (!state.account) {
        setSignedOutState('Sign in with GitHub to continue.', { clearToken: false });
      }
    });
  }

  async function initPublishModal() {
    ui.modal = document.getElementById('publishModal');
    ui.accountName = document.getElementById('publishAccountName');
    ui.accountStatus = document.getElementById('publishAccountStatus');
    ui.accountAvatar = document.getElementById('publishAccountAvatar');
    ui.signInButton = document.getElementById('publishSignIn');
    ui.signOutButton = document.getElementById('publishSignOut');
    ui.formWrapper = document.getElementById('publishFormWrapper');
    ui.devicePanel = document.getElementById('publishDevicePanel');
    ui.deviceCode = document.getElementById('publishDeviceCode');
    ui.deviceLink = document.getElementById('publishDeviceLink');
    ui.deviceExpiry = document.getElementById('publishDeviceExpiry');
    ui.repoValidation = document.getElementById('publishRepoValidation');
    ui.ownerOptions = document.getElementById('publishOwnerOptions');
    ui.ownerValidation = document.getElementById('publishOwnerValidation');
    ui.newRepoCard = document.getElementById('publishNewRepoCard');
    ui.repoVisibility = document.getElementById('publishRepoVisibility');
    ui.branchHint = document.getElementById('publishBranchHint');
    ui.branchWarning = document.getElementById('publishBranchWarning');
    ui.overwriteGroup = document.getElementById('publishOverwriteGroup');
    ui.overwriteCheckbox = document.getElementById('publishOverwrite');
    ui.progressSection = document.getElementById('publishProgressSection');
    ui.progressBar = document.getElementById('publishProgressBar');
    ui.progressMessage = document.getElementById('publishProgressMessage');
    ui.logList = document.getElementById('publishLog');
    ui.successAlert = document.getElementById('publishSuccessAlert');
    ui.errorAlert = document.getElementById('publishErrorAlert');
    ui.successDismiss = document.getElementById('publishSuccessDismiss');
    ui.submitButton = document.getElementById('publishSubmit');
    ui.defaultActions = document.getElementById('publishDefaultActions');
    ui.successActions = document.getElementById('publishSuccessActions');
    ui.successRepoButton = document.getElementById('publishSuccessRepoButton');
    ui.successSiteButton = document.getElementById('publishSuccessSiteButton');
    ui.successHint = document.getElementById('publishSuccessHint');
    ui.successClose = document.getElementById('publishSuccessClose');

    initSelect2();
    bindEvents();
    setSignedOutState('Sign in with GitHub to continue.', { clearToken: false });

    const token = readStoredToken();
    if (token) {
      try {
        await loadAccount();
        await loadOwners();
      } catch (error) {
        console.error('Failed to load GitHub account', error);
        setSignedOutState('Sign in with GitHub to continue.');
        ui.errorAlert.classList.remove('d-none');
        ui.errorAlert.textContent = 'Unable to load GitHub account. Check your access token.';
      }
    }
  }

  window.initPublishModal = initPublishModal;
  window.loadAccount = loadAccount;
  window.loadOwners = loadOwners;
  window.searchRepos = searchRepos;
  window.ensureRepo = ensureRepo;
  window.loadBranches = loadBranches;
  window.ensureBranch = ensureBranch;
  window.branchHasFiles = branchHasFiles;
  window.publishToGitHub = publishToGitHub;
  window.logStep = logStep;
  window.setProgress = setProgress;

  document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('publishModal')) {
      initPublishModal().catch((error) => {
        console.error('Failed to initialize publish modal', error);
      });
    }
  });
})();
