import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createWorkspace } from './workspace.js';
import { getProjectmeshNgrokConfigPath, getProjectmeshServiceStatus, runNgrokAuthtokenCommand } from './share.js';
import { getActiveRepo, getPlatformHome, readReposConfig } from './platform-config.js';

export const DASHBOARD_PORT = 3335;

interface ProjectSummary {
  id: string;
  name: string;
  root: string;
  isActive: boolean;
  hasProjectmeshWorkspace: boolean;
  taskCount: number;
  reviewCount: number;
  lastUsedAt: string;
}

async function exists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function summarizeProject(project: { id: string; name: string; root: string; lastUsedAt: string }, activeRepoId: string | null) {
  const workspace = createWorkspace(project.root);
  const hasProjectmeshWorkspace = await exists(workspace.projectmeshDir);
  const tasksDir = path.join(workspace.projectmeshDir, 'tasks', 'completed');
  const reviewsDir = path.join(workspace.projectmeshDir, 'reviews');
  const taskCount = hasProjectmeshWorkspace ? (await readdir(tasksDir).catch(() => [])).length : 0;
  const reviewCount = hasProjectmeshWorkspace ? (await readdir(reviewsDir).catch(() => [])).length : 0;

  return {
    id: project.id,
    name: project.name,
    root: project.root,
    isActive: project.id === activeRepoId,
    hasProjectmeshWorkspace,
    taskCount,
    reviewCount,
    lastUsedAt: project.lastUsedAt,
  } satisfies ProjectSummary;
}

async function buildDashboardPayload() {
  const config = await readReposConfig();
  const projects = await Promise.all(config.repos.map((repo) => summarizeProject(repo, config.activeRepoId)));
  const activeRepo = await getActiveRepo().catch(() => null);
  const serviceState = await getProjectmeshServiceStatus();

  return {
    summary: {
      projectCount: projects.length,
      activeProjectName: activeRepo?.name ?? null,
      activeProjectRoot: activeRepo?.root ?? null,
      readyWorkspacesCount: projects.filter((project) => project.hasProjectmeshWorkspace).length,
      localMcpUrl: serviceState ? `http://${serviceState.mcp.host}:${serviceState.mcp.port}${serviceState.mcp.path}` : null,
      publicMcpUrl: serviceState?.chatGptUrl ?? null,
      dashboardUrl: `http://127.0.0.1:${DASHBOARD_PORT}`,
      globalHome: getPlatformHome(),
      ngrokConfigPath: getProjectmeshNgrokConfigPath(),
      now: new Date().toISOString(),
      syncIntervalSeconds: 10,
    },
    projects,
    serviceState,
    accessPolicy: {
      read: 'Entire active repository',
      write: 'Only the active repository .projectmesh directory',
      globalCoordination: '~/.projectmesh/repos.json and runtime state',
    },
  };
}

function pageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Projectmesh</title>
  <style>
    :root {
      --bg: #f3efe5;
      --ink: #14201d;
      --muted: #54615d;
      --line: rgba(20,32,29,0.12);
      --card: rgba(255,255,255,0.78);
      --accent: #0e8a68;
      --accent-soft: #d6f2e8;
      --shadow: 0 24px 60px rgba(27, 42, 37, 0.12);
      --radius: 22px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(14,138,104,0.10), transparent 28rem),
        radial-gradient(circle at bottom right, rgba(193,121,60,0.12), transparent 30rem),
        linear-gradient(180deg, #f8f4eb 0%, var(--bg) 100%);
      min-height: 100vh;
    }
    .shell {
      max-width: 1180px;
      margin: 0 auto;
      padding: 40px 22px 80px;
    }
    .hero {
      display: grid;
      grid-template-columns: 1.5fr 1fr;
      gap: 22px;
      align-items: stretch;
    }
    .panel {
      background: var(--card);
      backdrop-filter: blur(12px);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }
    .hero-main {
      padding: 28px;
      position: relative;
      overflow: hidden;
    }
    .hero-main::after {
      content: "";
      position: absolute;
      inset: auto -40px -40px auto;
      width: 220px;
      height: 220px;
      background: radial-gradient(circle, rgba(14,138,104,0.18), transparent 70%);
      pointer-events: none;
    }
    .eyebrow {
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 12px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: clamp(34px, 5vw, 62px);
      line-height: 0.96;
      letter-spacing: -0.04em;
    }
    .lede {
      margin: 0;
      color: var(--muted);
      max-width: 44rem;
      font-size: 16px;
      line-height: 1.6;
    }
    .hero-stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-top: 24px;
    }
    .stat {
      padding: 16px;
      border-radius: 18px;
      background: rgba(255,255,255,0.68);
      border: 1px solid rgba(20,32,29,0.08);
    }
    .stat strong {
      display: block;
      font-size: 28px;
      letter-spacing: -0.04em;
    }
    .stat span {
      font-size: 13px;
      color: var(--muted);
    }
    .hero-side {
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .hero-side h2, .section h2 {
      margin: 0;
      font-size: 16px;
      letter-spacing: -0.03em;
    }
    .kicker {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--muted);
    }
    .url-box {
      padding: 14px;
      border-radius: 16px;
      background: #11211c;
      color: #f4faf8;
      font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
      font-size: 12px;
      line-height: 1.55;
      word-break: break-all;
    }
    .warning {
      padding: 14px;
      border-radius: 16px;
      background: #fff4df;
      border: 1px solid rgba(193,121,60,0.24);
      color: #6c4a1d;
      font-size: 13px;
      line-height: 1.55;
    }
    .section-grid {
      display: grid;
      grid-template-columns: 1.3fr 0.9fr;
      gap: 22px;
      margin-top: 22px;
    }
    .section {
      padding: 24px;
    }
    .project-list {
      margin-top: 18px;
      display: grid;
      gap: 12px;
    }
    .project-item {
      border: 1px solid rgba(20,32,29,0.08);
      border-radius: 18px;
      background: rgba(255,255,255,0.72);
      padding: 16px;
    }
    .project-item header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 10px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
      border-radius: 999px;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      background: var(--accent-soft);
      color: #0b6a50;
    }
    .project-root {
      color: var(--muted);
      font-size: 13px;
      word-break: break-word;
    }
    .mini-stats {
      display: flex;
      gap: 10px;
      margin-top: 10px;
      flex-wrap: wrap;
    }
    .mini-stats span {
      font-size: 12px;
      color: var(--muted);
      padding: 7px 10px;
      border-radius: 999px;
      background: rgba(20,32,29,0.05);
    }
    .settings-toggle {
      position: fixed;
      right: 18px;
      top: 18px;
      border: none;
      background: #11211c;
      color: white;
      width: 52px;
      height: 52px;
      border-radius: 18px;
      box-shadow: var(--shadow);
      cursor: pointer;
      font-size: 22px;
    }
    .settings-drawer {
      position: fixed;
      right: 18px;
      top: 82px;
      width: min(380px, calc(100vw - 36px));
      padding: 22px;
      border-radius: 22px;
      background: rgba(17,33,28,0.95);
      color: #edf8f3;
      box-shadow: var(--shadow);
      border: 1px solid rgba(255,255,255,0.08);
      display: none;
    }
    .settings-drawer.open { display: block; }
    .settings-drawer input {
      width: 100%;
      margin-top: 10px;
      margin-bottom: 12px;
      padding: 12px 14px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.08);
      color: white;
    }
    .settings-drawer button, .actions button {
      border: none;
      border-radius: 14px;
      padding: 12px 14px;
      background: var(--accent);
      color: white;
      font-weight: 600;
      cursor: pointer;
    }
    .secondary {
      background: rgba(255,255,255,0.1) !important;
    }
    .settings-meta, .logline {
      font-size: 13px;
      color: rgba(237,248,243,0.72);
      line-height: 1.6;
      word-break: break-word;
    }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 16px;
    }
    .sync {
      margin-top: 12px;
      font-size: 12px;
      color: var(--muted);
    }
    @media (max-width: 920px) {
      .hero, .section-grid { grid-template-columns: 1fr; }
      .hero-stats { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <button class="settings-toggle" id="settingsToggle" aria-label="Open settings">⚙</button>
  <aside class="settings-drawer" id="settingsDrawer">
    <div class="kicker">Settings</div>
    <h2>ngrok & local runtime</h2>
    <p class="settings-meta" id="settingsMeta">Loading settings…</p>
    <label for="tokenInput">ngrok authtoken</label>
    <input id="tokenInput" type="password" placeholder="Paste your ngrok token" />
    <div class="actions">
      <button id="saveToken">Save token</button>
      <button id="refreshButton" class="secondary">Refresh now</button>
    </div>
    <p class="settings-meta">
      Get a token at
      <a href="https://dashboard.ngrok.com/get-started/your-authtoken" target="_blank" rel="noreferrer" style="color:#b7f0db;">dashboard.ngrok.com/get-started/your-authtoken</a>
    </p>
    <p class="settings-meta">
      Security reminder: your public MCP URL has no OAuth right now. Treat it like a secret.
    </p>
  </aside>

  <main class="shell">
    <section class="hero">
      <article class="panel hero-main">
        <div class="eyebrow">Projectmesh Control Plane</div>
        <h1>See what AI clients can touch, what is live, and what needs attention.</h1>
        <p class="lede">
          Projectmesh keeps repo access grounded in two places: repo-local context inside
          <code>.projectmesh/</code> and global coordination inside <code>~/.projectmesh/</code>.
        </p>
        <div class="hero-stats" id="heroStats"></div>
        <div class="sync" id="syncText">Syncing every 10 seconds…</div>
      </article>

      <aside class="panel hero-side">
        <div class="kicker">Live Endpoint</div>
        <h2>MCP URL</h2>
        <div class="url-box" id="publicUrl">Waiting for Projectmesh…</div>
        <div class="kicker">Local Endpoint</div>
        <div class="url-box" id="localUrl">http://127.0.0.1:3334/mcp</div>
        <div class="warning">
          This MCP endpoint can be accessed by any AI client (ChatGPT, Claude, Cursor, Copilot, etc.) that supports MCP tool calling. Currently has no OAuth or auth wall; do not share the public tunnel URL.
        </div>
      </aside>
    </section>

    <section class="section-grid">
      <article class="panel section">
        <div class="kicker">Projects</div>
        <h2>Registered repositories</h2>
        <div class="project-list" id="projectList"></div>
      </article>

      <aside class="panel section">
        <div class="kicker">Access Model</div>
        <h2>What AI clients can see</h2>
        <div class="project-list" id="accessList"></div>
      </aside>
    </section>
  </main>

  <script>
    const state = {
      settingsOpen: false,
      lastData: null,
    };

    const settingsToggle = document.getElementById('settingsToggle');
    const settingsDrawer = document.getElementById('settingsDrawer');
    const heroStats = document.getElementById('heroStats');
    const projectList = document.getElementById('projectList');
    const accessList = document.getElementById('accessList');
    const publicUrl = document.getElementById('publicUrl');
    const localUrl = document.getElementById('localUrl');
    const settingsMeta = document.getElementById('settingsMeta');
    const syncText = document.getElementById('syncText');
    const tokenInput = document.getElementById('tokenInput');
    const saveToken = document.getElementById('saveToken');
    const refreshButton = document.getElementById('refreshButton');

    settingsToggle.addEventListener('click', () => {
      state.settingsOpen = !state.settingsOpen;
      settingsDrawer.classList.toggle('open', state.settingsOpen);
    });

    refreshButton.addEventListener('click', () => syncDashboard());

    saveToken.addEventListener('click', async () => {
      const token = tokenInput.value.trim();
      if (!token) return;
      saveToken.disabled = true;
      try {
        const response = await fetch('/api/ngrok/authtoken', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token })
        });
        const data = await response.json();
        alert(data.message || 'Token updated');
        tokenInput.value = '';
        await syncDashboard();
      } catch (error) {
        alert('Failed to update ngrok token');
      } finally {
        saveToken.disabled = false;
      }
    });

    function renderStats(summary) {
      heroStats.innerHTML = '';
      const cards = [
        { value: summary.projectCount, label: 'Registered projects' },
        { value: summary.readyWorkspacesCount, label: 'Workspaces ready for AI' },
        { value: summary.publicMcpUrl ? 'Live' : 'Idle', label: 'Tunnel state' }
      ];
      cards.forEach(card => {
        const el = document.createElement('div');
        el.className = 'stat';
        el.innerHTML = '<strong>' + card.value + '</strong><span>' + card.label + '</span>';
        heroStats.appendChild(el);
      });
    }

    function renderProjects(projects) {
      projectList.innerHTML = '';
      if (!projects.length) {
        projectList.innerHTML = '<div class="project-item">No registered projects yet.</div>';
        return;
      }
      projects.forEach(project => {
        const el = document.createElement('article');
        el.className = 'project-item';
        el.innerHTML =
          '<header>' +
            '<div><strong>' + project.name + '</strong><div class="project-root">' + project.root + '</div></div>' +
            (project.isActive ? '<span class="badge">CLI Default</span>' : '') +
          '</header>' +
          '<div class="mini-stats">' +
            '<span>' + (project.hasProjectmeshWorkspace ? '.projectmesh ready' : 'No .projectmesh yet') + '</span>' +
            '<span>' + project.taskCount + ' completed tasks</span>' +
            '<span>' + project.reviewCount + ' reviews</span>' +
          '</div>';
        projectList.appendChild(el);
      });
    }

    function renderAccess(accessPolicy) {
      accessList.innerHTML = '';
      [
        ['Read access', accessPolicy.read],
        ['Write access', accessPolicy.write],
        ['Global coordination', accessPolicy.globalCoordination]
      ].forEach(([label, value]) => {
        const el = document.createElement('article');
        el.className = 'project-item';
        el.innerHTML = '<strong>' + label + '</strong><p class="project-root">' + value + '</p>';
        accessList.appendChild(el);
      });
    }

    async function syncDashboard() {
      const response = await fetch('/api/summary');
      const data = await response.json();
      state.lastData = data;
      renderStats(data.summary);
      renderProjects(data.projects);
      renderAccess(data.accessPolicy);
      publicUrl.textContent = data.summary.publicMcpUrl || 'Tunnel not running yet';
      localUrl.textContent = data.summary.localMcpUrl || 'http://127.0.0.1:3334/mcp';
      settingsMeta.textContent =
        'ngrok config: ' + data.summary.ngrokConfigPath + '\\n' +
        'Global home: ' + data.summary.globalHome + '\\n' +
        'CLI default project: ' + (data.summary.activeProjectName || 'None');
      syncText.textContent = 'Last sync: ' + new Date(data.summary.now).toLocaleTimeString() + ' • auto-refresh every 10 seconds';
    }

    syncDashboard();
    setInterval(syncDashboard, 10000);
  </script>
</body>
</html>`;
}

async function readJsonBody(req: IncomingMessage) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function startDashboardServer(port = DASHBOARD_PORT, host = '127.0.0.1') {
  await mkdir(getPlatformHome(), { recursive: true });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, port }));
        return;
      }
      if (url.pathname === '/api/summary') {
        const payload = await buildDashboardPayload();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }
      if (url.pathname === '/api/ngrok/authtoken' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body?.token || typeof body.token !== 'string') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Missing token' }));
          return;
        }
        await runNgrokAuthtokenCommand(body.token);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'ngrok authtoken updated successfully.' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pageHtml());
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  return {
    port,
    host,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
