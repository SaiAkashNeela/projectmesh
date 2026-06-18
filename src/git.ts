import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { GitLogEntry } from './types.js';
import type { Workspace } from './workspace.js';

const execFileAsync = promisify(execFile);

async function runGit(workspace: Workspace, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd: workspace.root });
  return stdout.trim();
}

export function createGitTools(workspace: Workspace) {
  return {
    async gitStatus() {
      return runGit(workspace, ['status', '--short']);
    },
    async gitDiff() {
      return runGit(workspace, ['diff']);
    },
    async gitBranch() {
      const current = await runGit(workspace, ['branch', '--show-current']);
      const all = await runGit(workspace, ['branch', '--format=%(refname:short)']);
      return {
        current,
        branches: all ? all.split('\n').filter(Boolean) : [],
      };
    },
    async gitLog(options: { limit?: number } = {}): Promise<GitLogEntry[]> {
      const limit = String(options.limit ?? 10);
      const output = await runGit(workspace, [
        'log',
        `--max-count=${limit}`,
        '--pretty=format:%H%x1f%an%x1f%aI%x1f%s',
      ]);
      if (!output) return [];
      return output.split('\n').map((line) => {
        const [sha, author, date, message] = line.split('\x1f');
        return { sha, author, date, message };
      });
    },
  };
}
