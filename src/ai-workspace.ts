import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { AgentExecutor, AnalysisResult, CompleteTaskInput, PendingExecutionRequest, ReviewInput, TaskInput, ExecutionState } from './types.js';
import type { Workspace } from './workspace.js';
import { getRunner, SUPPORTED_RUNNERS } from './agent-runners.js';

function nowStamp() {
  return new Date().toISOString();
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'entry';
}

function asBulletList(items: string[]) {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '- None';
}

export async function ensureProjectmeshWorkspace(workspace: Workspace) {
  const dirs = [
    '.projectmesh',
    '.projectmesh/reviews',
    '.projectmesh/tasks',
    '.projectmesh/tasks/completed',
    '.projectmesh/context',
  ];
  for (const dir of dirs) {
    await mkdir(path.join(workspace.root, dir), { recursive: true });
  }

  const defaults: Array<[string, string]> = [
    ['.projectmesh/architecture.md', '# Repository Architecture\n\n'],
    ['.projectmesh/decisions.md', '# Architectural Decisions\n\n'],
    ['.projectmesh/coding-style.md', '# Coding Style\n\n'],
    ['.projectmesh/memory.md', '# Working Memory\n\n'],
  ];

  for (const [file, content] of defaults) {
    try {
      await workspace.readTextFile(file);
    } catch {
      await workspace.writeProjectmeshTextFile(file, content);
    }
  }
}

export async function getNextTaskId(workspace: Workspace): Promise<string> {
  const tasksDir = path.join(workspace.root, '.projectmesh/tasks');
  try {
    const files = await readdir(tasksDir);
    let maxNum = 0;
    for (const file of files) {
      const match = file.match(/^task-(\d+)\.md$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) {
          maxNum = num;
        }
      }
    }
    const nextNum = maxNum + 1;
    return `task-${String(nextNum).padStart(3, '0')}`;
  } catch {
    return 'task-001';
  }
}

export interface TaskSummaryInfo {
  id: string;
  filePath: string;
  status: string;
  objective: string;
}

export async function listAllTasks(workspace: Workspace): Promise<TaskSummaryInfo[]> {
  const tasksDir = path.join(workspace.root, '.projectmesh/tasks');
  const results: TaskSummaryInfo[] = [];

  try {
    const activeContent = await workspace.readTextFile('.projectmesh/tasks/active.md');
    if (!activeContent.includes('No active task.')) {
      const statusMatch = activeContent.match(/## Status\r?\n([^\n]+)/);
      const objectiveMatch = activeContent.match(/## Objective\r?\n([^\n]+)/);
      results.push({
        id: 'active',
        filePath: '.projectmesh/tasks/active.md',
        status: statusMatch ? statusMatch[1].trim() : 'active',
        objective: objectiveMatch ? objectiveMatch[1].trim() : 'Active Task',
      });
    }
  } catch {}

  try {
    const files = await readdir(tasksDir);
    for (const file of files) {
      const match = file.match(/^(task-\d+)\.md$/);
      if (match) {
        const id = match[1];
        const filePath = `.projectmesh/tasks/${file}`;
        try {
          const content = await workspace.readTextFile(filePath);
          const statusMatch = content.match(/## Status\r?\n([^\n]+)/);
          const objectiveMatch = content.match(/## Objective\r?\n([^\n]+)/);
          results.push({
            id,
            filePath,
            status: statusMatch ? statusMatch[1].trim() : 'unknown',
            objective: objectiveMatch ? objectiveMatch[1].trim() : 'Untitled Task',
          });
        } catch {}
      }
    }
  } catch {}

  return results;
}

export async function findTasksByStatus(workspace: Workspace, status: string): Promise<TaskSummaryInfo[]> {
  const all = await listAllTasks(workspace);
  return all.filter(t => t.status.toLowerCase() === status.toLowerCase() && t.id !== 'active');
}

export async function createTask(workspace: Workspace, input: TaskInput) {
  await ensureProjectmeshWorkspace(workspace);
  
  const taskId = input.id ?? (await getNextTaskId(workspace));
  const taskRelativePath = `.projectmesh/tasks/${taskId}.md`;

  const markdown = [
    '# Active Task',
    '',
    '## Objective',
    input.objective,
    '',
    '## Background',
    input.background,
    '',
    '## Requirements',
    asBulletList(input.requirements),
    '',
    '## Affected Files',
    asBulletList(input.affectedFiles),
    '',
    '## Implementation Plan',
    asBulletList(input.implementationPlan),
    '',
    '## Acceptance Criteria',
    asBulletList(input.acceptanceCriteria),
    '',
    '## Risks',
    asBulletList(input.risks),
    '',
    '## Status',
    input.status,
    '',
  ].join('\n');

  const maxAttempts = 3;
  let lastError: Error | null = null;
  let finalFilePath = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      finalFilePath = await workspace.writeProjectmeshTextFile(taskRelativePath, markdown);
      
      // Confirm creation by reading the file back and checking if content matches
      const content = await workspace.readTextFile(taskRelativePath);
      if (content === markdown) {
        if (input.status.toLowerCase() === 'active') {
          await workspace.writeProjectmeshTextFile('.projectmesh/tasks/active.md', markdown);
          
          // Verify active.md
          const activeContent = await workspace.readTextFile('.projectmesh/tasks/active.md');
          if (activeContent !== markdown) {
            throw new Error('Verification failed: active.md content did not match expected task markdown');
          }
        }
        return finalFilePath;
      }
      
      throw new Error(`Verification failed: ${taskId}.md content did not match expected task markdown`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(`Failed to create task after 3 attempts. The task was not sent. Last error: ${lastError?.message}`);
}

export async function completeTask(workspace: Workspace, input: CompleteTaskInput & { id?: string }) {
  await ensureProjectmeshWorkspace(workspace);
  
  let actualTaskId = input.id;
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
    throw new Error('No active task found to complete.');
  }

  const taskFilePath = actualTaskId === 'active'
    ? '.projectmesh/tasks/active.md'
    : `.projectmesh/tasks/${actualTaskId}.md`;

  const current = await workspace.readTextFile(taskFilePath);
  const archivedName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${slugify(input.summary)}.md`;
  const archivedRelative = `.projectmesh/tasks/completed/${archivedName}`;
  const archivedAbsolute = workspace.resolveProjectmeshWritePath(archivedRelative);
  
  // Replace the Status header with finalStatus
  const updatedCurrent = current.replace(/## Status\r?\n[^\n]+/g, `## Status\n${input.finalStatus}`);
  
  const archivedText = `${updatedCurrent}\n## Completion Summary\n${input.summary}\n\n## Final Status\n${input.finalStatus}\n`;
  await workspace.writeProjectmeshTextFile(archivedRelative, archivedText);

  if (actualTaskId === 'active') {
    await workspace.writeProjectmeshTextFile(
      '.projectmesh/tasks/active.md',
      '# Active Task\n\nNo active task. The previous task was archived in `.projectmesh/tasks/completed/`.\n',
    );
  } else {
    // Update the task file status to completed
    await workspace.writeProjectmeshTextFile(taskFilePath, updatedCurrent);
    
    // Clear active.md if it matches the current task being completed
    try {
      const activeContent = await workspace.readTextFile('.projectmesh/tasks/active.md');
      const objectiveMatch = current.match(/## Objective\r?\n([^\n]+)/);
      const objective = objectiveMatch ? objectiveMatch[1].trim() : '';
      if (objective && activeContent.includes(objective)) {
        await workspace.writeProjectmeshTextFile(
          '.projectmesh/tasks/active.md',
          '# Active Task\n\nNo active task. The previous task was archived in `.projectmesh/tasks/completed/`.\n',
        );
      }
    } catch {}
  }

  return archivedAbsolute;
}

export async function createReview(workspace: Workspace, input: ReviewInput) {
  await ensureProjectmeshWorkspace(workspace);
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${slugify(input.title)}.md`;
  const relativePath = `.projectmesh/reviews/${filename}`;
  const content = [
    `# ${input.title}`,
    '',
    `- Kind: ${input.kind}`,
    `- Created: ${nowStamp()}`,
    '',
    input.body,
    '',
  ].join('\n');
  return workspace.writeProjectmeshTextFile(relativePath, content);
}

async function appendSection(workspace: Workspace, relativePath: string, content: string) {
  await ensureProjectmeshWorkspace(workspace);
  const current = await workspace.readTextFile(relativePath);
  const next = `${current}## ${nowStamp()}\n${content}\n\n`;
  return workspace.writeProjectmeshTextFile(relativePath, next);
}

export async function updateMemory(workspace: Workspace, content: string) {
  return appendSection(workspace, '.projectmesh/memory.md', content);
}

export async function updateDecision(workspace: Workspace, content: string) {
  return appendSection(workspace, '.projectmesh/decisions.md', content);
}

export async function updateArchitecture(
  workspace: Workspace,
  content: string,
  options: { append?: boolean } = {},
) {
  await ensureProjectmeshWorkspace(workspace);
  if (options.append) {
    return appendSection(workspace, '.projectmesh/architecture.md', content);
  }
  return workspace.writeProjectmeshTextFile('.projectmesh/architecture.md', content);
}

export function renderArchitectureMarkdown(analysis: AnalysisResult) {
  return [
    '# Repository Architecture',
    '',
    '## Detected Frameworks',
    asBulletList(analysis.frameworks),
    '',
    '## Detected Languages',
    asBulletList(analysis.languages),
    '',
    '## Package Manager',
    analysis.packageManager,
    '',
    '## Database Technologies',
    asBulletList(analysis.databaseTechnologies),
    '',
    '## Deployment Technologies',
    asBulletList(analysis.deploymentTechnologies),
    '',
    '## Major Services',
    asBulletList(analysis.majorServices),
    '',
    '## Folder Structure Summary',
    asBulletList(analysis.folderStructureSummary),
    '',
  ].join('\n');
}

export async function updateArchitectureFromAnalysis(workspace: Workspace, analysis: AnalysisResult) {
  return updateArchitecture(workspace, renderArchitectureMarkdown(analysis));
}

function parseAffectedFiles(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const affectedFiles: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (inSection) {
        break;
      }
      if (line.trim().toLowerCase().startsWith('## affected files')) {
        inSection = true;
      }
    } else if (inSection) {
      const trimmed = line.trim();
      if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
        let fileStr = trimmed.replace(/^[-*]\s*/, '').trim();
        const linkMatch = fileStr.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (linkMatch) {
          fileStr = linkMatch[1];
        }
        fileStr = fileStr.replace(/`/g, '').trim();
        if (fileStr && fileStr.toLowerCase() !== 'none') {
          affectedFiles.push(fileStr);
        }
      }
    }
  }
  return affectedFiles;
}

async function getFileContentOrSummary(workspace: Workspace, relativePath: string): Promise<string> {
  try {
    const absPath = workspace.resolveReadPath(relativePath);
    const stats = await stat(absPath);
    if (stats.isDirectory()) {
      return '*Path is a directory.*';
    }
    if (stats.size > 50 * 1024) {
      return `*File size (${(stats.size / 1024).toFixed(1)} KB) exceeds the maximum limit (50 KB). Skipping content.*`;
    }
    const content = await workspace.readTextFile(relativePath);
    if (content.includes('\0')) {
      return '*Binary file detected. Content skipped.*';
    }
    return content;
  } catch {
    return '*File does not exist yet (to be created).*';
  }
}

async function readProjectmeshFileSafe(workspace: Workspace, relativePath: string, defaultVal: string): Promise<string> {
  try {
    return await workspace.readTextFile(relativePath);
  } catch {
    return defaultVal;
  }
}

export async function generateTaskPacket(workspace: Workspace, taskId?: string) {
  await ensureProjectmeshWorkspace(workspace);
  
  let actualTaskId = taskId;
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
    throw new Error('No active task found in .projectmesh/tasks/active.md. Cannot generate a task packet.');
  }

  const taskFilePath = actualTaskId === 'active'
    ? '.projectmesh/tasks/active.md'
    : `.projectmesh/tasks/${actualTaskId}.md`;

  let activeTaskContent = '';
  try {
    activeTaskContent = await workspace.readTextFile(taskFilePath);
  } catch {
    throw new Error(`Task ${actualTaskId} not found at ${taskFilePath}. Cannot generate a task packet.`);
  }
  
  if (activeTaskContent.includes('No active task.')) {
    throw new Error(`No active task found in ${taskFilePath}. Cannot generate a task packet.`);
  }

  const affectedFiles = parseAffectedFiles(activeTaskContent);

  const architecture = await readProjectmeshFileSafe(workspace, '.projectmesh/architecture.md', '# Repository Architecture\n\nNot defined yet.\n');
  const decisions = await readProjectmeshFileSafe(workspace, '.projectmesh/decisions.md', '# Architectural Decisions\n\nNo decisions recorded.\n');
  const codingStyle = await readProjectmeshFileSafe(workspace, '.projectmesh/coding-style.md', '# Coding Style\n\nNo custom coding style defined.\n');
  const memory = await readProjectmeshFileSafe(workspace, '.projectmesh/memory.md', '# Working Memory\n\nNo working memory saved.\n');

  const fileContexts: string[] = [];
  for (const file of affectedFiles) {
    const fileContent = await getFileContentOrSummary(workspace, file);
    const ext = path.extname(file).slice(1) || 'text';
    fileContexts.push(
      `### File: \`${file}\``,
      '',
      fileContent.startsWith('*') && fileContent.endsWith('*') 
        ? fileContent 
        : `\`\`\`${ext}\n${fileContent}\n\`\`\``,
      ''
    );
  }

  const objectiveMatch = activeTaskContent.match(/## Objective\r?\n([^\n]+)/);
  const objective = objectiveMatch ? objectiveMatch[1].trim() : 'Active Task';

  const markdown = [
    `# TASK PACKET: ${objective}`,
    '',
    `Generated at: ${nowStamp()}`,
    '',
    '## 1. Active Task Details',
    '',
    activeTaskContent,
    '',
    '## 2. Project Architecture & Decisions',
    '',
    '### Repository Architecture',
    architecture,
    '',
    '### Architectural Decisions',
    decisions,
    '',
    '### Coding Style Guide',
    codingStyle,
    '',
    '### Working Memory',
    memory,
    '',
    '## 3. Affected Files Context',
    '',
    fileContexts.join('\n'),
    '',
  ].join('\n');

  const filePath = await workspace.writeProjectmeshTextFile('.projectmesh/context/active-packet.md', markdown);
  return { filePath, content: markdown };
}

export const SUPPORTED_EXECUTORS: AgentExecutor[] = SUPPORTED_RUNNERS.map((runner) => ({
  id: runner.id,
  name: runner.name,
  command: runner.commandName,
  description: `Runs the ${runner.name}`
}));

export async function createPendingExecution(workspace: Workspace, executorId: string, taskId?: string): Promise<string> {
  await ensureProjectmeshWorkspace(workspace);
  const runner = getRunner(executorId);

  // Ensure active task and packet exist (otherwise generate packet)
  let activePacketPath = '';
  try {
    const packet = await generateTaskPacket(workspace, taskId);
    activePacketPath = packet.filePath;
  } catch (error) {
    throw new Error(`Failed to initialize task packet for execution: ${error instanceof Error ? error.message : String(error)}`);
  }

  const relativePacketPath = path.relative(workspace.root, activePacketPath);
  
  // Resolve the command using the runner context
  let actualTaskId = taskId;
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

  const resolvedCommand = runner.buildCommand({
    objective,
    packetPath: relativePacketPath,
    workspaceRoot: workspace.root
  });

  const request: PendingExecutionRequest = {
    executorId,
    command: resolvedCommand,
    requestedAt: nowStamp(),
    taskId: actualTaskId
  };

  const pendingFilePath = '.projectmesh/tasks/pending-execution.json';
  await workspace.writeProjectmeshTextFile(pendingFilePath, JSON.stringify(request, null, 2));
  return workspace.resolveProjectmeshWritePath(pendingFilePath);
}

export async function writeExecutionState(workspace: Workspace, state: ExecutionState): Promise<string> {
  await ensureProjectmeshWorkspace(workspace);
  const filePath = '.projectmesh/tasks/execution-state.json';
  await workspace.writeProjectmeshTextFile(filePath, JSON.stringify(state, null, 2));
  return workspace.resolveProjectmeshWritePath(filePath);
}

export async function readExecutionState(workspace: Workspace): Promise<ExecutionState | null> {
  try {
    const content = await workspace.readTextFile('.projectmesh/tasks/execution-state.json');
    return JSON.parse(content) as ExecutionState;
  } catch {
    return null;
  }
}

export async function clearExecutionState(workspace: Workspace): Promise<void> {
  const filePath = workspace.resolveProjectmeshWritePath('.projectmesh/tasks/execution-state.json');
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(filePath);
  } catch {}
}

export async function getPendingExecution(workspace: Workspace): Promise<PendingExecutionRequest | null> {
  try {
    const content = await workspace.readTextFile('.projectmesh/tasks/pending-execution.json');
    return JSON.parse(content) as PendingExecutionRequest;
  } catch {
    return null;
  }
}

export async function clearPendingExecution(workspace: Workspace): Promise<void> {
  const filePath = workspace.resolveProjectmeshWritePath('.projectmesh/tasks/pending-execution.json');
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(filePath);
  } catch {}
}

export async function createExecutionReport(
  workspace: Workspace,
  input: {
    executorId: string;
    command: string;
    exitCode: number;
    durationMs: number;
    diffBeforeAfter: string;
  }
): Promise<string> {
  await ensureProjectmeshWorkspace(workspace);
  const timestamp = nowStamp().replace(/[:.]/g, '-');
  const filename = `execution-report-${timestamp}.md`;
  const relativePath = `.projectmesh/reviews/${filename}`;

  const status = input.exitCode === 0 ? 'SUCCESS' : 'FAILURE';
  const durationSec = (input.durationMs / 1000).toFixed(2);

  const markdown = [
    `# Execution Report: ${status}`,
    '',
    `- **Executor**: ${input.executorId}`,
    `- **Command**: \`${input.command}\``,
    `- **Exit Code**: ${input.exitCode}`,
    `- **Duration**: ${durationSec}s`,
    `- **Timestamp**: ${nowStamp()}`,
    '',
    '## Changes / Git Diff',
    '',
    input.diffBeforeAfter.trim()
      ? `\`\`\`diff\n${input.diffBeforeAfter.trim()}\n\`\`\``
      : '*No changes detected in the workspace.*',
    '',
  ].join('\n');

  return workspace.writeProjectmeshTextFile(relativePath, markdown);
}
