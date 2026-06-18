import { analyzeRepository } from './repository-analysis.js';
import { ensureProjectmeshWorkspace, generateTaskPacket, updateArchitectureFromAnalysis } from './ai-workspace.js';
import { DASHBOARD_PORT, startDashboardServer } from './dashboard.js';
import { getActiveRepo, readReposConfig, setActiveRepo } from './platform-config.js';
import {
  editNgrokConfig,
  ensureNgrokConfigFile,
  MCP_HTTP_PATH,
  MCP_HTTP_PORT,
  getProjectmeshServiceStatus,
  getProjectmeshNgrokConfigPath,
  getNgrokManualSetupMessage,
  runNgrokAuthtokenCommand,
  shareMcpServer,
  startHttpMcpServer,
  stopProjectmeshServices,
} from './share.js';
import { createWorkspace } from './workspace.js';
import path from 'node:path';

export function getDefaultWorkspaceTarget(cwd = process.cwd()) {
  return cwd;
}

async function resolveWorkspaceTarget(target: string) {
  const looksLikePath = target.includes('/') || target.startsWith('.') || target.startsWith('~');
  if (looksLikePath) {
    return target;
  }

  const config = await readReposConfig();
  const repo = config.repos.find(
    (entry) => entry.id === target || entry.name === target || path.basename(entry.root) === target,
  );
  return repo?.root ?? target;
}

function helpText() {
  return [
    'Usage:',
    '  projectmesh new [workspace-path]',
    '  projectmesh use <workspace-path>',
    '  projectmesh status',
    '  projectmesh analyze',
    '  projectmesh setup <workspace-path>',
    '  projectmesh start',
    '  projectmesh stop',
    '  projectmesh share',
    '  projectmesh packet',
    '  projectmesh mcp',
    '  projectmesh mcp-http [--foreground]',
    '  projectmesh dashboard [--foreground]',
    '  projectmesh ngrok config',
    '  projectmesh ngrok edit',
    '  projectmesh ngrok auth [token]',
  ].join('\n');
}

export async function runCli(argv: string[]) {
  const [command, ...rest] = argv;

  switch (command) {
    case 'use': {
      const target = rest[0];
      if (!target) throw new Error('Missing workspace path. Usage: projectmesh use <workspace-path>');
      const repo = await setActiveRepo(await resolveWorkspaceTarget(target));
      return `Active workspace: ${repo.root}`;
    }
    case 'new': {
      const target = rest[0] ? await resolveWorkspaceTarget(rest[0]) : getDefaultWorkspaceTarget();
      const repo = await setActiveRepo(target);
      const workspace = createWorkspace(repo.root);
      await ensureProjectmeshWorkspace(workspace);
      const analysis = await analyzeRepository(workspace);
      await updateArchitectureFromAnalysis(workspace, analysis);
      return [
        `Active workspace: ${repo.root}`,
        `Initialized Projectmesh workspace at ${workspace.projectmeshDir}`,
        `Architecture written to ${workspace.projectmeshDir}/architecture.md`,
      ].join('\n');
    }
    case 'status': {
      const repo = await getActiveRepo();
      const state = await getProjectmeshServiceStatus();
      const workspace = createWorkspace(repo.root);
      let taskStatus = 'No active task';
      try {
        const activeTaskContent = await workspace.readTextFile('.projectmesh/tasks/active.md');
        if (!activeTaskContent.includes('No active task.')) {
          const objectiveMatch = activeTaskContent.match(/## Objective\r?\n([^\n]+)/);
          const objective = objectiveMatch ? objectiveMatch[1].trim() : 'Active Task';

          let packetStatus = 'Not generated';
          try {
            await workspace.readTextFile('.projectmesh/context/active-packet.md');
            packetStatus = 'Generated (.projectmesh/context/active-packet.md)';
          } catch {}

          taskStatus = `Active: "${objective}"\nTask Packet: ${packetStatus}`;
        }
      } catch {}

      return [
        `Active workspace: ${repo.root}`,
        `Task status: ${taskStatus}`,
        state
          ? `Service status: running\nChatGPT MCP URL: ${state.chatGptUrl}\nLocal MCP endpoint: http://${state.mcp.host}:${state.mcp.port}${state.mcp.path}\nDashboard URL: ${state.dashboard.url}`
          : 'Service status: stopped',
      ].join('\n');
    }
    case 'analyze': {
      const repo = await getActiveRepo();
      const workspace = createWorkspace(repo.root);
      await ensureProjectmeshWorkspace(workspace);
      const analysis = await analyzeRepository(workspace);
      await updateArchitectureFromAnalysis(workspace, analysis);
      return `Architecture written to ${workspace.projectmeshDir}/architecture.md`;
    }
    case 'setup': {
      const target = rest[0] ? await resolveWorkspaceTarget(rest[0]) : getDefaultWorkspaceTarget();
      const repo = await setActiveRepo(target);
      const workspace = createWorkspace(repo.root);
      await ensureProjectmeshWorkspace(workspace);
      const analysis = await analyzeRepository(workspace);
      await updateArchitectureFromAnalysis(workspace, analysis);
      const state = await shareMcpServer({ detached: true });
      if (!state) {
        throw new Error('Projectmesh failed to start background services.');
      }
      return [
        `Active workspace: ${repo.root}`,
        `Architecture written to ${workspace.projectmeshDir}/architecture.md`,
        '',
        '# Projectmesh Ready',
        `ChatGPT MCP URL: ${state.chatGptUrl}`,
        `Local MCP endpoint: http://${state.mcp.host}:${state.mcp.port}${state.mcp.path}`,
        `Dashboard URL: ${state.dashboard.url}`,
        '',
        'Stop services later with: projectmesh stop',
      ].join('\n');
    }
    case 'start': {
      await getActiveRepo();
      const state = await shareMcpServer({ detached: true });
      if (!state) {
        throw new Error('Projectmesh failed to start background services.');
      }
      return [
        '# Projectmesh Started',
        `ChatGPT MCP URL: ${state.chatGptUrl}`,
        `Local MCP endpoint: http://${state.mcp.host}:${state.mcp.port}${state.mcp.path}`,
        `Dashboard URL: ${state.dashboard.url}`,
        '',
        'Stop services later with: projectmesh stop',
      ].join('\n');
    }
    case 'packet': {
      const repo = await getActiveRepo();
      const workspace = createWorkspace(repo.root);
      const result = await generateTaskPacket(workspace);
      return [
        '# Task Packet Generated',
        `File: ${result.filePath}`,
        '',
        'Use this packet to feed clean, self-contained context to your AI executor agent.',
      ].join('\n');
    }
    case 'stop': {
      const stopped = await stopProjectmeshServices();
      return stopped.length
        ? `Stopped services: ${stopped.join(', ')}`
        : 'No running Projectmesh services were recorded.';
    }
    case 'mcp':
      return 'Use the projectmesh-mcp-server binary to start the stdio MCP server.';
    case 'mcp-http': {
      const foreground = rest.includes('--foreground');
      await startHttpMcpServer(MCP_HTTP_PORT);
      if (foreground) {
        await new Promise(() => undefined);
      }
      return `HTTP MCP server listening at http://127.0.0.1:${MCP_HTTP_PORT}${MCP_HTTP_PATH}`;
    }
    case 'dashboard': {
      const foreground = rest.includes('--foreground');
      await startDashboardServer(DASHBOARD_PORT);
      if (foreground) {
        await new Promise(() => undefined);
      }
      return `Projectmesh dashboard listening at http://127.0.0.1:${DASHBOARD_PORT}`;
    }
    case 'share': {
      await getActiveRepo();
      const state = await shareMcpServer({ detached: true });
      if (!state) {
        throw new Error('Projectmesh failed to start background services.');
      }
      return [
        '# Projectmesh Share Ready',
        `ChatGPT MCP URL: ${state.chatGptUrl}`,
        `Local MCP endpoint: http://${state.mcp.host}:${state.mcp.port}${state.mcp.path}`,
        `Dashboard URL: ${state.dashboard.url}`,
        '',
        'Security recommendation:',
        'This MCP server currently has no OAuth or other auth layer.',
        'Do not expose or leak your ngrok URL.',
        '',
        'Stop services later with: projectmesh stop',
      ].join('\n');
    }
    case 'ngrok': {
      const subcommand = rest[0];
      if (subcommand === 'config') {
        const configPath = await ensureNgrokConfigFile();
        return `ngrok config path: ${configPath}`;
      }
      if (subcommand === 'edit') {
        const configPath = await editNgrokConfig();
        return `Edited ngrok config: ${configPath}`;
      }
      if (subcommand === 'auth') {
        const token = rest[1];
        if (!token) {
          return getNgrokManualSetupMessage(MCP_HTTP_PORT, MCP_HTTP_PATH);
        }
        await runNgrokAuthtokenCommand(token);
        return `Updated ngrok auth token in ${getProjectmeshNgrokConfigPath()}`;
      }
      throw new Error('Usage: projectmesh ngrok <config|edit|auth [token]>');
    }
    case undefined:
      return helpText();
    default:
      throw new Error(`Unknown command: ${command}\n\n${helpText()}`);
  }
}
