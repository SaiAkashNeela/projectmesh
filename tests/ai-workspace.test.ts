import { mkdtemp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  completeTask,
  createReview,
  createTask,
  createWorkspace,
  ensureProjectmeshWorkspace,
  updateArchitecture,
  updateDecision,
  updateMemory,
} from '../src/index.js';

async function createRepoFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-ai-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  return root;
}

describe('projectmesh workspace document flows', () => {
  test('creates the expected .projectmesh structure', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);

    await ensureProjectmeshWorkspace(workspace);

    const entries = await readdir(path.join(root, '.projectmesh'));
    expect(entries.sort()).toEqual([
      'architecture.md',
      'coding-style.md',
      'context',
      'decisions.md',
      'memory.md',
      'reviews',
      'tasks',
    ]);
  });

  test('writes the active task using the required format', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);

    await createTask(workspace, {
      objective: 'Add Stripe subscriptions',
      background: 'The app needs recurring billing.',
      requirements: ['Plan subscription entities', 'Keep source code untouched'],
      affectedFiles: ['server/billing.ts', 'ui/src/pages/Billing.tsx'],
      implementationPlan: ['Inspect billing architecture', 'Create task for Codex'],
      acceptanceCriteria: ['Task is clear enough for implementation'],
      risks: ['Billing edge cases'],
      status: 'active',
    });

    const task = await readFile(path.join(root, '.projectmesh', 'tasks', 'active.md'), 'utf8');
    expect(task).toContain('## Objective');
    expect(task).toContain('Add Stripe subscriptions');
    expect(task).toContain('## Status');
    expect(task).toContain('active');
  });

  test('completes the active task by archiving it into completed', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);
    await createTask(workspace, {
      objective: 'Ship task',
      background: 'Background',
      requirements: ['Requirement'],
      affectedFiles: ['.projectmesh/tasks/active.md'],
      implementationPlan: ['Do the work'],
      acceptanceCriteria: ['Archived'],
      risks: ['None'],
      status: 'active',
    });

    const archivedPath = await completeTask(workspace, {
      summary: 'Implemented by Codex',
      finalStatus: 'completed',
    });

    expect(await stat(archivedPath)).toBeTruthy();
  });

  test('appends reviews, memory, decisions, and architecture notes inside .projectmesh', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);

    const reviewPath = await createReview(workspace, {
      title: 'Security review',
      body: 'No source file writes detected.',
      kind: 'security',
    });
    await updateMemory(workspace, 'Remember to keep ChatGPT write access limited to `.projectmesh`.');
    await updateDecision(
      workspace,
      'Use a dedicated MCP permission layer that rejects writes outside `.projectmesh`.',
    );
    await updateArchitecture(workspace, 'Architecture note', { append: true });

    const review = await readFile(reviewPath, 'utf8');
    const memory = await readFile(path.join(root, '.projectmesh', 'memory.md'), 'utf8');
    const decisions = await readFile(path.join(root, '.projectmesh', 'decisions.md'), 'utf8');
    const architecture = await readFile(path.join(root, '.projectmesh', 'architecture.md'), 'utf8');

    expect(review).toContain('Security review');
    expect(memory).toContain('ChatGPT write access limited');
    expect(decisions).toContain('dedicated MCP permission layer');
    expect(architecture).toContain('Architecture note');
  });

  test('retries task creation on temporary failures and succeeds eventually', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);

    let writeCalls = 0;
    const originalWrite = workspace.writeProjectmeshTextFile;
    workspace.writeProjectmeshTextFile = async (relativePath, content) => {
      writeCalls++;
      if (writeCalls < 3) {
        throw new Error(`Write failed attempt ${writeCalls}`);
      }
      return originalWrite.call(workspace, relativePath, content);
    };

    const taskInput = {
      objective: 'Retry task success',
      background: 'Testing retry behavior',
      requirements: ['Req 1'],
      affectedFiles: [],
      implementationPlan: [],
      acceptanceCriteria: [],
      risks: [],
      status: 'active',
    };

    const pathCreated = await createTask(workspace, taskInput);
    expect(pathCreated).toContain('.projectmesh/tasks/active.md');
    expect(writeCalls).toBe(3);

    const content = await readFile(pathCreated, 'utf8');
    expect(content).toContain('Retry task success');
  });

  test('fails task creation after 3 failed attempts and reports errors', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);

    let writeCalls = 0;
    workspace.writeProjectmeshTextFile = async () => {
      writeCalls++;
      throw new Error(`Disk full error ${writeCalls}`);
    };

    const taskInput = {
      objective: 'Retry task failure',
      background: 'Testing failure retry behavior',
      requirements: ['Req 2'],
      affectedFiles: [],
      implementationPlan: [],
      acceptanceCriteria: [],
      risks: [],
      status: 'active',
    };

    await expect(createTask(workspace, taskInput)).rejects.toThrow(
      'Failed to create task after 3 attempts. The task was not sent. Last error: Disk full error 3'
    );
    expect(writeCalls).toBe(3);
  });

  test('retries task creation if verification fails', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);

    let readCalls = 0;
    const originalRead = workspace.readTextFile;
    workspace.readTextFile = async (relativePath) => {
      readCalls++;
      if (relativePath === '.projectmesh/tasks/active.md') {
        if (readCalls < 3) {
          return 'corrupted content';
        }
      }
      return originalRead.call(workspace, relativePath);
    };

    const taskInput = {
      objective: 'Verification retry task',
      background: 'Testing verification failure retry',
      requirements: ['Req 3'],
      affectedFiles: [],
      implementationPlan: [],
      acceptanceCriteria: [],
      risks: [],
      status: 'active',
    };

    const pathCreated = await createTask(workspace, taskInput);
    expect(pathCreated).toContain('.projectmesh/tasks/active.md');
    expect(readCalls).toBeGreaterThanOrEqual(3);

    const content = await readFile(pathCreated, 'utf8');
    expect(content).toContain('Verification retry task');
  });
});
