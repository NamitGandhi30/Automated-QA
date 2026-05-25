# User Setup Guide — Automated QA (Windows)

This guide covers installing prerequisites and getting the project running on Windows.

## Prerequisites

- Docker Desktop (Windows with WSL2 backend recommended)
- Visual Studio Code (latest stable)
- Node.js (LTS recommended — e.g., 18.x or newer)
- Git

Optional but recommended:

- Install the VS Code Extension: `ESLint`
- Ensure WSL2 is enabled for best Docker compatibility

## Clone the repository

```powershell
git clone   
cd "Automated QA"
```

## Install Node dependencies

From the repository root:

```powershell
npm install
```

Note: this installs dev dependencies required to build the extension and webview.

## Start the Docker stack

The repo includes `docker-compose.yml` to orchestrate the sidecar and test-runner.

```powershell
# Build and start containers in detached mode
docker compose up -d --build

# Check container status
docker compose ps

# View logs (follow)
docker compose logs -f
```

If you prefer to run containers in foreground for debugging:

```powershell
docker compose up --build
```

## Run the extension locally (development)

1. In VS Code, run `npm run watch` to build the webview and extension in watch mode.

```powershell
npm run watch
```

2. Press `F5` in VS Code to launch the Extension Development Host. The Automated QA sidebar appears in the activity bar.

3. Use the Command Palette (Ctrl+Shift+P) to run extension commands (e.g., `Automated QA: Start Docker Stack`).

## Common environment settings

- Default sidecar API port: `4777` (configurable via `automatedqa.sidecarPort` setting in VS Code)
- AI provider: change `automatedqa.aiProvider` if you use a different provider

## Running tests locally (non-container)

This project is designed to run tests inside the provided Docker images. If you want to run tests locally, inspect the `docker/playwright-runner/` Dockerfile and replicate the environment locally (Node, Playwright browsers).

## Stopping and cleaning up

```powershell
# Stop containers
docker compose down

# Remove volumes and images (careful)
docker compose down --volumes --rmi local
```

## Troubleshooting

- Permission errors with Docker on Windows: ensure WSL2 backend is enabled and Docker Desktop granted required permissions.
- Port conflicts: change `automatedqa.sidecarPort` in VS Code settings or stop the conflicting service.
- Build errors: run `npm install` again, then `npm run build` to see full error output.

## Next steps

- Configure your preferred AI provider in Extension Settings.
- Explore `src/extension` and `src/webview` for customization.

---

If you want, I can also add a quick checklist for CI integration or create a small script to automate the common startup commands. Interested?
