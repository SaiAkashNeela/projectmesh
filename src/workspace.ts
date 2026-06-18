import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { WorkspaceAccessError } from './errors.js';

function normalizeInside(base: string, target: string) {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class Workspace {
  readonly root: string;
  readonly projectmeshDir: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.projectmeshDir = path.join(this.root, '.projectmesh');
  }

  private resolveWithinRoot(relativePath: string) {
    const target = path.resolve(this.root, relativePath);
    if (!normalizeInside(this.root, target)) {
      throw new WorkspaceAccessError(`Path escapes workspace root: ${relativePath}`);
    }
    return target;
  }

  private async canonicalizeExistingPath(target: string) {
    return realpath(target);
  }

  private async findExistingAncestor(target: string) {
    let current = target;
    while (true) {
      try {
        await stat(current);
        return realpath(current);
      } catch {
        const parent = path.dirname(current);
        if (parent === current) {
          return realpath(this.root);
        }
        current = parent;
      }
    }
  }

  resolveReadPath(relativePath: string) {
    return this.resolveWithinRoot(relativePath);
  }

  resolveProjectmeshWritePath(relativePath: string) {
    const target = this.resolveWithinRoot(relativePath);
    if (!normalizeInside(this.projectmeshDir, target)) {
      throw new WorkspaceAccessError(`Write access is restricted to .projectmesh: ${relativePath}`);
    }
    return target;
  }

  async readTextFile(relativePath: string) {
    const filePath = this.resolveReadPath(relativePath);
    const canonicalTarget = await this.canonicalizeExistingPath(filePath);
    const canonicalRoot = await this.canonicalRoot();
    if (!normalizeInside(canonicalRoot, canonicalTarget)) {
      throw new WorkspaceAccessError(`Resolved file escapes workspace root: ${relativePath}`);
    }
    return readFile(filePath, 'utf8');
  }

  async writeProjectmeshTextFile(relativePath: string, content: string) {
    const filePath = this.resolveProjectmeshWritePath(relativePath);
    const canonicalRoot = await this.canonicalRoot();
    const canonicalProjectmeshDir = await this.findExistingAncestor(this.projectmeshDir);
    const canonicalParent = await this.findExistingAncestor(path.dirname(filePath));
    if (
      !normalizeInside(canonicalRoot, canonicalParent) ||
      !normalizeInside(canonicalProjectmeshDir, canonicalParent)
    ) {
      throw new WorkspaceAccessError(`Resolved write path escapes .projectmesh directory: ${relativePath}`);
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
    return filePath;
  }

  async canonicalRoot() {
    return realpath(this.root);
  }
}

export function createWorkspace(root: string) {
  return new Workspace(root);
}

export function verifyProjectmeshWritePermissions(workspace: Workspace, relativePath: string) {
  try {
    const resolved = workspace.resolveProjectmeshWritePath(relativePath);
    return { allowed: true, resolvedPath: resolved, reason: 'Path is inside .projectmesh' };
  } catch (error) {
    return {
      allowed: false,
      resolvedPath: null,
      reason: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
