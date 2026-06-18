import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  createTask,
  createWorkspace,
  ensureProjectmeshWorkspace,
  getNextTaskId,
  completeTask,
  generateTaskPacket,
  createPendingExecution,
  getPendingExecution,
  listAllTasks,
} from '../src/index.js';

async function createRepoFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'projectmesh-multi-task-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  return root;
}

describe('multi-task system functionality', () => {
  test('generates sequential task IDs correctly', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);

    // Initial ID should be task-001
    const id1 = await getNextTaskId(workspace);
    expect(id1).toBe('task-001');

    // Create task-001
    await createTask(workspace, {
      id: id1,
      objective: 'Task 1',
      background: 'BG 1',
      requirements: [],
      affectedFiles: [],
      implementationPlan: [],
      acceptanceCriteria: [],
      risks: [],
      status: 'active',
    });

    // Next ID should be task-002
    const id2 = await getNextTaskId(workspace);
    expect(id2).toBe('task-002');
  });

  test('creates new tasks without overwriting previous tasks', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);

    // Create task-001
    await createTask(workspace, {
      objective: 'Task 1',
      background: 'BG 1',
      requirements: [],
      affectedFiles: [],
      implementationPlan: [],
      acceptanceCriteria: [],
      risks: [],
      status: 'backlog',
    });

    // Create task-002
    await createTask(workspace, {
      objective: 'Task 2',
      background: 'BG 2',
      requirements: [],
      affectedFiles: [],
      implementationPlan: [],
      acceptanceCriteria: [],
      risks: [],
      status: 'backlog',
    });

    const tasks = await readdir(path.join(root, '.projectmesh', 'tasks'));
    expect(tasks).toContain('task-001.md');
    expect(tasks).toContain('task-002.md');

    const content1 = await readFile(path.join(root, '.projectmesh', 'tasks', 'task-001.md'), 'utf8');
    const content2 = await readFile(path.join(root, '.projectmesh', 'tasks', 'task-002.md'), 'utf8');
    expect(content1).toContain('Task 1');
    expect(content2).toContain('Task 2');
  });

  test('keeps active.md compatibility when writing active tasks', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);

    // Create active task
    await createTask(workspace, {
      objective: 'Task active compatibility',
      background: 'BG',
      requirements: [],
      affectedFiles: [],
      implementationPlan: [],
      acceptanceCriteria: [],
      risks: [],
      status: 'active',
    });

    const activeContent = await readFile(path.join(root, '.projectmesh', 'tasks', 'active.md'), 'utf8');
    expect(activeContent).toContain('Task active compatibility');
  });

  test('completes unique tasks and updates their status in place and archives them', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);

    await createTask(workspace, {
      id: 'task-001',
      objective: 'Task to complete',
      background: 'BG',
      requirements: [],
      affectedFiles: [],
      implementationPlan: [],
      acceptanceCriteria: [],
      risks: [],
      status: 'active',
    });

    // Complete task-001
    const archivedPath = await completeTask(workspace, {
      id: 'task-001',
      summary: 'Done and done',
      finalStatus: 'completed',
    });

    expect(archivedPath).toBeDefined();

    // Check status updated in task file
    const taskContent = await readFile(path.join(root, '.projectmesh', 'tasks', 'task-001.md'), 'utf8');
    expect(taskContent).toContain('completed');

    // Check active.md got cleared since it matched the completed active task
    const activeContent = await readFile(path.join(root, '.projectmesh', 'tasks', 'active.md'), 'utf8');
    expect(activeContent).toContain('No active task.');
  });

  test('generateTaskPacket and createPendingExecution target specific tasks correctly', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);

    await createTask(workspace, {
      id: 'task-005',
      objective: 'Targeted execution task',
      background: 'Testing target execution',
      requirements: [],
      affectedFiles: [],
      implementationPlan: [],
      acceptanceCriteria: [],
      risks: [],
      status: 'backlog',
    });

    // Generate task packet for task-005
    const packet = await generateTaskPacket(workspace, 'task-005');
    expect(packet.content).toContain('Targeted execution task');

    // Create execution request targeting task-005
    const pendingPath = await createPendingExecution(workspace, 'claude', 'task-005');
    expect(pendingPath).toContain('pending-execution.json');

    const pending = await getPendingExecution(workspace);
    expect(pending).not.toBeNull();
    expect(pending!.taskId).toBe('task-005');
    expect(pending!.command).toContain('Targeted execution task');
  });
});
