import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { AnalysisResult, ProjectContextResult, SearchCodeMatch } from './types.js';
import type { Workspace } from './workspace.js';

const PACKAGE_FILE_NAMES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

async function exists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(
  dirPath: string,
  options: { ignoreDirs?: Set<string>; includeHidden?: boolean } = {},
  output: string[] = [],
) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!options.includeHidden && entry.name.startsWith('.') && entry.name !== '.projectmesh') {
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (options.ignoreDirs?.has(entry.name)) {
        continue;
      }
      await walk(fullPath, options, output);
      continue;
    }
    output.push(fullPath);
  }
  return output;
}

function uniqueSorted(values: Iterable<string>) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function inferLanguage(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'TypeScript';
    case '.js':
    case '.jsx':
      return 'JavaScript';
    case '.py':
      return 'Python';
    case '.sql':
      return 'SQL';
    case '.md':
      return 'Markdown';
    case '.json':
      return 'JSON';
    default:
      return null;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const text = await readFile(filePath, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function detectPackageManager(allFiles: string[]) {
  if (allFiles.some((file) => file.endsWith('pnpm-lock.yaml'))) return 'pnpm';
  if (allFiles.some((file) => file.endsWith('yarn.lock'))) return 'yarn';
  if (allFiles.some((file) => file.endsWith('bun.lock') || file.endsWith('bun.lockb'))) return 'bun';
  return 'npm';
}

function addIf(condition: boolean, values: Set<string>, value: string) {
  if (condition) values.add(value);
}

export async function listFiles(workspace: Workspace, relativeDir = '.', limit = 500) {
  const root = workspace.resolveReadPath(relativeDir);
  const files = await walk(root, { ignoreDirs: new Set(['node_modules', 'dist', '.git']) });
  return files.slice(0, limit).map((file) => path.relative(workspace.root, file));
}

export async function searchCode(workspace: Workspace, query: string, limit = 50): Promise<SearchCodeMatch[]> {
  const files = await walk(workspace.root, { ignoreDirs: new Set(['node_modules', 'dist', '.git']) });
  const matches: SearchCodeMatch[] = [];
  const lowered = query.toLowerCase();
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!['.ts', '.tsx', '.js', '.jsx', '.py', '.md', '.json', '.sql', '.toml', '.yaml', '.yml'].includes(ext)) {
      continue;
    }
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (line.toLowerCase().includes(lowered) && matches.length < limit) {
        matches.push({
          file: path.relative(workspace.root, file),
          line: index + 1,
          text: line.trim(),
        });
      }
    });
    if (matches.length >= limit) break;
  }
  return matches;
}

export async function getProjectStructure(workspace: Workspace, maxDepth = 2) {
  const results: string[] = [];

  async function visit(current: string, depth: number) {
    if (depth > maxDepth) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      results.push(path.relative(workspace.root, fullPath) || '.');
      if (entry.isDirectory()) {
        await visit(fullPath, depth + 1);
      }
    }
  }

  await visit(workspace.root, 0);
  return results.sort((a, b) => a.localeCompare(b));
}

export async function analyzeRepository(workspace: Workspace): Promise<AnalysisResult> {
  const files = await walk(workspace.root, { ignoreDirs: new Set(['node_modules', 'dist', '.git']) });
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const databases = new Set<string>();
  const deployment = new Set<string>();
  const packageFiles: string[] = [];
  const majorServices = new Set<string>();
  const topLevelDirectories = await readdir(workspace.root, { withFileTypes: true });

  for (const file of files) {
    const language = inferLanguage(file);
    if (language) languages.add(language);

    if (file.endsWith('package.json')) {
      packageFiles.push(path.relative(workspace.root, file));
      const pkg = await readJsonFile<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(file);
      const deps = {
        ...(pkg?.dependencies ?? {}),
        ...(pkg?.devDependencies ?? {}),
      };
      addIf(Boolean(deps.react), frameworks, 'React');
      addIf(Boolean(deps.vite), frameworks, 'Vite');
      addIf(Boolean(deps.express), frameworks, 'Express');
      addIf(Boolean(deps.next), frameworks, 'Next.js');
      addIf(Boolean(deps['@prisma/client']) || Boolean(deps.prisma), frameworks, 'Prisma');
      addIf(Boolean(deps.redis) || Boolean(deps.ioredis), databases, 'Redis');
    }

    if (PACKAGE_FILE_NAMES.some((name) => file.endsWith(name))) {
      packageFiles.push(path.relative(workspace.root, file));
    }

    if (file.endsWith('schema.prisma')) {
      const text = await readFile(file, 'utf8');
      if (text.includes('postgresql')) databases.add('PostgreSQL');
      if (text.includes('mysql')) databases.add('MySQL');
      if (text.includes('sqlite')) databases.add('SQLite');
    }

    addIf(file.endsWith('docker-compose.yml') || file.endsWith('docker-compose.yaml'), deployment, 'Docker Compose');
    addIf(file.includes(`${path.sep}kubernetes${path.sep}`) || file.endsWith(`${path.sep}kubernetes`), deployment, 'Kubernetes');
    addIf(file.includes('.github/workflows'), deployment, 'GitHub Actions');
  }

  for (const entry of topLevelDirectories) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || ['node_modules', 'dist'].includes(entry.name)) continue;
    if (entry.name === 'kubernetes') {
      deployment.add('Kubernetes');
    }
    const packageJson = path.join(workspace.root, entry.name, 'package.json');
    if (await exists(packageJson)) {
      majorServices.add(entry.name);
    }
  }

  const folderStructureSummary = topLevelDirectories
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map((entry) => `${entry.name}/`);

  return {
    frameworks: uniqueSorted(frameworks),
    languages: uniqueSorted(languages),
    packageManager: detectPackageManager(files),
    databaseTechnologies: uniqueSorted(databases),
    deploymentTechnologies: uniqueSorted(deployment),
    majorServices: uniqueSorted(majorServices),
    folderStructureSummary,
    packageFiles: uniqueSorted(packageFiles),
  };
}

export async function getProjectContext(workspace: Workspace): Promise<ProjectContextResult> {
  const analysis = await analyzeRepository(workspace);
  const projectmeshFiles = await listFiles(workspace, '.projectmesh').catch(() => []);
  return {
    workspaceRoot: workspace.root,
    majorServices: analysis.majorServices,
    projectmeshFiles,
    packageFiles: analysis.packageFiles,
    analysis,
  };
}
