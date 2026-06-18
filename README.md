# Projectmesh

Projectmesh is a local AI engineering platform that cleanly splits responsibilities:

- ChatGPT can inspect your repository and write only inside `.projectmesh/`
- Codex can later consume `.projectmesh` tasks and implement source code changes
- Projectmesh exposes your local MCP server over `localhost:3334` and can tunnel it through `ngrok`

## Install

Global install:

```bash
npm install -g projectmesh
```

```bash
bun add -g projectmesh
```

One-off execution:

```bash
npx projectmesh setup /absolute/path/to/repo
```

```bash
bunx projectmesh setup /absolute/path/to/repo
```

## One-command setup

This is the main happy path:

```bash
projectmesh setup /absolute/path/to/repo
```

If you are already standing in the repository root, this also works:

```bash
projectmesh setup
```

What it does:

1. Selects the active repository workspace
2. Creates the `.projectmesh/` workspace if it does not exist yet
3. Generates `.projectmesh/architecture.md`
4. Installs or reuses `ngrok` on supported macOS/Linux systems
5. Prompts you to run:

```bash
ngrok config add-authtoken $YOUR_TOKEN
```

Get your token here:

[https://dashboard.ngrok.com/get-started/your-authtoken](https://dashboard.ngrok.com/get-started/your-authtoken)

6. Starts the local MCP HTTP server on `http://127.0.0.1:3334/mcp`
7. Starts `ngrok http 3334` in the background
8. Starts the Projectmesh dashboard on `http://127.0.0.1:3335`
9. Prints the final ChatGPT-ready MCP URL

## Commands

Main CLI:

```bash
projectmesh new
projectmesh new /absolute/path/to/repo
projectmesh use /absolute/path/to/repo
projectmesh status
projectmesh analyze
projectmesh setup /absolute/path/to/repo
projectmesh start
projectmesh stop
projectmesh share
projectmesh mcp-http
projectmesh dashboard
projectmesh ngrok config
projectmesh ngrok edit
projectmesh ngrok auth
projectmesh ngrok auth <token>
```

Aliases:

```bash
pmesh status
projectmesh-new
projectmesh-start
projectmesh-stop
projectmesh-status
projectmesh-dashboard
projectmesh-mcp-server
projectmesh-mcp-http mcp-http
projectmesh-share share
```

## How ChatGPT connects

Projectmesh exposes MCP over HTTP at:

```text
http://127.0.0.1:3334/mcp
```

When you run `projectmesh share`, it starts both background services and prints a public URL like:

```text
https://example.ngrok.app/mcp
```

That is the URL you can paste into ChatGPT MCP configuration.

The local dashboard runs here:

```text
http://127.0.0.1:3335
```

It shows:

- how many registered projects ChatGPT can access
- which project is active
- the local and public MCP URLs
- repo-local `.projectmesh` status
- ngrok settings and token management

## Security note

Right now the shared MCP endpoint has no OAuth or other auth layer.

Do not expose or leak your `ngrok` URL.

Treat that URL like a temporary secret.

## Background services

`projectmesh start`, `projectmesh share`, and `projectmesh setup` start these services in the background:

- local dashboard on port `3335`
- local MCP HTTP server on port `3334`
- `ngrok` tunnel for port `3334`

Stop them later with:

```bash
projectmesh stop
```

See current state with:

```bash
projectmesh status
```

Projectmesh stores runtime state under:

```text
~/.projectmesh/
```

This includes repo registration, logs, cached binaries, and running-service metadata.

## Local development

```bash
bun install
bun run test
bun run build
```

## Package structure

- `src/workspace.ts`: workspace confinement and `.projectmesh`-only write policy
- `src/ai-workspace.ts`: task, review, memory, decision, and architecture document flows
- `src/repository-analysis.ts`: repository analysis and project context
- `src/git.ts`: fixed-argument git readers with no shell execution
- `src/mcp-server.ts`: stdio MCP server for local MCP hosts
- `src/share.ts`: localhost HTTP MCP server, ngrok install flow, and background service management
