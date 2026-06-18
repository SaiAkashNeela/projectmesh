import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  WorkspaceAccessError,
  createWorkspace,
  verifyProjectmeshWritePermissions,
} from '../src/index.js';

async function createRepoFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-workspace-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, '.projectmesh'), { recursive: true });
  await writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 1;\n');
  await writeFile(path.join(root, '.projectmesh', 'memory.md'), '# Memory\n');
  return root;
}

describe('workspace security', () => {
  test('allows reading inside the workspace', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);

    const text = await workspace.readTextFile('src/index.ts');

    expect(text).toContain('value = 1');
  });

  test('blocks reading outside the workspace root', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);

    await expect(workspace.readTextFile('../outside.txt')).rejects.toBeInstanceOf(
      WorkspaceAccessError,
    );
  });

  test('allows writes only inside the .projectmesh directory', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);

    expect(verifyProjectmeshWritePermissions(workspace, '.projectmesh/tasks/active.md').allowed).toBe(true);
    expect(verifyProjectmeshWritePermissions(workspace, 'src/index.ts').allowed).toBe(false);
  });

  test('blocks writes outside .projectmesh even when the path stays in the repo', async () => {
    const root = await createRepoFixture();
    const workspace = createWorkspace(root);

    await expect(workspace.writeProjectmeshTextFile('src/unsafe.md', 'nope')).rejects.toBeInstanceOf(
      WorkspaceAccessError,
    );
  });
});
