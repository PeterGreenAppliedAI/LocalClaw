# Contributing to LocalClaw

Thanks for your interest in contributing! LocalClaw is a local-model-first AI agent framework, and contributions of all kinds are welcome — bug fixes, new tools, new channel adapters, documentation, and tests.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Ollama](https://ollama.ai/) running locally or on your network
- Required models:
  ```bash
  ollama pull phi4-mini          # Router model
  ollama pull qwen3-coder:30b    # Specialist model
  ollama pull qwen3-embedding:8b # Embeddings
  ```

### Setup

```bash
git clone https://github.com/PeterGreenAppliedAI/LocalClaw.git
cd LocalClaw
npm install
cp .env.example .env
# Edit .env with your Ollama URL and any API keys
```

### Development Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the bot (tsx, auto-imports TypeScript) |
| `npm test` | Run all tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | Type-check without emitting (`tsc --noEmit`) |
| `npm run build` | Build for production (tsdown) |

### Verify Your Setup

```bash
npm run typecheck   # Should pass with zero errors
npm test            # 14 test suites should pass
```

## Project Structure

```
src/
├── index.ts              # Entry point
├── orchestrator.ts       # Lifecycle, rate limiting, voice model override
├── dispatch.ts           # Router → Specialist pipeline
├── config/               # JSON5 config + Zod validation
├── router/               # Intent classification (3-tier fallback)
├── tool-loop/            # ReAct tool-calling loop engine
├── ollama/               # Ollama HTTP client (chat, stream, embed)
├── channels/             # Pluggable adapters (Discord, Web, WhatsApp, etc.)
├── services/             # TTS (Orpheus) and STT (Whisper) services
├── tools/                # Tool implementations
├── agents/               # Workspace files + agent routing
├── context/              # Token budget, history compaction
├── sessions/             # Transcript persistence
├── cron/                 # Scheduling service
├── memory/               # Vector + keyword search (SQLite)
├── tasks/                # Task board (JSON + Markdown)
├── browser/              # Playwright wrapper
└── exec/                 # Shell execution with sandbox
```

## Branching Model

The `main` branch is **protected** — all changes must go through pull requests.

- **No direct pushes to `main`** — CI status checks (typecheck, tests, build) must pass before merge
- **Branches must be up-to-date** with `main` before merging
- **Branch naming conventions:**
  - `feature/` — new functionality (e.g. `feature/slack-adapter`)
  - `fix/` — bug fixes (e.g. `fix/router-timeout`)
  - `docs/` — documentation changes (e.g. `docs/tool-api`)
- **`dev` branch** — persistent working branch for maintainers; feature branches can branch from `dev` or `main`
- **Contributor PRs target `main`**

## How to Contribute

### 1. Add a New Tool

This is the most common contribution. Each tool is a self-contained module.

1. Create `src/tools/my-tool.ts` implementing the `LocalClawTool` interface
2. Register it in `src/tools/register-all.ts`
3. Add the tool name to a specialist's `tools` array in `localclaw.config.json5`
4. Add tests in `test/tools/my-tool.test.ts`

### 2. Add a New Channel Adapter

1. Create `src/channels/myplatform/adapter.ts` implementing the `ChannelAdapter` interface (5 methods: `connect`, `disconnect`, `onMessage`, `send`, `status`)
2. Add the dynamic import in `src/index.ts`
3. Add config section in `localclaw.config.json5`
4. Zero core code changes required

### 3. Add a New Specialist Category

1. Add the category to `router.categories` in `localclaw.config.json5`
2. Add specialist config to `specialists` in the same file
3. *(Optional)* Add keyword patterns in `src/router/classifier.ts`

### 4. Bug Fixes and Improvements

- Check the [issues](https://github.com/PeterGreenAppliedAI/LocalClaw/issues) for open bugs or feature requests
- If you find a bug, open an issue first so we can discuss the approach

## Code Style

- **TypeScript** with `strict: true` — no `any` unless absolutely necessary
- **ESM modules** — use `.js` extensions in imports (required by Node16 module resolution)
- **No linter configured yet** — just keep consistent with the existing code style:
  - 2-space indentation
  - Single quotes for strings
  - Semicolons
  - Descriptive variable names
- **Avoid over-engineering** — prefer simple, focused changes over abstractions
- **Comments** — only where the logic isn't self-evident

## Testing

We use [Vitest](https://vitest.dev/). Tests live in `test/` mirroring the `src/` structure.

```bash
# Run all tests
npm test

# Run a specific test file
npx vitest run test/router/classifier.test.ts

# Watch mode
npm run test:watch
```

**Guidelines:**
- Add tests for new tools, adapters, and any non-trivial logic
- Use `vi.fn()` for mocking
- Use `describe`/`it` blocks with clear descriptions
- Test edge cases, not just the happy path

## Pull Request Process

1. **Fork** the repo and create a branch from `main` using the naming convention above (`feature/`, `fix/`, `docs/`)
2. **Make your changes** — keep PRs focused on a single concern
3. **Run checks** before submitting:
   ```bash
   npm run typecheck   # Zero type errors
   npm test            # All tests pass
   npm run build       # Build compiles
   ```
4. **Open a PR** targeting `main` with:
   - A clear title describing the change
   - A summary of what and why
   - Any testing you did
5. A maintainer will review and provide feedback

### PR Tips

- Small, focused PRs are reviewed faster than large ones
- If your change affects config, include example config in the PR description
- If adding a new tool or adapter, include a brief usage example
- Don't bundle unrelated changes — one PR per concern

## Configuration

LocalClaw uses `localclaw.config.json5` for all configuration. When adding features:

- Add Zod schemas in `src/config/schema.ts` for validation
- Add corresponding types in `src/config/types.ts`
- Use environment variable interpolation (`"${ENV_VAR}"`) for secrets
- Document new config options in your PR

## Safety

LocalClaw takes security seriously. When contributing, keep in mind:

- **Exec allowlist** — shell commands must be explicitly approved
- **SSRF protection** — validate URLs with scheme whitelist and DNS pre-flight
- **Path traversal** — file writes must stay within the workspace
- **No secrets in code** — use `.env` for API keys and tokens
- **Input validation** — validate at system boundaries (user input, external APIs)

## Questions?

Open an issue or start a discussion. We're happy to help you get started.
