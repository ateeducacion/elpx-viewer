# ELP / ELPX Viewer

A single-page web app that previews eXeLearning exports (`.elpx`) and inspects project packages (`.elp`). Everything runs locally in the browser with client-side unzipping, an in-memory service worker preview server, and an optional GitHub Pages publishing workflow.

## Features

- Drag & drop or browse to load `.elpx` or `.elp` files. ELP v2 packages surface an explicit incompatibility notice.
- Live preview of `.elpx` exports inside an isolated iframe powered by a service worker that serves files from memory.
- Info tab with metadata, validation messages, and a downloadable file inventory JSON.
- GitHub publishing modal with repo/branch search or creation, overwrite safeguarding, progress logging, and automatic Pages enablement (expects your OAuth flow to expose a `getGitHubToken()` helper).
- All assets are static (Bootstrap 5, JSZip, Octokit via CDN). No build step required to run.

## Getting Started

1. Install dependencies used for local development and tests:
   ```bash
   npm install
   ```
2. Provide a GitHub access token so the publish modal can call the REST API:
   - Expose a global `getGitHubToken()` function (or set `window.APP_CONFIG.githubToken`) that returns the signed-in teacher’s token. This can come from any OAuth flow you control.
   - If you keep using the legacy Device Flow helper, register a **GitHub OAuth App** (Settings → Developer settings → OAuth Apps) and enable **Device Flow**, then keep `config.js` up to date:
     ```js
     window.APP_CONFIG = {
       githubClientId: 'YOUR_CLIENT_ID',
       defaultPagesBranch: 'gh-pages',
       deviceFlowProxy: 'https://cors.isomorphic-git.org'
     };
     ```
   - The default branch (`gh-pages`) can be adjusted if you prefer another Pages branch. The `deviceFlowProxy` entry is only needed when you call GitHub’s Device Flow endpoints from the browser and require a CORS-friendly proxy.

3. Start a static server for local development (disables caching so the service worker picks up changes quickly):
   ```bash
   npm run start
   ```
4. Open the printed URL (default `http://localhost:8081`) in a modern browser, drag a `.elpx` file onto the dropzone, and browse the Preview/Info tabs.

> **Note:** The preview relies on a service worker. If you see an error about previews not being available, refresh the page so the worker can take control.

## Tests

Jest and jsdom cover the reusable browser logic (validator helpers, viewer utilities, service worker URL parsing, and GitHub helper utilities):

```bash
npm test
```

## GitHub Publishing Workflow

- Launch the **Publish to GitHub** modal after loading a valid `.elpx` archive.
- Sign in using the Device Flow (a short code and link are shown in the modal). Tokens are stored only in `sessionStorage`.
- Pick a repository, choose or enter a branch name, and confirm overwriting if the branch already has content.
- Publishing prefers the Git Data API for a single atomic commit and falls back to the Contents API for smaller repositories.
- The app configures GitHub Pages for the chosen branch (`branch /` mode) and surfaces links to the repository branch and the resulting site.

## Project Structure

```
index.html          # Application shell (Bootstrap layout, modal, toasts)
styles.css          # Lightweight custom styles for dropzone, preview, modal
config.js           # Runtime configuration (GitHub client ID, defaults)
src/
  viewer.js         # UI wiring, drag & drop, JSZip integration, service worker hand-off
  viewer-utils.js   # Pure helpers tested by Jest (file type detection, MIME, map builder)
  info.js           # Info tab renderer (metadata, messages, inventory download)
  github.js         # GitHub Device Flow client + publishing workflow
  github-utils.js   # Shareable GitHub helpers (branch validation, tree shaping)
  validator.js      # Manifest helpers shared with Info tab + Jest tests
sw.js               # Service worker that serves extracted files from memory
__tests__/          # Jest test suite (viewer, service worker, GitHub helpers, validator)
```

## Browser Support

- Requires a modern browser with service worker and `async/await` support (Chromium, Firefox, Safari ≥ 16).
- Publishing uses the GitHub REST API; network access must be allowed for `github.com` and `api.github.com`.

## License

AGPL-3.0-or-later — see `LICENSE` for details.

## Publish Modal Assets

The GitHub publishing modal ships as four standalone files:

- `publish-modal.html` — Bootstrap 5 modal markup (drop the `<div class="modal">…</div>` directly into your page).
- `publish-modal.css` — Optional UI polish (log list, Select2 focus ring).
- `publish-modal.js` — All modal behaviour (Select2 wiring, GitHub REST API calls).
- `README.md` — This section with setup guidance and the regression test plan.

### Quick Setup

1. Copy the markup from `publish-modal.html` into your document (typically next to other Bootstrap modals).
2. Load the supporting CSS/JS after Bootstrap 5, jQuery, and Select2 v4:

```html
<link rel="stylesheet" href="publish-modal.css" />

<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/select2@4.1.0-rc.0/dist/js/select2.min.js"></script>
<script src="publish-modal.js" defer></script>
```

3. Provide the required hooks before opening the modal:

```html
<script>
  window.getGitHubToken = () => 'replace-with-real-token';
  window.getFilesToPublish = () => [
    // Return the files you want to publish (base64-encoded content).
    { path: 'index.html', base64Content: btoa('<!doctype html>…') }
  ];
  window.onSignOut = () => {
    console.log('Signing out of GitHub…');
  };

  document.addEventListener('DOMContentLoaded', () => {
    initPublishModal();
    const button = document.getElementById('publishButton');
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-disabled');
      button.addEventListener('click', () => {
        const modal = new bootstrap.Modal(document.getElementById('publishModal'));
        modal.show();
      });
    }
  });
</script>
```

> Replace the token stub with the OAuth flow used in your app, and return the actual publish payload from `getFilesToPublish()`.

### Test Plan

1. **Existing repo, empty branch** – Select a repository with an empty target branch. “Publish” should enable immediately without showing the overwrite switch.
2. **Existing repo, populated branch** – Select a repository/branch that already contains files. Confirm the warning card appears and “Publish” stays disabled until the overwrite switch is checked.
3. **Create new repo (user)** – Choose “Create new repository”, accept the defaults, and publish. A new repo and branch should be created, files uploaded, and Pages enabled.
4. **Create new repo (org, no rights)** – Attempt to create a repository under an organisation where the signed-in user lacks permissions. A friendly “You don’t have permission…” error should appear.
5. **Large upload (>50 files)** – Publish a package with more than 50 files and confirm the log records the atomic commit path (Git Data API).
6. **Keyboard-only navigation** – Tab from modal open through publish success; ensure focus order, Enter activation, and Escape to close all work.
7. **Screen reader output** – Verify announcements for status updates, alerts, and validation (aria-live regions, overwrite warning, error alert).
