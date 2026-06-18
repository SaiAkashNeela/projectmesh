import { mkdtempSync } from 'node:fs';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolate platform home directory for tests to avoid modifying the user's global repos.json config
process.env.PROJECTMESH_HOME = mkdtempSync(path.join(os.tmpdir(), 'projectmesh-home-test-'));

import { describe, expect, test } from 'vitest';

import {
  createTask,
  createWorkspace,
  ensureProjectmeshWorkspace,
  createPendingExecution,
  getPendingExecution,
  clearPendingExecution,
  createExecutionReport,
  runCli,
  setActiveRepo,
  readExecutionState,
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

    // Request execution for 'custom' executor (Grok is one of the supported runners now)
    const pendingPath = await createPendingExecution(workspace, 'grok');
    expect(pendingPath).toContain(path.join('.projectmesh', 'tasks', 'pending-execution.json'));

    const pending = await getPendingExecution(workspace);
    expect(pending).not.toBeNull();
    expect(pending!.executorId).toBe('grok');
    expect(pending!.command).toBe('grok "Please implement the active task: \\"Run local command\\". Complete details are in .projectmesh/context/active-packet.md."');

    // Clear execution request
    await clearPendingExecution(workspace);
    const cleared = await getPendingExecution(workspace);
    expect(cleared).toBeNull();
  });

  test('fails pending execution request when no active task exists', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);

    await expect(createPendingExecution(workspace, 'grok')).rejects.toThrow(
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

  test('CLI defaults to Claude, tracks execution state, and supports agent switching', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);
    await setActiveRepo(root);

    // Create active task
    await createTask(workspace, {
      objective: 'Implement oauth flow',
      background: 'Need secure logins',
      requirements: ['Add oauth module'],
      affectedFiles: [],
      implementationPlan: [],
      acceptanceCriteria: [],
      risks: [],
      status: 'active',
    });

    // 1. Run execute with no args -> should default to Claude
    const outputDefault = await runCli(['execute', '-y']);
    expect(outputDefault).toContain('Status: completed');
    expect(outputDefault).toContain('Exit Code: 0');
    expect(outputDefault).toContain('execution-report-');

    const stateDefault = await readExecutionState(workspace);
    expect(stateDefault).not.toBeNull();
    expect(stateDefault!.executorId).toBe('claude');
    expect(stateDefault!.status).toBe('completed');
    expect(stateDefault!.command).toContain('claude');

    // 2. Run execute with gemini -> should switch to Gemini runner
    const outputGemini = await runCli(['execute', 'gemini', '-y']);
    expect(outputGemini).toContain('Status: completed');
    expect(outputGemini).toContain('Exit Code: 0');

    const stateGemini = await readExecutionState(workspace);
    expect(stateGemini).not.toBeNull();
    expect(stateGemini!.executorId).toBe('gemini');
    expect(stateGemini!.command).toContain('gemini');

    // 3. Run execute with invalid agent -> should throw error
    await expect(runCli(['execute', 'invalid_agent', '-y'])).rejects.toThrow(
      'Unsupported agent executor: invalid_agent'
    );
  });
});
