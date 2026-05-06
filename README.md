# Automated QA — Pre-Flight Controller

One-click sidebar workflow for Code Review, Multi-Tier Testing, and UI Visual Regression.

## Features
- VS Code sidebar extension to run semantic code review, generate tests, and run visual QA checks.
- Integrated Docker sidecar and Playwright-based test runner for reproducible checks.
- Commands to start/stop the local Docker stack from the extension.

## Quick start
Prerequisites: Docker Desktop, Node.js (LTS), and VS Code.

1. Start the Docker stack (recommended):

```powershell
# from repo root
docker compose up -d --build
```

2. Install Node dependencies (for extension/webview development):

```powershell
npm install
```

3. Build the extension for production or run in dev-mode:

```powershell
# build for packaging
npm run build
# or run an incremental dev build/watch
npm run watch
```

4. Open this repository in VS Code and run the extension in the Extension Development Host (press `F5`).

## Running tests (containerized)
- The repo contains a Playwright runner and a test-runner image under `docker/`.
- To execute the test runner via Docker Compose:

```powershell
docker compose up --build --abort-on-container-exit
```

## Configuration
- Extension configuration is available via VS Code Settings under **Automated QA**.
  - `automatedqa.sidecarPort` (default: 4777)
  - `automatedqa.aiProvider` (default: `copilot`)
  - `automatedqa.gitignoreTests` (default: `false`)

## Extension Commands
- `Automated QA: Run Semantic Review`
- `Automated QA: Generate Tests`
- `Automated QA: Run Visual QA Check`
- `Automated QA: Ready for PR`
- `Automated QA: Start Docker Stack`
- `Automated QA: Stop Docker Stack`

(These are contributed commands; you can run them from the Command Palette.)

## Development notes
- Source code for the extension lives under `src/extension`.
- Webview/react app lives under `src/webview` and is built by the webpack pipeline.
- Typescript config lives at `tsconfig.json` and the webpack config at `webpack.config.js`.

## Troubleshooting
- If extension doesn't activate, open the `Developer Tools` (Help → Toggle Developer Tools) and check the console for errors.
- If Docker containers fail, run `docker compose logs` to inspect container logs.

## Contributing
- Open issues and PRs against the `main` branch. Follow existing code style and run `npm run lint` before opening PRs.

## License
- Add your license here.
