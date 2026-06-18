import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  createTask,
  createWorkspace,
  ensureProjectmeshWorkspace,
  generateTaskPacket,
  updateArchitecture,
  updateDecision,
} from '../src/index.js';

async function createRepoFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'projectmesh-test-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  return root;
}

describe('task packet generation', () => {
  test('fails if there is no active task', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);

    await expect(generateTaskPacket(workspace)).rejects.toThrow(
      'No active task found in .projectmesh/tasks/active.md'
    );
  });

  test('successfully generates a task packet with correct content and embedded file context', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);

    // Write some dummy file contents
    const existingFilePath = path.join(root, 'src', 'utils.ts');
    await writeFile(existingFilePath, 'export function add(a: number, b: number) { return a + b; }', 'utf8');

    // Add some architecture and decision notes
    await updateArchitecture(workspace, 'Special Project Architecture Details');
    await updateDecision(workspace, 'Use functional programming design pattern');

    // Create active task
    await createTask(workspace, {
      objective: 'Refactor math utils',
      background: 'Old math implementation has bugs.',
      requirements: ['Add tests', 'Refactor utils.ts'],
      affectedFiles: ['src/utils.ts', 'src/new-utils.ts'],
      implementationPlan: ['Read src/utils.ts', 'Write refactored functions'],
      acceptanceCriteria: ['All tests pass'],
      risks: ['None'],
      status: 'active',
    });

    // Generate the packet
    const result = await generateTaskPacket(workspace);
    expect(result.filePath).toContain(path.join('.projectmesh', 'context', 'active-packet.md'));

    const packetContent = await readFile(result.filePath, 'utf8');

    // Verify task details are present
    expect(packetContent).toContain('# TASK PACKET: Refactor math utils');
    expect(packetContent).toContain('Refactor math utils');
    expect(packetContent).toContain('Old math implementation has bugs.');

    // Verify architecture & decisions are present
    expect(packetContent).toContain('Special Project Architecture Details');
    expect(packetContent).toContain('Use functional programming design pattern');

    // Verify file context for existing file
    expect(packetContent).toContain('### File: `src/utils.ts`');
    expect(packetContent).toContain('export function add(a: number, b: number)');

    // Verify file context for non-existing file
    expect(packetContent).toContain('### File: `src/new-utils.ts`');
    expect(packetContent).toContain('File does not exist yet');
  });
});
