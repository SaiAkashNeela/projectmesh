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
  writeExecutionState,
  readExecutionState,
  clearExecutionState,
  findTasksByStatus,
} from './ai-workspace.js';
import { getRunner, SUPPORTED_RUNNERS } from './agent-runners.js';
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

function spawnNewTerminalSession(cwd: string, command: string): Promise<void> {
  const isMac = process.platform === 'darwin';
  if (!isMac) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, {
        cwd,
        stdio: 'inherit',
        shell: true,
      });
      child.on('error', reject);
      child.on('exit', () => {
        resolve();
      });
    });
  }

  return new Promise<void>((resolve, reject) => {
    const escapedCwd = cwd.replace(/'/g, "'\\''");
    const escapedCommand = command.replace(/"/g, '\\"').replace(/'/g, "\\'");

    const appleScript = `
      tell application "Terminal"
        activate
        do script "cd '${escapedCwd}' && ${escapedCommand}"
      end tell
    `;

    const osascript = spawn('osascript', ['-e', appleScript], { stdio: 'ignore' });
    osascript.on('error', reject);
    osascript.on('exit', () => {
      resolve();
    });
  });
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
    case 'use':
    case 'new': {
      const targetArg = rest[0];
      let target: string;
      if (!targetArg) {
        if (command === 'use') {
          throw new Error('Missing workspace path. Usage: projectmesh use <workspace-path>');
        }
        target = getDefaultWorkspaceTarget();
      } else {
        target = await resolveWorkspaceTarget(targetArg);
      }

      const repo = await setActiveRepo(target);
      const workspace = createWorkspace(repo.root);

      const { stat } = await import('node:fs/promises');
      let hasWorkspace = false;
      try {
        await stat(workspace.projectmeshDir);
        hasWorkspace = true;
      } catch {}

      if (!hasWorkspace) {
        await ensureProjectmeshWorkspace(workspace);
        const analysis = await analyzeRepository(workspace);
        await updateArchitectureFromAnalysis(workspace, analysis);
        return [
          `Active workspace: ${repo.root}`,
          `Initialized Projectmesh workspace at ${workspace.projectmeshDir}`,
          `Architecture written to ${workspace.projectmeshDir}/architecture.md`,
        ].join('\n');
      }

      return `Active workspace: ${repo.root}`;
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

      // Parse taskId from flags or arguments
      let taskId: string | undefined = undefined;
      const taskFlagIndex = rest.findIndex(arg => arg === '--task' || arg.startsWith('--task='));
      if (taskFlagIndex !== -1) {
        const flag = rest[taskFlagIndex];
        if (flag.startsWith('--task=')) {
          taskId = flag.split('=')[1];
        } else if (taskFlagIndex + 1 < rest.length) {
          taskId = rest[taskFlagIndex + 1];
        }
      }

      const executorIds = ['claude', 'codex', 'gemini', 'opencode', 'grok', 'custom'];
      let executorId = 'claude';
      if (args.length > 0) {
        const firstArg = args[0].toLowerCase();
        if (executorIds.includes(firstArg)) {
          executorId = firstArg;
          if (args[1] && !taskId) {
            taskId = args[1];
          }
        } else if (firstArg.startsWith('task-') || firstArg === 'active') {
          if (!taskId) {
            taskId = args[0];
          }
        } else {
          executorId = args[0];
        }
      }

      let resolvedCommand = '';
      let runner = null;
      let actualTaskId: string | undefined = undefined;

      // Check if there is a pending request first if no executorId was explicitly passed
      const pending = await getPendingExecution(workspace);

      if (args.length === 0 && !taskId && pending) {
        executorId = pending.executorId;
        resolvedCommand = pending.command;
        runner = getRunner(executorId);
        actualTaskId = pending.taskId;

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
        // Clear any pending request since we are manually running or specifying an executor
        await clearPendingExecution(workspace);

        try {
          runner = getRunner(executorId);
        } catch (err) {
          throw new Error(`Unsupported agent executor: ${executorId}. Supported executors: ${SUPPORTED_RUNNERS.map(r => r.id).join(', ')}`);
        }

        // Generate the packet (or ensure it exists)
        const packet = await generateTaskPacket(workspace, taskId);
        const relativePacketPath = path.relative(workspace.root, packet.filePath);

        actualTaskId = taskId;
        if (!actualTaskId) {
          let activeExists = false;
          try {
            const activeContent = await workspace.readTextFile('.projectmesh/tasks/active.md');
            if (!activeContent.includes('No active task.')) {
              activeExists = true;
            }
          } catch {}
          
          if (activeExists) {
            actualTaskId = 'active';
          } else {
            const activeTasks = await findTasksByStatus(workspace, 'active');
            if (activeTasks.length > 0) {
              actualTaskId = activeTasks[0].id;
            }
          }
        }

        if (!actualTaskId) {
          throw new Error('No active task found to execute.');
        }

        const taskFilePath = actualTaskId === 'active'
          ? '.projectmesh/tasks/active.md'
          : `.projectmesh/tasks/${actualTaskId}.md`;

        const activeTaskContent = await workspace.readTextFile(taskFilePath);
        const objectiveMatch = activeTaskContent.match(/## Objective\r?\n([^\n]+)/);
        const objective = objectiveMatch ? objectiveMatch[1].trim() : 'Active Task';

        resolvedCommand = runner.buildCommand({
          objective,
          packetPath: relativePacketPath,
          workspaceRoot: workspace.root
        });

        if (!skipConfirm) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question(
            `About to execute task using ${runner.name}:\n` +
            `  Command: ${resolvedCommand}\n\n` +
            `Do you want to proceed? (y/N): `
          );
          rl.close();
          if (answer.trim().toLowerCase() !== 'y') {
            return 'Execution cancelled.';
          }
        }
      }

      // Check context packet contents
      let hasArch = false;
      try {
        const archContent = await workspace.readTextFile('.projectmesh/architecture.md');
        hasArch = archContent.trim().length > 30;
      } catch {}

      let hasDecisions = false;
      try {
        const decContent = await workspace.readTextFile('.projectmesh/decisions.md');
        hasDecisions = decContent.trim().length > 30;
      } catch {}

      let hasFiles = false;
      try {
        const taskFilePath = actualTaskId === 'active'
          ? '.projectmesh/tasks/active.md'
          : `.projectmesh/tasks/${actualTaskId}.md`;

        const activeTaskContent = await workspace.readTextFile(taskFilePath);
        const lines = activeTaskContent.split(/\r?\n/);
        let inSection = false;
        for (const line of lines) {
          if (line.startsWith('## ')) {
            if (inSection) break;
            if (line.trim().toLowerCase().startsWith('## affected files')) inSection = true;
          } else if (inSection) {
            const trimmed = line.trim();
            if ((trimmed.startsWith('-') || trimmed.startsWith('*')) && !trimmed.toLowerCase().includes('none')) {
              hasFiles = true;
              break;
            }
          }
        }
      } catch {}

      process.stdout.write(`\nContext packet loaded:\n`);
      process.stdout.write(`${hasArch ? '✓' : '✗'} architecture\n`);
      process.stdout.write(`${hasDecisions ? '✓' : '✗'} decisions\n`);
      process.stdout.write(`${hasFiles ? '✓' : '✗'} affected files\n\n`);

      const startTmp = '.projectmesh/tasks/exec-start.tmp';
      const statusTmp = '.projectmesh/tasks/exec-status.tmp';

      const startTmpAbs = workspace.resolveReadPath(startTmp);
      const statusTmpAbs = workspace.resolveReadPath(statusTmp);

      const { unlink } = await import('node:fs/promises');
      await unlink(startTmpAbs).catch(() => undefined);
      await unlink(statusTmpAbs).catch(() => undefined);

      const wrappedCommand = `date +%s > ${startTmp} && ${resolvedCommand}; echo $? > ${statusTmp}`;

      const startTimeStamp = new Date().toISOString();
      await writeExecutionState(workspace, {
        executorId: runner.id,
        command: resolvedCommand,
        status: 'running',
        startedAt: startTimeStamp
      });

      process.stdout.write(`Opening new terminal...\n`);
      process.stdout.write(`${runner.commandName} started\n\n`);
      process.stdout.write(`Status:\nrunning...\n`);

      // Spawn the session
      if (process.env.NODE_ENV === 'test') {
        await workspace.writeProjectmeshTextFile(startTmp, String(Math.floor(Date.now() / 1000)));
        await workspace.writeProjectmeshTextFile(statusTmp, '0');
      } else {
        await spawnNewTerminalSession(workspace.root, wrappedCommand);
      }

      const startTime = Date.now();
      let exitCode = 0;

      while (true) {
        try {
          const statusContent = await workspace.readTextFile(statusTmp);
          exitCode = parseInt(statusContent.trim(), 10);
          if (!isNaN(exitCode)) {
            break;
          }
        } catch {
          // File not created yet
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const durationMs = Date.now() - startTime;
      const finishedTimeStamp = new Date().toISOString();

      await unlink(startTmpAbs).catch(() => undefined);
      await unlink(statusTmpAbs).catch(() => undefined);

      const finalStatus = exitCode === 0 ? 'completed' : 'failed';
      await writeExecutionState(workspace, {
        executorId: runner.id,
        command: resolvedCommand,
        status: finalStatus,
        startedAt: startTimeStamp,
        finishedAt: finishedTimeStamp,
        exitCode
      });

      let diffAfter = '';
      try {
        diffAfter = await git.gitDiff();
      } catch {}

      const executionReportPath = await createExecutionReport(workspace, {
        executorId: runner.id,
        command: resolvedCommand,
        exitCode,
        durationMs,
        diffBeforeAfter: diffAfter
      });

      return [
        `Status: ${finalStatus}`,
        `Exit Code: ${exitCode}`,
        `Duration: ${(durationMs / 1000).toFixed(2)}s`,
        `Report generated: ${executionReportPath}`
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
