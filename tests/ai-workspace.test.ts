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
});
