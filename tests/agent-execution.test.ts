import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  createTask,
  createWorkspace,
  ensureProjectmeshWorkspace,
  createPendingExecution,
  getPendingExecution,
  clearPendingExecution,
  createExecutionReport,
} from '../src/index.js';

async function createRepoFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'projectmesh-exec-test-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  return root;
}

describe('agent execution workflow', () => {
  test('creates, retrieves, and clears pending execution request', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);

    // Create an active task first (required for execution packet)
    await createTask(workspace, {
      objective: 'Run local command',
      background: 'Testing execution request',
      requirements: ['Mock execution'],
      affectedFiles: [],
      implementationPlan: [],
      acceptanceCriteria: [],
      risks: [],
      status: 'active',
    });

    // Request execution for 'custom' executor
    const pendingPath = await createPendingExecution(workspace, 'custom');
    expect(pendingPath).toContain(path.join('.projectmesh', 'tasks', 'pending-execution.json'));

    const pending = await getPendingExecution(workspace);
    expect(pending).not.toBeNull();
    expect(pending!.executorId).toBe('custom');
    expect(pending!.command).toBe('sh .projectmesh/execute.sh .projectmesh/context/active-packet.md');

    // Clear execution request
    await clearPendingExecution(workspace);
    const cleared = await getPendingExecution(workspace);
    expect(cleared).toBeNull();
  });

  test('fails pending execution request when no active task exists', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);

    await expect(createPendingExecution(workspace, 'custom')).rejects.toThrow(
      'No active task found in .projectmesh/tasks/active.md'
    );
  });

  test('successfully generates execution report review document', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);

    const reportPath = await createExecutionReport(workspace, {
      executorId: 'claude',
      command: 'claude .projectmesh/context/active-packet.md',
      exitCode: 0,
      durationMs: 4500,
      diffBeforeAfter: '--- a/src/cli.ts\n+++ b/src/cli.ts\n@@ -1,1 +1,2 @@\n+console.log("hello");\n',
    });

    expect(reportPath).toContain(path.join('.projectmesh', 'reviews', 'execution-report-'));

    const content = await readFile(reportPath, 'utf8');
    expect(content).toContain('# Execution Report: SUCCESS');
    expect(content).toContain('claude');
    expect(content).toContain('Exit Code**: 0');
    expect(content).toContain('Duration**: 4.50s');
    expect(content).toContain('console.log("hello");');
  });
});
