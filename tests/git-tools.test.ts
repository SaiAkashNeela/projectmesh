import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, test } from 'vitest';

import { createGitTools, createWorkspace } from '../src/index.js';

const execFileAsync = promisify(execFile);

async function createGitRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-git-'));
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'codex@example.com'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Codex'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Repo\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Repo\nupdated\n');
  return root;
}

describe('git tools', () => {
  test('reads branch, status, diff, and log without shell access', async () => {
    const root = await createGitRepo();
    const workspace = createWorkspace(root);
    const git = createGitTools(workspace);

    const branch = await git.gitBranch();
    const status = await git.gitStatus();
    const diff = await git.gitDiff();
    const log = await git.gitLog({ limit: 1 });

    expect(branch.current).toBeTruthy();
    expect(status).toContain('README.md');
    expect(diff).toContain('+updated');
    expect(log[0]?.message).toBe('init');
  });
});
