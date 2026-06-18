import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  analyzeRepository,
  createWorkspace,
  ensureProjectmeshWorkspace,
  getDefaultWorkspaceTarget,
  MCP_HTTP_PATH,
  MCP_HTTP_PORT,
  getPlatformHome,
  updateArchitectureFromAnalysis,
} from '../src/index.js';

async function createAnalyzedRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-analysis-'));
  await mkdir(path.join(root, 'server', 'prisma'), { recursive: true });
  await mkdir(path.join(root, 'ui', 'src'), { recursive: true });
  await mkdir(path.join(root, 'kubernetes'), { recursive: true });
  await writeFile(
    path.join(root, 'server', 'package.json'),
    JSON.stringify(
      {
        name: 'server',
        dependencies: {
          express: '^5.0.0',
          '@prisma/client': '^6.0.0',
          ioredis: '^5.0.0',
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(root, 'ui', 'package.json'),
    JSON.stringify(
      {
        name: 'ui',
        dependencies: {
          react: '^19.0.0',
          vite: '^8.0.0',
        },
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(root, 'docker-compose.yml'), 'services:\n  app:\n    image: node:20\n');
  await writeFile(path.join(root, 'server', 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" }\n');
  await writeFile(path.join(root, 'README.md'), '# Example repo\n');
  await writeFile(path.join(root, 'ui', 'src', 'app.tsx'), 'export function App() { return null; }\n');
  return root;
}

describe('repository analysis', () => {
  test('detects languages, frameworks, package manager, databases, deployment, and services', async () => {
    const root = await createAnalyzedRepo();
    const workspace = createWorkspace(root);

    const analysis = await analyzeRepository(workspace);

    expect(analysis.languages).toContain('TypeScript');
    expect(analysis.frameworks).toEqual(expect.arrayContaining(['Express', 'React', 'Vite', 'Prisma']));
    expect(analysis.packageManager).toBe('npm');
    expect(analysis.databaseTechnologies).toContain('PostgreSQL');
    expect(analysis.deploymentTechnologies).toEqual(
      expect.arrayContaining(['Docker Compose', 'Kubernetes']),
    );
    expect(analysis.majorServices).toEqual(expect.arrayContaining(['server', 'ui']));
  });

  test('renders architecture.md from the analysis result', async () => {
    const root = await createAnalyzedRepo();
    const workspace = createWorkspace(root);
    await ensureProjectmeshWorkspace(workspace);

    const analysis = await analyzeRepository(workspace);
    await updateArchitectureFromAnalysis(workspace, analysis);

    const architecture = await workspace.readTextFile('.projectmesh/architecture.md');
    expect(architecture).toContain('# Repository Architecture');
    expect(architecture).toContain('Detected Frameworks');
    expect(architecture).toContain('Folder Structure Summary');
  });

  test('exports the default HTTP MCP endpoint constants', async () => {
    expect(MCP_HTTP_PORT).toBe(3334);
    expect(MCP_HTTP_PATH).toBe('/mcp');
  });

  test('uses the projectmesh home directory name by default', async () => {
    const original = process.env.PROJECTMESH_HOME;
    delete process.env.PROJECTMESH_HOME;
    expect(getPlatformHome()).toContain('.projectmesh');
    process.env.PROJECTMESH_HOME = original;
  });

  test('defaults new-workspace targeting to the current working directory', async () => {
    expect(getDefaultWorkspaceTarget('/tmp/example-repo')).toBe('/tmp/example-repo');
  });
});
