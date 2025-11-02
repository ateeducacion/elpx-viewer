import { Octokit } from 'https://cdn.jsdelivr.net/npm/@octokit/rest@20.1.1/+esm';
import {
  isValidBranchName,
  buildTreeEntriesFromFiles,
  computePagesUrl
} from './github-utils.js';

const DEVICE_AUTH_ENDPOINT = 'https://github.com/login/device/code';
const DEVICE_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
const DEFAULT_SCOPES = ['repo'];
const TOKEN_STORAGE_KEY = 'github_device_token';
const USER_STORAGE_KEY = 'github_device_user';

export class GitHubPublisher {
  constructor({ button, modalElement, toast, formatBytes }) {
    this.button = button;
    this.modalElement = modalElement;
    this.toast = typeof toast === 'function' ? toast : (() => {});
    this.formatBytes = formatBytes || ((value) => `${value} B`);

    this.elements = this.getElements();
    this.modal = this.modalElement ? bootstrap.Modal.getOrCreateInstance(this.modalElement) : null;

    this.clientId = window.APP_CONFIG?.githubClientId;
    this.defaultPagesBranch = window.APP_CONFIG?.defaultPagesBranch || 'gh-pages';
    this.deviceFlowProxy = window.APP_CONFIG?.deviceFlowProxy || '';

    this.archive = null;
    this.sessionUnsupported = false;
    this.deviceFlowState = null;
    this.pollingTimeout = null;
    this.publishAbort = null;
    this.isPublishingFlag = false;
    this.currentAction = 'publish';

    this.token = sessionStorage.getItem(TOKEN_STORAGE_KEY) || null;
    this.user = null;
    this.octokit = null;
    this.repos = [];
    this.filteredRepos = [];
    this.branches = [];
    this.branchExists = false;
    this.publishResult = null;
    this.deviceProxyUsed = false;

    this.initListeners();
    if (this.token) {
      void this.initialiseClient();
    }
  }

  getElements() {
    if (!this.modalElement) {
      return {};
    }
    return {
      authStatus: this.modalElement.querySelector('#authStatus'),
      deviceCodeSection: this.modalElement.querySelector('#deviceCodeSection'),
      deviceUserCode: this.modalElement.querySelector('#deviceUserCode'),
      deviceVerificationUri: this.modalElement.querySelector('#deviceVerificationUri'),
      deviceExpiryNotice: this.modalElement.querySelector('#deviceExpiryNotice'),
      authControls: this.modalElement.querySelector('#authControls'),
      startAuthButton: this.modalElement.querySelector('#startAuthButton'),
      signOutButton: this.modalElement.querySelector('#signOutButton'),
      publishForm: this.modalElement.querySelector('#githubPublishForm'),
      repoFilter: this.modalElement.querySelector('#repoFilter'),
      reloadReposButton: this.modalElement.querySelector('#reloadReposButton'),
      repoSelect: this.modalElement.querySelector('#repoSelect'),
      branchInput: this.modalElement.querySelector('#branchInput'),
      branchOptions: this.modalElement.querySelector('#branchOptions'),
      branchAlert: this.modalElement.querySelector('#branchExistsAlert'),
      overwriteWrapper: this.modalElement.querySelector('#overwriteCheckWrapper'),
      overwriteCheckbox: this.modalElement.querySelector('#overwriteCheckbox'),
      progressSection: this.modalElement.querySelector('#githubProgressSection'),
      progressBar: this.modalElement.querySelector('#publishProgressBar'),
      progressText: this.modalElement.querySelector('#publishProgressText'),
      progressLog: this.modalElement.querySelector('#publishLog'),
      resultSection: this.modalElement.querySelector('#githubResultSection'),
      viewRepoLink: this.modalElement.querySelector('#viewRepoLink'),
      viewSiteLink: this.modalElement.querySelector('#viewSiteLink'),
      resultMessage: this.modalElement.querySelector('#publishResultMessage'),
      primaryButton: this.modalElement.querySelector('#modalPrimaryButton')
    };
  }

  initListeners() {
    if (!this.modalElement) {
      return;
    }

    this.modalElement.addEventListener('show.bs.modal', () => {
      this.onModalShow();
    });

    this.modalElement.addEventListener('hidden.bs.modal', () => {
      this.onModalHidden();
    });

    if (this.elements.startAuthButton) {
      this.elements.startAuthButton.addEventListener('click', () => this.startDeviceFlow());
    }
    if (this.elements.signOutButton) {
      this.elements.signOutButton.addEventListener('click', () => this.signOut());
    }
    if (this.elements.reloadReposButton) {
      this.elements.reloadReposButton.addEventListener('click', () => this.reloadRepositories());
    }
    if (this.elements.repoFilter) {
      this.elements.repoFilter.addEventListener('input', () => this.updateRepoList());
    }
    if (this.elements.repoSelect) {
      this.elements.repoSelect.addEventListener('change', () => this.handleRepoSelection());
    }
    if (this.elements.branchInput) {
      this.elements.branchInput.addEventListener('input', () => this.handleBranchInput());
    }
    if (this.elements.overwriteCheckbox) {
      this.elements.overwriteCheckbox.addEventListener('change', () => this.updatePrimaryButton());
    }
    if (this.elements.primaryButton) {
      this.elements.primaryButton.addEventListener('click', () => this.handlePrimaryAction());
    }
  }

  getDeviceProxy() {
    const proxy = typeof this.deviceFlowProxy === 'string' ? this.deviceFlowProxy.trim() : '';
    if (!proxy) {
      return '';
    }
    return proxy.replace(/\/$/, '');
  }

  applyDeviceProxy(url) {
    const proxy = this.getDeviceProxy();
    if (!proxy) {
      return url;
    }
    return `${proxy}/${url}`;
  }

  isLikelyCorsError(error) {
    return error instanceof TypeError || /Failed to fetch/i.test(error?.message || '');
  }

  async requestDeviceEndpoint(url, params) {
    const attempt = async (targetUrl) => {
      const body = new URLSearchParams(params);
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
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

    if (this.deviceProxyUsed && this.getDeviceProxy()) {
      return attempt(this.applyDeviceProxy(url));
    }

    try {
      return await attempt(url);
    } catch (error) {
      if (!this.deviceProxyUsed && this.getDeviceProxy() && this.isLikelyCorsError(error)) {
        this.deviceProxyUsed = true;
        return attempt(this.applyDeviceProxy(url));
      }
      throw error;
    }
  }

  isPublishing() {
    return this.isPublishingFlag;
  }

  async initialiseClient() {
    if (!this.token) {
      return;
    }
    try {
      this.octokit = new Octokit({ auth: this.token, userAgent: 'ELPX Viewer' });
      const { data } = await this.octokit.rest.users.getAuthenticated();
      this.user = data;
      sessionStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ login: data.login, avatar_url: data.avatar_url }));
      this.renderAuthStatus();
      await this.loadRepositories();
      this.showPublishForm();
    } catch (error) {
      console.error(error);
      this.toast('GitHub authentication failed. Please sign in again.', 'danger');
      this.signOut();
    }
  }

  setArchive(archive, isUnsupported = false) {
    this.archive = archive;
    this.sessionUnsupported = isUnsupported;
    if (this.button) {
      this.button.disabled = !archive;
    }
    this.updatePrimaryButton();
  }

  clearArchive() {
    this.archive = null;
    if (this.button) {
      this.button.disabled = true;
    }
    this.updatePrimaryButton();
  }

  cancelPublish(reason = 'Cancelled') {
    if (this.publishAbort) {
      this.publishAbort.abort();
      this.logProgress(`Cancelled: ${reason}`);
      this.toast('Publish cancelled.', 'warning');
    }
    this.isPublishingFlag = false;
    this.publishAbort = null;
    this.setPrimaryAction('publish');
    this.updatePrimaryButton();
  }

  onModalShow() {
    this.renderAuthStatus();
    if (!this.clientId) {
      this.renderError('Missing GitHub OAuth Client ID. Update config.js.');
      return;
    }
    if (this.sessionUnsupported) {
      this.toast('Publishing disabled: the current package is not compatible.', 'warning');
    }
    if (this.token && this.octokit && this.repos.length === 0) {
      void this.loadRepositories();
    }
    this.updatePrimaryButton();
  }

  onModalHidden() {
    if (this.isPublishing()) {
      this.cancelPublish('Modal closed');
    }
    this.resetProgress();
    this.clearResult();
    if (this.elements.branchInput) {
      this.elements.branchInput.value = this.defaultPagesBranch;
    }
    if (this.elements.overwriteCheckbox) {
      this.elements.overwriteCheckbox.checked = false;
    }
  }

  renderAuthStatus() {
    if (!this.elements.authStatus) {
      return;
    }
    if (!this.token || !this.user) {
      this.elements.authStatus.innerHTML = '<span class="text-muted">Not signed in.</span>';
      this.toggleAuthControls(true);
      this.hidePublishForm();
      return;
    }
    const avatar = this.user.avatar_url ? `<img src="${this.user.avatar_url}" alt="" class="rounded-circle me-2" width="28" height="28">` : '';
    this.elements.authStatus.innerHTML = `<div class="d-flex align-items-center">${avatar}<span>Signed in as <strong>${this.user.login}</strong></span></div>`;
    this.toggleAuthControls(false);
    this.showPublishForm();
  }

  toggleAuthControls(showSignIn) {
    if (!this.elements.authControls) return;
    if (showSignIn) {
      this.elements.startAuthButton?.classList.remove('d-none');
      this.elements.signOutButton?.classList.add('d-none');
    } else {
      this.elements.startAuthButton?.classList.add('d-none');
      this.elements.signOutButton?.classList.remove('d-none');
    }
  }

  renderError(message) {
    if (this.elements.authStatus) {
      this.elements.authStatus.innerHTML = `<div class="alert alert-danger" role="alert">${message}</div>`;
    }
  }

  showDeviceCodePanel(payload) {
    if (!this.elements.deviceCodeSection) return;
    this.elements.deviceCodeSection.classList.remove('d-none');
    this.elements.deviceUserCode.textContent = payload.user_code;
    this.elements.deviceVerificationUri.href = payload.verification_uri;
    this.elements.deviceVerificationUri.textContent = payload.verification_uri;
    const expiryMinutes = Math.round(payload.expires_in / 60);
    this.elements.deviceExpiryNotice.textContent = `Code expires in approximately ${expiryMinutes} minute${expiryMinutes === 1 ? '' : 's'}.`;
  }

  hideDeviceCodePanel() {
    if (!this.elements.deviceCodeSection) return;
    this.elements.deviceCodeSection.classList.add('d-none');
  }

  async startDeviceFlow() {
    if (!this.clientId) {
      this.toast('GitHub OAuth Client ID is missing.', 'danger');
      return;
    }
    this.deviceProxyUsed = false;
    try {
      const payload = await this.requestDeviceEndpoint(DEVICE_AUTH_ENDPOINT, {
        client_id: this.clientId,
        scope: DEFAULT_SCOPES.join(' ')
      });
      this.deviceFlowState = payload;
      this.showDeviceCodePanel(payload);
      this.pollDeviceFlow();
    } catch (error) {
      console.error(error);
      this.toast(error.message || 'GitHub authentication failed.', 'danger');
    }
  }

  pollDeviceFlow() {
    if (!this.deviceFlowState) {
      return;
    }
    const { device_code, interval } = this.deviceFlowState;
    const poll = async () => {
      try {
        const data = await this.requestDeviceEndpoint(DEVICE_TOKEN_ENDPOINT, {
          client_id: this.clientId,
          device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        });
        if (data.error) {
          if (data.error === 'authorization_pending') {
            if (this.pollingTimeout) {
              clearTimeout(this.pollingTimeout);
            }
            this.pollingTimeout = setTimeout(poll, (interval + 1) * 1000);
            return;
          }
          if (data.error === 'slow_down') {
            if (this.pollingTimeout) {
              clearTimeout(this.pollingTimeout);
            }
            this.pollingTimeout = setTimeout(poll, (interval + 5) * 1000);
            return;
          }
          throw new Error(data.error_description || 'Authorization denied.');
        }
        if (this.pollingTimeout) {
          clearTimeout(this.pollingTimeout);
          this.pollingTimeout = null;
        }
        this.token = data.access_token;
        sessionStorage.setItem(TOKEN_STORAGE_KEY, this.token);
        this.hideDeviceCodePanel();
        this.deviceFlowState = null;
        await this.initialiseClient();
      } catch (error) {
        console.error(error);
        this.toast(error.message || 'GitHub sign-in failed.', 'danger');
        this.hideDeviceCodePanel();
        this.deviceFlowState = null;
        if (this.pollingTimeout) {
          clearTimeout(this.pollingTimeout);
          this.pollingTimeout = null;
        }
      }
    };
    if (this.pollingTimeout) {
      clearTimeout(this.pollingTimeout);
    }
    this.pollingTimeout = setTimeout(poll, interval * 1000);
  }

  async signOut() {
    this.token = null;
    this.user = null;
    this.octokit = null;
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    sessionStorage.removeItem(USER_STORAGE_KEY);
    if (this.pollingTimeout) {
      clearTimeout(this.pollingTimeout);
      this.pollingTimeout = null;
    }
    this.hidePublishForm();
    this.renderAuthStatus();
  }

  showPublishForm() {
    if (this.elements.publishForm) {
      this.elements.publishForm.classList.remove('d-none');
    }
    this.updatePrimaryButton();
  }

  hidePublishForm() {
    if (this.elements.publishForm) {
      this.elements.publishForm.classList.add('d-none');
    }
    this.updatePrimaryButton();
  }

  async loadRepositories() {
    if (!this.octokit) {
      return;
    }
    try {
      const repos = await this.octokit.paginate(this.octokit.rest.repos.listForAuthenticatedUser, {
        per_page: 100,
        sort: 'updated'
      });
      this.repos = repos;
      this.updateRepoList();
      if (this.elements.branchInput && !this.elements.branchInput.value) {
        this.elements.branchInput.value = this.defaultPagesBranch;
      }
    } catch (error) {
      console.error(error);
      this.toast('Failed to load repositories.', 'danger');
    }
  }

  async reloadRepositories() {
    this.repos = [];
    await this.loadRepositories();
  }

  updateRepoList() {
    if (!this.elements.repoSelect) return;
    const query = this.elements.repoFilter?.value?.toLowerCase() || '';
    const repos = query
      ? this.repos.filter((repo) => repo.full_name.toLowerCase().includes(query))
      : this.repos;
    this.filteredRepos = repos;
    this.elements.repoSelect.innerHTML = '';
    repos.forEach((repo) => {
      const option = document.createElement('option');
      option.value = repo.full_name;
      option.textContent = repo.full_name;
      option.dataset.defaultBranch = repo.default_branch;
      this.elements.repoSelect.appendChild(option);
    });
    if (repos.length > 0) {
      this.elements.repoSelect.selectedIndex = 0;
      this.handleRepoSelection();
    }
    this.updatePrimaryButton();
  }

  getSelectedRepo() {
    if (!this.elements.repoSelect) return null;
    const value = this.elements.repoSelect.value;
    if (!value) return null;
    return this.repos.find((repo) => repo.full_name === value) || null;
  }

  async handleRepoSelection() {
    const repo = this.getSelectedRepo();
    if (!repo || !this.octokit) {
      return;
    }
    try {
      const [owner, name] = repo.full_name.split('/');
      this.branches = await this.octokit.paginate(this.octokit.rest.repos.listBranches, {
        owner,
        repo: name,
        per_page: 100
      });
      this.populateBranchOptions();
      if (this.elements.branchInput && !this.elements.branchInput.value) {
        this.elements.branchInput.value = this.defaultPagesBranch;
      }
      this.handleBranchInput();
    } catch (error) {
      console.error(error);
      this.toast('Unable to load branches for the selected repository.', 'danger');
    }
  }

  populateBranchOptions() {
    if (!this.elements.branchOptions) return;
    this.elements.branchOptions.innerHTML = '';
    this.branches.forEach((branch) => {
      const option = document.createElement('option');
      option.value = branch.name;
      this.elements.branchOptions.appendChild(option);
    });
  }

  handleBranchInput() {
    const branchName = this.elements.branchInput?.value?.trim();
    this.branchExists = this.branches.some((branch) => branch.name === branchName);
    if (this.branchExists) {
      this.elements.branchAlert?.classList.remove('d-none');
      this.elements.overwriteWrapper?.classList.remove('d-none');
    } else {
      this.elements.branchAlert?.classList.add('d-none');
      this.elements.overwriteWrapper?.classList.add('d-none');
      if (this.elements.overwriteCheckbox) {
        this.elements.overwriteCheckbox.checked = false;
      }
    }
    this.updatePrimaryButton();
  }

  setPrimaryAction(action) {
    this.currentAction = action;
    if (!this.elements.primaryButton) return;
    switch (action) {
      case 'cancel':
        this.elements.primaryButton.textContent = 'Cancel';
        break;
      case 'view':
        this.elements.primaryButton.textContent = 'View site';
        break;
      default:
        this.elements.primaryButton.textContent = 'Publish';
    }
  }

  updatePrimaryButton() {
    if (!this.elements.primaryButton) {
      return;
    }
    if (!this.token || !this.archive) {
      this.elements.primaryButton.disabled = true;
      return;
    }
    if (this.currentAction === 'cancel') {
      this.elements.primaryButton.disabled = false;
      return;
    }
    if (this.currentAction === 'view') {
      this.elements.primaryButton.disabled = !this.publishResult?.pagesUrl;
      return;
    }
    const branchName = this.elements.branchInput?.value?.trim();
    const repoSelected = this.getSelectedRepo();
    const branchValid = isValidBranchName(branchName);
    const overwriteOk = !this.branchExists || this.elements.overwriteCheckbox?.checked;
    this.elements.primaryButton.disabled = !(repoSelected && branchValid && overwriteOk);
  }

  handlePrimaryAction() {
    if (this.currentAction === 'cancel') {
      this.cancelPublish();
      return;
    }
    if (this.currentAction === 'view' && this.publishResult?.pagesUrl) {
      window.open(this.publishResult.pagesUrl, '_blank', 'noopener');
      return;
    }
    void this.publish();
  }

  resetProgress() {
    if (this.elements.progressSection) {
      this.elements.progressSection.classList.add('d-none');
    }
    if (this.elements.progressBar) {
      this.elements.progressBar.style.width = '0%';
      this.elements.progressBar.setAttribute('aria-valuenow', '0');
    }
    if (this.elements.progressText) {
      this.elements.progressText.textContent = 'Preparing…';
    }
    if (this.elements.progressLog) {
      this.elements.progressLog.innerHTML = '';
    }
  }

  showProgress() {
    if (this.elements.progressSection) {
      this.elements.progressSection.classList.remove('d-none');
    }
  }

  logProgress(message) {
    if (!this.elements.progressLog) return;
    const item = document.createElement('li');
    item.className = 'list-group-item';
    item.textContent = message;
    this.elements.progressLog.appendChild(item);
    item.scrollIntoView({ block: 'end' });
  }

  updateProgress(percent, text) {
    if (this.elements.progressBar) {
      this.elements.progressBar.style.width = `${percent}%`;
      this.elements.progressBar.setAttribute('aria-valuenow', String(Math.round(percent)));
    }
    if (this.elements.progressText) {
      this.elements.progressText.textContent = text;
    }
  }

  clearResult() {
    if (this.elements.resultSection) {
      this.elements.resultSection.classList.add('d-none');
    }
    this.publishResult = null;
    this.setPrimaryAction('publish');
    this.updatePrimaryButton();
  }

  showResult({ pagesUrl, repoUrl }) {
    if (!this.elements.resultSection) return;
    this.elements.resultSection.classList.remove('d-none');
    if (this.elements.viewSiteLink) {
      this.elements.viewSiteLink.href = pagesUrl || '#';
      this.elements.viewSiteLink.classList.toggle('disabled', !pagesUrl);
    }
    if (this.elements.viewRepoLink) {
      this.elements.viewRepoLink.href = repoUrl || '#';
    }
    this.publishResult = { pagesUrl, repoUrl };
    this.setPrimaryAction('view');
    this.updatePrimaryButton();
  }

  async publish() {
    if (!this.octokit || !this.archive) {
      this.toast('Sign in to GitHub and load an .elpx archive first.', 'warning');
      return;
    }
    const repo = this.getSelectedRepo();
    const branchName = this.elements.branchInput?.value?.trim();
    if (!repo || !branchName) {
      this.toast('Select a repository and branch to publish.', 'warning');
      return;
    }
    if (!isValidBranchName(branchName)) {
      this.toast('Branch name is not valid.', 'warning');
      return;
    }
    if (this.branchExists && !this.elements.overwriteCheckbox?.checked) {
      this.toast('Enable “Overwrite existing content” to replace the existing branch.', 'warning');
      return;
    }

    this.isPublishingFlag = true;
    this.publishAbort = new AbortController();
    this.resetProgress();
    this.showProgress();
    this.setPrimaryAction('cancel');
    this.updatePrimaryButton();

    try {
      let result;
      try {
        result = await this.publishWithGitData(repo, branchName);
      } catch (error) {
        if (error.status === 422 || /tree|blob/i.test(error.message || '')) {
          this.logProgress('Git Data API failed. Falling back to Contents API…');
          result = await this.publishWithContentsApi(repo, branchName);
        } else {
          throw error;
        }
      }
      await this.enablePages(repo, branchName);
      this.logProgress('GitHub Pages configured.');
      const repoUrl = `https://github.com/${repo.full_name}/tree/${encodeURIComponent(branchName)}`;
      const pagesUrl = computePagesUrl(repo.owner.login || repo.owner, repo.name, branchName);
      this.showResult({ pagesUrl: result.pagesUrl || pagesUrl, repoUrl });
      this.updateProgress(100, 'Publish complete.');
      this.toast('Site published successfully.', 'success');
    } catch (error) {
      console.error(error);
      this.toast(error.message || 'Publish failed.', 'danger');
      this.setPrimaryAction('publish');
      this.updatePrimaryButton();
    } finally {
      this.isPublishingFlag = false;
      this.publishAbort = null;
    }
  }

  async publishWithGitData(repo, branchName) {
    const entries = Array.from(this.archive.fileMap.entries());
    const { owner } = repo;
    const ownerLogin = owner.login || owner;
    const repoName = repo.name;

    this.logProgress('Creating blobs…');
    const blobMap = new Map();
    for (let index = 0; index < entries.length; index += 1) {
      const [path, record] = entries[index];
      this.throwIfAborted();
      const base64 = await this.blobToBase64(record.blob);
      const { data } = await this.octokit.rest.git.createBlob({
        owner: ownerLogin,
        repo: repoName,
        content: base64,
        encoding: 'base64'
      });
      blobMap.set(path, data.sha);
      const progress = ((index + 1) / entries.length) * 50;
      this.updateProgress(progress, `Uploaded ${index + 1}/${entries.length} files…`);
    }

    this.logProgress('Creating tree…');
    const tree = buildTreeEntriesFromFiles(entries.map(([path]) => ({ path, sha: blobMap.get(path) })));
    const { data: treeData } = await this.octokit.rest.git.createTree({
      owner: ownerLogin,
      repo: repoName,
      tree
    });
    this.updateProgress(65, 'Tree created.');

    let parentSha = null;
    try {
      if (this.branchExists) {
        const ref = await this.octokit.rest.git.getRef({ owner: ownerLogin, repo: repoName, ref: `heads/${branchName}` });
        parentSha = ref.data.object.sha;
      } else if (repo.default_branch) {
        const ref = await this.octokit.rest.git.getRef({ owner: ownerLogin, repo: repoName, ref: `heads/${repo.default_branch}` });
        parentSha = ref.data.object.sha;
      }
    } catch (error) {
      this.logProgress('Unable to read existing branch reference. Creating a root commit.');
    }

    const message = `Publish ELPX site (${new Date().toISOString()})`;
    const { data: commitData } = await this.octokit.rest.git.createCommit({
      owner: ownerLogin,
      repo: repoName,
      message,
      tree: treeData.sha,
      parents: parentSha ? [parentSha] : []
    });
    this.updateProgress(75, 'Commit created.');

    if (this.branchExists) {
      await this.octokit.rest.git.updateRef({
        owner: ownerLogin,
        repo: repoName,
        ref: `heads/${branchName}`,
        sha: commitData.sha,
        force: true
      });
      this.logProgress(`Branch ${branchName} fast-forwarded.`);
    } else {
      await this.octokit.rest.git.createRef({
        owner: ownerLogin,
        repo: repoName,
        ref: `refs/heads/${branchName}`,
        sha: commitData.sha
      });
      this.logProgress(`Branch ${branchName} created.`);
    }
    this.updateProgress(85, 'Branch updated.');

    return { pagesUrl: computePagesUrl(ownerLogin, repoName, branchName) };
  }

  async publishWithContentsApi(repo, branchName) {
    const entries = Array.from(this.archive.fileMap.entries());
    const { owner } = repo;
    const ownerLogin = owner.login || owner;
    const repoName = repo.name;
    const messagePrefix = `Publish ELPX site (${new Date().toISOString()})`;

    let branchRef;
    try {
      branchRef = await this.octokit.rest.git.getRef({ owner: ownerLogin, repo: repoName, ref: `heads/${branchName}` });
    } catch (error) {
      const baseBranch = repo.default_branch || 'main';
      const baseRef = await this.octokit.rest.git.getRef({ owner: ownerLogin, repo: repoName, ref: `heads/${baseBranch}` });
      await this.octokit.rest.git.createRef({
        owner: ownerLogin,
        repo: repoName,
        ref: `refs/heads/${branchName}`,
        sha: baseRef.data.object.sha
      });
      this.logProgress(`Branch ${branchName} created from ${baseBranch}.`);
      branchRef = await this.octokit.rest.git.getRef({ owner: ownerLogin, repo: repoName, ref: `heads/${branchName}` });
      this.branchExists = true;
    }

    const treeSha = branchRef.data.object.sha;
    const existingMap = new Map();
    if (treeSha) {
      const treeResponse = await this.octokit.rest.git.getTree({
        owner: ownerLogin,
        repo: repoName,
        tree_sha: treeSha,
        recursive: 'true'
      });
      treeResponse.data.tree
        .filter((item) => item.type === 'blob')
        .forEach((item) => existingMap.set(item.path, item.sha));
    }

    this.logProgress('Uploading files via Contents API…');
    for (let index = 0; index < entries.length; index += 1) {
      const [path, record] = entries[index];
      this.throwIfAborted();
      const base64 = await this.blobToBase64(record.blob);
      const sha = existingMap.get(path);
      await this.octokit.rest.repos.createOrUpdateFileContents({
        owner: ownerLogin,
        repo: repoName,
        path,
        message: `${messagePrefix}: ${path}`,
        content: base64,
        branch: branchName,
        sha: sha || undefined
      });
      existingMap.delete(path);
      const progress = 5 + ((index + 1) / entries.length) * 60;
      this.updateProgress(progress, `Uploaded ${index + 1}/${entries.length} files…`);
    }

    if (existingMap.size > 0) {
      this.logProgress(`Removing ${existingMap.size} obsolete files…`);
      const removals = Array.from(existingMap.entries());
      for (let index = 0; index < removals.length; index += 1) {
        const [path, sha] = removals[index];
        this.throwIfAborted();
        await this.octokit.rest.repos.deleteFile({
          owner: ownerLogin,
          repo: repoName,
          path,
          branch: branchName,
          message: `${messagePrefix}: remove ${path}`,
          sha
        });
        const progress = 70 + ((index + 1) / removals.length) * 20;
        this.updateProgress(progress, `Removed ${index + 1}/${removals.length} files…`);
      }
    }

    this.updateProgress(90, 'Contents API publish complete.');
    return { pagesUrl: computePagesUrl(ownerLogin, repoName, branchName) };
  }

  async enablePages(repo, branchName) {
    const { owner } = repo;
    const ownerLogin = owner.login || owner;
    try {
      await this.octokit.request('PUT /repos/{owner}/{repo}/pages', {
        owner: ownerLogin,
        repo: repo.name,
        source: { branch: branchName, path: '/' }
      });
    } catch (error) {
      if (error.status === 409) {
        this.logProgress('Pages already enabled for this repository. Updating source.');
        await this.octokit.request('POST /repos/{owner}/{repo}/pages', {
          owner: ownerLogin,
          repo: repo.name,
          source: { branch: branchName, path: '/' }
        });
      } else {
        throw error;
      }
    }
    this.updateProgress(95, 'GitHub Pages enabled.');
  }

  throwIfAborted() {
    if (this.publishAbort?.signal?.aborted) {
      throw new Error('Publishing cancelled.');
    }
  }

  async blobToBase64(blob) {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary);
  }
}

export { isValidBranchName, buildTreeEntriesFromFiles, computePagesUrl } from './github-utils.js';
