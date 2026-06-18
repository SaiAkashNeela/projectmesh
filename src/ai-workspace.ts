import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { AnalysisResult, CompleteTaskInput, ReviewInput, TaskInput } from './types.js';
import type { Workspace } from './workspace.js';

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

export async function createTask(workspace: Workspace, input: TaskInput) {
  await ensureProjectmeshWorkspace(workspace);
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

  return workspace.writeProjectmeshTextFile('.projectmesh/tasks/active.md', markdown);
}

export async function completeTask(workspace: Workspace, input: CompleteTaskInput) {
  await ensureProjectmeshWorkspace(workspace);
  const activeRelative = '.projectmesh/tasks/active.md';
  const current = await workspace.readTextFile(activeRelative);
  const archivedName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${slugify(input.summary)}.md`;
  const archivedRelative = `.projectmesh/tasks/completed/${archivedName}`;
  const archivedAbsolute = workspace.resolveProjectmeshWritePath(archivedRelative);
  const archivedText = `${current}\n## Completion Summary\n${input.summary}\n\n## Final Status\n${input.finalStatus}\n`;
  await workspace.writeProjectmeshTextFile(archivedRelative, archivedText);
  await workspace.writeProjectmeshTextFile(
    activeRelative,
    '# Active Task\n\nNo active task. The previous task was archived in `.projectmesh/tasks/completed/`.\n',
  );
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

export async function generateTaskPacket(workspace: Workspace) {
  await ensureProjectmeshWorkspace(workspace);
  let activeTaskContent = '';
  try {
    activeTaskContent = await workspace.readTextFile('.projectmesh/tasks/active.md');
  } catch {
    throw new Error('No active task found in .projectmesh/tasks/active.md. Cannot generate a task packet.');
  }
  
  if (activeTaskContent.includes('No active task.')) {
    throw new Error('No active task found in .projectmesh/tasks/active.md. Cannot generate a task packet.');
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
