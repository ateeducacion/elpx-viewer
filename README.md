# ELP / ELPX Viewer

A single-page web app that previews eXeLearning exports (`.elpx`) and inspects project packages (`.elp`). Everything runs locally in the browser with client-side unzipping, an in-memory service worker preview server, and an optional GitHub Pages publishing workflow.

## Features

- Drag & drop or browse to load `.elpx` or `.elp` files. ELP v2 packages surface an explicit incompatibility notice.
- Live preview of `.elpx` exports inside an isolated iframe powered by a service worker that serves files from memory.
- Info tab with metadata, validation messages, and a downloadable file inventory JSON.
- GitHub Device Flow authentication and direct publishing to any repository/branch (with overwrite confirmation and automatic Pages configuration).
- All assets are static (Bootstrap 5, JSZip, Octokit via CDN). No build step required to run.

## Getting Started

1. Install dependencies used for local development and tests:
   ```bash
   npm install
   ```
2. Configure the GitHub OAuth client (required for publishing):
   - Create a **GitHub OAuth App** (Settings → Developer settings → OAuth Apps) and enable **Device Flow**.
  - Copy the client ID and paste it into `config.js`:
    ```js
    window.APP_CONFIG = {
      githubClientId: "YOUR_CLIENT_ID",
      defaultPagesBranch: "gh-pages",
      deviceFlowProxy: "https://cors.isomorphic-git.org"
    };
    ```
  - The default branch (`gh-pages`) can be adjusted if you have a preferred Pages branch.
  - `deviceFlowProxy` is used as a transparent CORS proxy for the OAuth Device Flow endpoints, which are not CORS-enabled when called directly from the browser. You can replace it with your own proxy or set it to an empty string if you already expose the endpoints through another domain.
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
