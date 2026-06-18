import { mkdtempSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolate platform home directory for tests to avoid modifying user's global repos.json config
process.env.PROJECTMESH_HOME = mkdtempSync(path.join(os.tmpdir(), 'projectmesh-registry-test-'));

import { describe, expect, test } from 'vitest';
import {
  buildMcpServer,
  sessionStore,
  sessionWorkspaceMap,
} from '../src/mcp-server.js';
import { setActiveRepo } from '../src/platform-config.js';
import { ensureProjectmeshWorkspace, createWorkspace, runCli } from '../src/index.js';

async function createRepoFixture(name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `projectmesh-reg-test-${name}-`));
  const workspace = createWorkspace(root);
  await ensureProjectmeshWorkspace(workspace);
  // Write a distinct file in each repository to verify context isolation
  await workspace.writeProjectmeshTextFile('.projectmesh/tasks/active.md', `# Active Task\n\nObjective: Hello from ${name}\n\n## Status\nactive\n`);
  return root;
}

describe('multi-repository workspace registry and session isolation', () => {
  test('lists workspaces and switches workspace context with strict session isolation', async () => {
    const root1 = await createRepoFixture('repo-one');
    const root2 = await createRepoFixture('repo-two');

    // Register both repositories
    const reg1 = await setActiveRepo(root1, 'repo-one');
    const reg2 = await setActiveRepo(root2, 'repo-two');

    // Build the MCP server instance
    const server = await buildMcpServer();

    const callTool = async (name: string, input: any) => {
      const tool = (server as any)._registeredTools[name];
      return tool.handler(input);
    };

    // 1. Verify list_workspaces tool output
    const listResult = await callTool('list_workspaces', {});
    const workspaces = JSON.parse(listResult.content[0].text);
    expect(workspaces.length).toBeGreaterThanOrEqual(2);
    
    const w1 = workspaces.find((w: any) => w.id === 'repo-one');
    const w2 = workspaces.find((w: any) => w.id === 'repo-two');
    expect(w1).toBeDefined();
    expect(w2).toBeDefined();
    expect(w1.root).toBe(root1);
    expect(w2.root).toBe(root2);

    // 2. Test session isolation: Session A switches to repo-two, Session B remains on repo-one
    // First, let's set the global default in the map to repo-one
    sessionWorkspaceMap.set('session-a', 'repo-one');
    sessionWorkspaceMap.set('session-b', 'repo-one');

    // Session A switches to repo-two
    await sessionStore.run({ sessionId: 'session-a' }, async () => {
      const switchResult = await callTool('switch_workspace', { repoId: 'repo-two' });
      expect(switchResult.content[0].text).toContain('Successfully switched workspace context to repo-two');
    });

    // Verify Session A reads from repo-two
    await sessionStore.run({ sessionId: 'session-a' }, async () => {
      const taskResult = await callTool('read_file', { path: '.projectmesh/tasks/active.md' });
      expect(taskResult.content[0].text).toContain('Hello from repo-two');
    });

    // Verify Session B still reads from repo-one (isolated)
    await sessionStore.run({ sessionId: 'session-b' }, async () => {
      const taskResult = await callTool('read_file', { path: '.projectmesh/tasks/active.md' });
      expect(taskResult.content[0].text).toContain('Hello from repo-one');
    });
  });

  test('CLI use and new commands auto-initialize workspaces if they do not exist', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'projectmesh-cli-test-'));
    
    // Call runCli with 'use' on uninitialized path -> should initialize it
    const output = await runCli(['use', root]);
    expect(output).toContain('Initialized Projectmesh workspace');
    
    // Call runCli with 'new' on already initialized path -> should just report active root (not re-initialize)
    const output2 = await runCli(['new', root]);
    expect(output2).toBe(`Workspace: ${path.resolve(root)}`);
  });
});
