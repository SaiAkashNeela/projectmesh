import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PlatformConfigError } from './errors.js';
import type { RepoRegistration, ReposConfig } from './types.js';

export function getPlatformHome() {
  const override = process.env.PROJECTMESH_HOME ?? process.env.AI_PLATFORM_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), '.projectmesh');
}

export function getReposFilePath() {
  return path.join(getPlatformHome(), 'repos.json');
}

const EMPTY_CONFIG: ReposConfig = {
  activeRepoId: null,
  repos: [],
};

export async function ensurePlatformDirectories() {
  const root = getPlatformHome();
  const dirs = ['mcp-server', 'configs', 'logs', 'cache', 'run'];
  await mkdir(root, { recursive: true });
  for (const dir of dirs) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
}

export async function readReposConfig(): Promise<ReposConfig> {
  await ensurePlatformDirectories();
  const filePath = getReposFilePath();
  try {
    const text = await readFile(filePath, 'utf8');
    return JSON.parse(text) as ReposConfig;
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

export async function writeReposConfig(config: ReposConfig) {
  await ensurePlatformDirectories();
  await writeFile(getReposFilePath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export async function setActiveRepo(root: string, name?: string) {
  const config = await readReposConfig();
  const resolvedRoot = path.resolve(root);
  const repoName = name ?? path.basename(resolvedRoot);
  const existing = config.repos.find((repo) => repo.root === resolvedRoot);
  const now = new Date().toISOString();
  const registration: RepoRegistration =
    existing ?? {
      id: repoName,
      name: repoName,
      root: resolvedRoot,
      addedAt: now,
      lastUsedAt: now,
    };

  registration.lastUsedAt = now;

  const repos = existing
    ? config.repos.map((repo) => (repo.root === resolvedRoot ? registration : repo))
    : [...config.repos, registration];

  await writeReposConfig({
    activeRepoId: registration.id,
    repos,
  });

  return registration;
}

export async function getActiveRepo() {
  const config = await readReposConfig();
  const currentDir = path.resolve(process.cwd());
  const matchingRepo = config.repos.find((entry) => path.resolve(entry.root) === currentDir);
  if (matchingRepo) {
    return matchingRepo;
  }

  if (!config.activeRepoId) {
    throw new PlatformConfigError('No active workspace selected. Run `projectmesh use <path>` first.');
  }
  const repo = config.repos.find((entry) => entry.id === config.activeRepoId);
  if (!repo) {
    throw new PlatformConfigError(`Active repo ${config.activeRepoId} is not registered.`);
  }
  return repo;
}
