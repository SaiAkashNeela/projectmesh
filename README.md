# Projectmesh

Projectmesh is a local AI engineering platform that cleanly splits responsibilities:

- AI clients (ChatGPT, Claude, Cursor, Copilot, etc.) can inspect your repository and write only inside `.projectmesh/` using the Model Context Protocol (MCP)
- Local execution tools (e.g. Claude Code, Codex, Gemini) can later consume `.projectmesh` tasks and implement source code changes
- Projectmesh exposes your local MCP server over `localhost:3334` and can tunnel it through `ngrok`

## Install

Global install:

```bash
npm install -g @isan3/projectmesh
```

```bash
bun add -g @isan3/projectmesh
```

One-off execution:

```bash
npx @isan3/projectmesh setup /absolute/path/to/repo
```

```bash
bunx @isan3/projectmesh setup /absolute/path/to/repo
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

1. Registers the repository workspace in the platform configuration
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
9. Prints the final public MCP URL

## AI Handoff Workflow: Architect & Executor

Projectmesh is designed as a repository-native collaboration layer that enables a structured handoff between AI agents:

1. **Architect Mode (e.g., ChatGPT, Claude)**:
   * The architect AI client connects via the Projectmesh MCP server.
   * It inspects repository structure and writes/plans tasks inside `.projectmesh/tasks/active.md` (using the `create_task`/`update_task` tools).
   * It documents decisions in `.projectmesh/decisions.md` and durable memory in `.projectmesh/memory.md`.

2. **Handoff Generation**:
   * Once a task is ready, the **Task Packet** is generated:
     ```bash
     projectmesh packet
     ```
     *(This can also be invoked by the architect agent using the `get_task_packet` MCP tool).*
   * This creates a self-contained context document at `.projectmesh/context/active-packet.md` that bundles:
     * Active task details and criteria.
     * High-level repository architecture, decisions, and style guide.
     * The actual source code of all files listed under `Affected Files` (safely truncated if files are too large or binary).

3. **Agent Execution (Secure Handoff)**:
   * The Architect agent can request local task execution via the `execute_task_agent` MCP tool (specifying an executor like `claude`, `gemini`, or `codex`).
   * For security, the MCP server registers a pending execution request in `.projectmesh/tasks/pending-execution.json` rather than running commands automatically.
   * To approve and run the execution locally, the user runs:
     ```bash
     projectmesh execute
     ```
   * Projectmesh will resolve the command, ask for confirmation, and run the agent in the foreground (e.g. allowing interactive shells for tools like Claude Code).
   * Alternatively, you can directly launch an executor manually via the CLI:
     ```bash
     projectmesh execute claude
     ```

4. **Execution Review & Tracking**:
   * Once the executor finishes, Projectmesh automatically captures the execution duration, exit code, and git changes.
   * It writes a durable markdown report in `.projectmesh/reviews/execution-report-<timestamp>.md` to track changes and results, maintaining history inside your repository.

## Multi-Repository Workspace Registry & Session Isolation

Projectmesh supports registering multiple workspaces and isolating them across different AI chat sessions or connections:

1. **Multi-Repository Registry**:
   * You can register multiple repositories by running:
     ```bash
     projectmesh new /absolute/path/to/repo
     # or
     projectmesh use /absolute/path/to/repo
     ```
   * The server tracks all registered workspaces in `~/.projectmesh/repos.json`.

2. **Session-Level Isolation**:
   * Different chat threads or client connections can connect to the same Projectmesh MCP server concurrently.
   * Each connection has its own isolated session context (mapped via a unique `sessionId` query parameter or path segment in the HTTP MCP URL, e.g., `/mcp?sessionId=thread-123`).
   * One session can be targeting `repo-A` while another session targets `repo-B` concurrently with zero context leakage.

3. **Workspace MCP Tools**:
   * **`list_workspaces`**: Returns all registered workspaces, showing their registration paths and identifying the workspace currently active for the caller's session.
   * **`switch_workspace`**: Dynamically switches the workspace context for the current chat session to another registered repository using its ID or path.

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
projectmesh packet
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

## How AI clients connect (ChatGPT, Claude, Cursor, etc.)

Projectmesh exposes MCP over HTTP at:

```text
http://127.0.0.1:3334/mcp
```

When you run `projectmesh share`, it starts both background services and prints a public URL like:

```text
https://example.ngrok.app/mcp
```

That is the URL you can paste into your AI client's MCP configuration (e.g., ChatGPT Custom Actions, Claude desktop config, Cursor, or Copilot).

The local dashboard runs here:

```text
http://127.0.0.1:3335
```

It shows:

- how many registered projects are ready for AI client access
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
- `src/mcp-server.ts`: stdio MCP server for local MCP hosts and session-isolated tool execution
- `src/share.ts`: localhost HTTP MCP server, ngrok install flow, and background service management
- `src/platform-config.ts`: repository registration registry (`repos.json`) and active workspace matching
