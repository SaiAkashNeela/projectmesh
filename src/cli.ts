import { analyzeRepository } from './repository-analysis.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import {
  ensureProjectmeshWorkspace,
  generateTaskPacket,
  updateArchitectureFromAnalysis,
  SUPPORTED_EXECUTORS,
  createPendingExecution,
  getPendingExecution,
  clearPendingExecution,
  createExecutionReport,
} from './ai-workspace.js';
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
import { createGitTools } from './git.js';
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
    '  projectmesh execute [executor-id]',
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
    case 'execute': {
      const repo = await getActiveRepo();
      const workspace = createWorkspace(repo.root);
      const git = createGitTools(workspace);

      // Parse arguments
      const flags = rest.filter((arg) => arg.startsWith('-'));
      const args = rest.filter((arg) => !arg.startsWith('-'));
      const skipConfirm = flags.includes('--yes') || flags.includes('-y');

      let executorId = args[0];
      let resolvedCommand = '';

      // Check if there is a pending request first if no executorId is provided
      const pending = await getPendingExecution(workspace);

      if (!executorId && pending) {
        executorId = pending.executorId;
        resolvedCommand = pending.command;

        if (!skipConfirm) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question(
            `Detected pending execution request from MCP:\n` +
            `  Executor: ${executorId}\n` +
            `  Command:  ${resolvedCommand}\n\n` +
            `Do you want to execute this? (y/N): `
          );
          rl.close();
          if (answer.trim().toLowerCase() !== 'y') {
            await clearPendingExecution(workspace);
            return 'Execution cancelled and pending request cleared.';
          }
        }
        await clearPendingExecution(workspace);
      } else {
        // Clear any stale pending requests
        await clearPendingExecution(workspace);

        if (!executorId) {
          const list = SUPPORTED_EXECUTORS.map((e) => `  - ${e.id}: ${e.name} (${e.description})`).join('\n');
          return `Usage: projectmesh execute <executor-id> [--yes]\n\nAvailable executors:\n${list}`;
        }

        const executor = SUPPORTED_EXECUTORS.find((e) => e.id === executorId);
        if (!executor) {
          throw new Error(`Unsupported executor ID: ${executorId}. Run 'projectmesh execute' to see supported executors.`);
        }

        // Generate the packet (or ensure it exists)
        const packet = await generateTaskPacket(workspace);
        const relativePacketPath = path.relative(workspace.root, packet.filePath);
        resolvedCommand = executor.command.replace('{packetPath}', relativePacketPath);

        if (!skipConfirm) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question(
            `About to execute task using ${executor.name}:\n` +
            `  Command: ${resolvedCommand}\n\n` +
            `Do you want to proceed? (y/N): `
          );
          rl.close();
          if (answer.trim().toLowerCase() !== 'y') {
            return 'Execution cancelled.';
          }
        }
      }

      // Execute command in workspace root
      const commandParts = resolvedCommand.split(' ');
      const mainCmd = commandParts[0];
      const cmdArgs = commandParts.slice(1);

      // Add any extra arguments passed via CLI (excluding -y / --yes / executorId)
      const extraArgs = rest.filter((arg) => arg !== executorId && arg !== '-y' && arg !== '--yes');
      cmdArgs.push(...extraArgs);

      const fullCommandStr = [mainCmd, ...cmdArgs].join(' ');
      process.stdout.write(`Executing: ${fullCommandStr}\n\n`);

      const startTime = Date.now();

      // Spawn process in foreground
      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(mainCmd, cmdArgs, {
          cwd: workspace.root,
          stdio: 'inherit',
          shell: true
        });
        child.on('error', reject);
        child.on('exit', (code) => {
          resolve(code ?? 0);
        });
      });

      const durationMs = Date.now() - startTime;

      // Get git diff after execution
      let diffAfter = '';
      try {
        diffAfter = await git.gitDiff();
      } catch {}

      const executionReportPath = await createExecutionReport(workspace, {
        executorId,
        command: fullCommandStr,
        exitCode,
        durationMs,
        diffBeforeAfter: diffAfter
      });

      return [
        '',
        '# Execution Complete',
        `Exit Code: ${exitCode}`,
        `Duration: ${(durationMs / 1000).toFixed(2)}s`,
        `Report generated: ${executionReportPath}`,
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
