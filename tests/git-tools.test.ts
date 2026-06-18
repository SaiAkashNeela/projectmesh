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

  test('runGitCommand executes valid commands and rejects restricted commands', async () => {
    const root = await createGitRepo();
    const workspace = createWorkspace(root);
    const git = createGitTools(workspace);

    // 1. Valid command execution
    const statusResult = await git.runGitCommand(['status', '--short']);
    expect(statusResult.stdout).toContain('README.md');

    // 2. Forbidden subcommands (merge, rebase)
    await expect(git.runGitCommand(['merge', 'main'])).rejects.toThrow('restricted');
    await expect(git.runGitCommand(['rebase', 'main'])).rejects.toThrow('restricted');

    // 3. Forbidden flags (force options)
    await expect(git.runGitCommand(['push', 'origin', 'main', '--force'])).rejects.toThrow('Force flags');
    await expect(git.runGitCommand(['push', 'origin', 'main', '-f'])).rejects.toThrow('Force flags');
    await expect(git.runGitCommand(['push', 'origin', 'main', '--force-with-lease'])).rejects.toThrow('Force flags');

    // 4. Valid commands containing forbidden words as arguments (e.g. commit message or branch checkout)
    await git.runGitCommand(['add', 'README.md']);
    const commitResult = await git.runGitCommand(['commit', '-m', 'fix merge and rebase bugs']);
    expect(commitResult.exitCode).toBeUndefined(); // should run successfully
  });
});
