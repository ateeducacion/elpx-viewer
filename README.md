# eXeLearning ELPX Viewer

A single-page web app that previews eXeLearning 3.0 packages (`.elpx`). Everything runs locally in the browser with client-side unzipping, an in-memory service worker preview server, and an optional GitHub Pages publishing workflow.

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
