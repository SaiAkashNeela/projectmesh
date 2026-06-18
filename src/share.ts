import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createWriteStream, openSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline/promises';

import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { DASHBOARD_PORT } from './dashboard.js';
import { buildMcpServer } from './mcp-server.js';
import { ensurePlatformDirectories, getPlatformHome } from './platform-config.js';

export const MCP_HTTP_PORT = 3334;
export const MCP_HTTP_PATH = '/mcp';
const NGROK_API_PORT = 4040;
const DASHBOARD_PID_FILE = 'dashboard.pid';
const MCP_PID_FILE = 'mcp-http.pid';
const NGROK_PID_FILE = 'ngrok.pid';
const SERVICES_STATE_FILE = 'services.json';

export type SupportedPlatform = NodeJS.Platform;
export type SupportedArch = NodeJS.Architecture;
export type LinuxLibc = 'glibc' | 'musl' | 'unknown';

export interface PlatformDescriptor {
  platform: SupportedPlatform;
  arch: SupportedArch;
  libc: LinuxLibc;
}

export interface NgrokAsset {
  archiveType: 'zip' | 'tgz';
  fileName: string;
  url: string;
  variantLabel: string;
}

export interface NgrokInstallHint {
  mode: 'install' | 'manual';
  asset?: NgrokAsset;
  message: string;
}

export interface ProjectmeshServiceState {
  startedAt: string;
  dashboard: {
    pid: number;
    port: number;
    pidFile: string;
    logFile: string;
    url: string;
  };
  mcp: {
    pid: number;
    port: number;
    host: string;
    path: string;
    pidFile: string;
    logFile: string;
  };
  ngrok: {
    pid: number;
    apiPort: number;
    pidFile: string;
    logFile: string;
    publicUrl: string;
  };
  chatGptUrl: string;
}

export function getProjectmeshNgrokConfigPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.config', 'ngrok', 'ngrok.yml');
}

async function runCommand(command: string, args: string[], options: { inheritStdio?: boolean } = {}) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.inheritStdio ? 'inherit' : 'ignore',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
    });
  });
}

function normalizeArch(arch: SupportedArch) {
  if (arch === 'x64') return 'amd64';
  if (arch === 'arm64') return 'arm64';
  if (arch === 'arm') return 'arm';
  return arch;
}

export function detectLinuxLibc() {
  if (process.platform !== 'linux') return 'unknown' as LinuxLibc;
  const report =
    typeof process.report?.getReport === 'function'
      ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
      : null;
  return report?.header?.glibcVersionRuntime ? 'glibc' : 'musl';
}

export function getCurrentPlatformDescriptor(): PlatformDescriptor {
  return {
    platform: process.platform,
    arch: process.arch,
    libc: detectLinuxLibc(),
  };
}

export function resolveNgrokAsset(descriptor: PlatformDescriptor): NgrokAsset {
  const arch = normalizeArch(descriptor.arch);
  if (descriptor.platform === 'darwin' && (arch === 'amd64' || arch === 'arm64')) {
    return {
      archiveType: 'zip',
      fileName: `ngrok-v3-stable-darwin-${arch}.zip`,
      url: `https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-darwin-${arch}.zip`,
      variantLabel: `macOS ${arch}`,
    };
  }

  if (descriptor.platform === 'linux' && (arch === 'amd64' || arch === 'arm64' || arch === 'arm')) {
    const libcLabel = descriptor.libc === 'musl' ? 'alpine/musl' : 'linux';
    return {
      archiveType: 'tgz',
      fileName: `ngrok-v3-stable-linux-${arch}.tgz`,
      url: `https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${arch}.tgz`,
      variantLabel: `${libcLabel} ${arch}`,
    };
  }

  throw new Error(`Unsupported platform for automatic ngrok install: ${descriptor.platform}/${descriptor.arch}`);
}

export function getNgrokInstallHint(descriptor: PlatformDescriptor): NgrokInstallHint {
  if (descriptor.platform === 'win32') {
    return {
      mode: 'manual',
      message:
        'Windows detected. Please install ngrok from the Windows App Store, then rerun `projectmesh share`.',
    };
  }

  const asset = resolveNgrokAsset(descriptor);
  return {
    mode: 'install',
    asset,
    message: `Install ngrok for ${asset.variantLabel} from ${asset.url}`,
  };
}

export function buildChatGptMcpUrl(ngrokBaseUrl: string) {
  return `${ngrokBaseUrl.replace(/\/$/, '')}${MCP_HTTP_PATH}`;
}

export function getProjectmeshServiceStatePath(platformHome = getPlatformHome()) {
  return path.join(platformHome, 'run', SERVICES_STATE_FILE);
}

function getPidFilePath(name: string, platformHome = getPlatformHome()) {
  return path.join(platformHome, 'run', name);
}

function getLogFilePath(name: string, platformHome = getPlatformHome()) {
  return path.join(platformHome, 'logs', name);
}

export function getNgrokManualSetupMessage(port = MCP_HTTP_PORT, mcpPath = MCP_HTTP_PATH) {
  return [
    'Before exposing your MCP server, make sure your ngrok account is linked.',
    '',
    'Run this command in another terminal and paste your token when prompted:',
    'ngrok config add-authtoken $YOUR_TOKEN',
    '',
    'Get your token here:',
    'https://dashboard.ngrok.com/get-started/your-authtoken',
    '',
    `Local MCP endpoint: http://127.0.0.1:${port}${mcpPath}`,
    '',
    'Security recommendation: this MCP server has no OAuth or other auth right now.',
    'Do not expose or leak your ngrok URL to anyone you do not trust.',
  ].join('\n');
}

async function commandExists(command: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, ['version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function fetchToFile(url: string, filePath: string) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  const body = Readable.fromWeb(response.body as any);
  await pipeline(body, createWriteStream(filePath));
}

async function installNgrokAsset(asset: NgrokAsset, targetDir: string) {
  await mkdir(targetDir, { recursive: true });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'projectmesh-ngrok-'));
  const archivePath = path.join(tempDir, asset.fileName);
  const extractedDir = path.join(tempDir, 'extract');
  await mkdir(extractedDir, { recursive: true });

  try {
    await fetchToFile(asset.url, archivePath);
    if (asset.archiveType === 'zip') {
      const zip = new AdmZip(archivePath);
      zip.extractAllTo(extractedDir, true);
    } else {
      await tar.x({
        file: archivePath,
        cwd: extractedDir,
      });
    }

    const sourceBinary = path.join(extractedDir, 'ngrok');
    const targetBinary = path.join(targetDir, 'ngrok');
    await copyFile(sourceBinary, targetBinary);
    await chmod(targetBinary, 0o755);
    return targetBinary;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function ensureNgrokBinary() {
  if (await commandExists('ngrok')) {
    return 'ngrok';
  }

  const hint = getNgrokInstallHint(getCurrentPlatformDescriptor());
  if (hint.mode === 'manual') {
    throw new Error(hint.message);
  }

  const installRoot = path.join(getPlatformHome(), 'cache', 'ngrok');
  const targetBinary = path.join(installRoot, 'ngrok');
  try {
    await chmod(targetBinary, 0o755);
    return targetBinary;
  } catch {
    return installNgrokAsset(hint.asset!, installRoot);
  }
}

async function hasNgrokAuthtokenConfigured() {
  try {
    const text = await readFile(getProjectmeshNgrokConfigPath(), 'utf8');
    return /\bauthtoken\s*:/i.test(text);
  } catch {
    return false;
  }
}

export async function ensureNgrokConfigFile() {
  const configPath = getProjectmeshNgrokConfigPath();
  await mkdir(path.dirname(configPath), { recursive: true });
  try {
    await readFile(configPath, 'utf8');
  } catch {
    await writeFile(configPath, 'version: 2\n', 'utf8');
  }
  return configPath;
}

export async function runNgrokAuthtokenCommand(token: string) {
  const ngrokBinary = await ensureNgrokBinary();
  await runCommand(ngrokBinary, ['config', 'add-authtoken', token], { inheritStdio: true });
}

export async function editNgrokConfig() {
  const configPath = await ensureNgrokConfigFile();
  const editor =
    process.env.EDITOR ??
    (process.platform === 'win32' ? 'notepad' : process.platform === 'darwin' ? 'open' : 'vi');

  const args =
    process.platform === 'darwin' && editor === 'open'
      ? ['-t', configPath]
      : [configPath];

  await runCommand(editor, args, { inheritStdio: true });
  return configPath;
}

async function readServiceState() {
  try {
    const text = await readFile(getProjectmeshServiceStatePath(), 'utf8');
    return JSON.parse(text) as ProjectmeshServiceState;
  } catch {
    return null;
  }
}

async function writeServiceState(state: ProjectmeshServiceState) {
  await ensurePlatformDirectories();
  await writeFile(getProjectmeshServiceStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function clearServiceState() {
  const files = [
    getProjectmeshServiceStatePath(),
    getPidFilePath(DASHBOARD_PID_FILE),
    getPidFilePath(MCP_PID_FILE),
    getPidFilePath(NGROK_PID_FILE),
  ];
  await Promise.all(files.map((file) => unlink(file).catch(() => undefined)));
}

async function promptForNgrokAuthTokenSetup() {
  if (await hasNgrokAuthtokenConfigured()) {
    return;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  process.stdout.write(`${getNgrokManualSetupMessage()}\n\n`);
  await rl.question(
    'Press Enter after you have run `ngrok config add-authtoken $YOUR_TOKEN`, or Ctrl+C to cancel. ',
  );
  rl.close();
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function startHttpMcpServer(port = MCP_HTTP_PORT, host = '127.0.0.1') {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);

      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, port, path: MCP_HTTP_PATH }));
        return;
      }

      if (url.pathname !== MCP_HTTP_PATH) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }

      const mcpServer = await buildMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolve());
  });

  return {
    port,
    host,
    path: MCP_HTTP_PATH,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function waitForNgrokUrl() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${NGROK_API_PORT}/api/tunnels`);
      if (response.ok) {
        const data = (await response.json()) as { tunnels?: Array<{ public_url?: string }> };
        const tunnel = data.tunnels?.find((entry) => entry.public_url?.startsWith('https://'));
        if (tunnel?.public_url) {
          return tunnel.public_url;
        }
      }
    } catch {
      // ngrok may not be ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out while waiting for ngrok to expose the local MCP server.');
}

function spawnNgrok(binaryPath: string, port: number) {
  return spawn(binaryPath, ['http', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForLocalMcpServer(port = MCP_HTTP_PORT) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // background process may still be starting
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('Timed out while waiting for the local MCP server to become healthy.');
}

async function waitForDashboardServer(port = DASHBOARD_PORT) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // background process may still be starting
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('Timed out while waiting for the Projectmesh dashboard to become healthy.');
}

function spawnBackgroundNode(args: string[], logFile: string) {
  const logFd = openSync(logFile, 'a');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  child.unref();
  return child;
}

function spawnBackgroundProcess(command: string, args: string[], logFile: string) {
  const logFd = openSync(logFile, 'a');
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  child.unref();
  return child;
}

async function writePidFile(filePath: string, pid: number) {
  await writeFile(filePath, `${pid}\n`, 'utf8');
}

async function stopPid(pid: number) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  return true;
}

export async function stopProjectmeshServices() {
  const state = await readServiceState();
  const stopped: string[] = [];
  if (state?.dashboard?.pid) {
    if (await stopPid(state.dashboard.pid)) stopped.push('dashboard');
  }
  if (state?.ngrok?.pid) {
    if (await stopPid(state.ngrok.pid)) stopped.push('ngrok');
  }
  if (state?.mcp?.pid) {
    if (await stopPid(state.mcp.pid)) stopped.push('mcp-http');
  }
  await clearServiceState();
  return stopped;
}

export async function getProjectmeshServiceStatus() {
  const state = await readServiceState();
  if (!state) {
    return null;
  }
  if (isPidAlive(state.dashboard.pid) && isPidAlive(state.mcp.pid) && isPidAlive(state.ngrok.pid)) {
    return state;
  }
  await clearServiceState();
  return null;
}

export async function shareMcpServer(options: { detached?: boolean } = {}) {
  if (options.detached) {
    const existingState = await getProjectmeshServiceStatus();
    if (existingState) {
      return existingState;
    }
  }

  const ngrokBinary = await ensureNgrokBinary();
  await promptForNgrokAuthTokenSetup();

  if (!options.detached) {
    const localServer = await startHttpMcpServer(MCP_HTTP_PORT);
    const ngrok = spawnNgrok(ngrokBinary, MCP_HTTP_PORT);
    ngrok.stdout.on('data', (chunk) => process.stdout.write(chunk));
    ngrok.stderr.on('data', (chunk) => process.stderr.write(chunk));
    const publicBaseUrl = await waitForNgrokUrl();
    const chatGptUrl = buildChatGptMcpUrl(publicBaseUrl);
    process.stdout.write(`ChatGPT MCP URL: ${chatGptUrl}\n`);
    const shutdown = async () => {
      ngrok.kill('SIGTERM');
      await localServer.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise((resolve, reject) => {
      ngrok.on('exit', (code) => {
        if (code === 0) resolve(undefined);
        else reject(new Error(`ngrok exited with code ${code ?? 'unknown'}`));
      });
      ngrok.on('error', reject);
    });
    return;
  }

  await ensurePlatformDirectories();
  const platformHome = getPlatformHome();
  const dashboardPidFile = getPidFilePath(DASHBOARD_PID_FILE, platformHome);
  const mcpPidFile = getPidFilePath(MCP_PID_FILE, platformHome);
  const ngrokPidFile = getPidFilePath(NGROK_PID_FILE, platformHome);
  const dashboardLogFile = getLogFilePath('dashboard.log', platformHome);
  const mcpLogFile = getLogFilePath('mcp-http.log', platformHome);
  const ngrokLogFile = getLogFilePath('ngrok.log', platformHome);
  const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : path.join(process.cwd(), 'dist/bin/ai.js');

  const dashboardChild = spawnBackgroundNode([scriptPath, 'dashboard', '--foreground'], dashboardLogFile);
  if (!dashboardChild.pid) {
    throw new Error('Failed to start the background Projectmesh dashboard.');
  }
  await writePidFile(dashboardPidFile, dashboardChild.pid);
  await waitForDashboardServer(DASHBOARD_PORT);

  const mcpChild = spawnBackgroundNode([scriptPath, 'mcp-http', '--foreground'], mcpLogFile);
  if (!mcpChild.pid) {
    throw new Error('Failed to start the background MCP HTTP server.');
  }
  await writePidFile(mcpPidFile, mcpChild.pid);
  await waitForLocalMcpServer(MCP_HTTP_PORT);

  const ngrokChild = spawnBackgroundProcess(ngrokBinary, ['http', String(MCP_HTTP_PORT)], ngrokLogFile);
  if (!ngrokChild.pid) {
    throw new Error('Failed to start the background ngrok tunnel.');
  }
  await writePidFile(ngrokPidFile, ngrokChild.pid);

  const publicBaseUrl = await waitForNgrokUrl();
  const chatGptUrl = buildChatGptMcpUrl(publicBaseUrl);
  const state: ProjectmeshServiceState = {
    startedAt: new Date().toISOString(),
    dashboard: {
      pid: dashboardChild.pid,
      port: DASHBOARD_PORT,
      pidFile: dashboardPidFile,
      logFile: dashboardLogFile,
      url: `http://127.0.0.1:${DASHBOARD_PORT}`,
    },
    mcp: {
      pid: mcpChild.pid,
      port: MCP_HTTP_PORT,
      host: '127.0.0.1',
      path: MCP_HTTP_PATH,
      pidFile: mcpPidFile,
      logFile: mcpLogFile,
    },
    ngrok: {
      pid: ngrokChild.pid,
      apiPort: NGROK_API_PORT,
      pidFile: ngrokPidFile,
      logFile: ngrokLogFile,
      publicUrl: publicBaseUrl,
    },
    chatGptUrl,
  };
  await writeServiceState(state);
  return state;
}
