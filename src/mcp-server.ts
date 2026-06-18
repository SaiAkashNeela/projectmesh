import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

import { getActiveRepo, readReposConfig } from './platform-config.js';
import { createPlatformApi } from './mcp-tools.js';
import { createWorkspace } from './workspace.js';

export const sessionStore = new AsyncLocalStorage<{ sessionId: string }>();
export const sessionWorkspaceMap = new Map<string, string>(); // sessionId -> repoId

export async function getSessionApi() {
  const session = sessionStore.getStore();
  const sessionId = session ? session.sessionId : 'default';

  let repoId = sessionWorkspaceMap.get(sessionId);
  const config = await readReposConfig();

  if (!repoId) {
    const currentDir = path.resolve(process.cwd());
    const matchingRepo = config.repos.find((r) => path.resolve(r.root) === currentDir);
    if (matchingRepo) {
      repoId = matchingRepo.id;
      sessionWorkspaceMap.set(sessionId, repoId);
    } else {
      const activeRepo = await getActiveRepo();
      repoId = activeRepo.id;
      sessionWorkspaceMap.set(sessionId, repoId);
    }
  }

  const repo = config.repos.find((r) => r.id === repoId);
  if (!repo) {
    throw new Error(`Workspace ${repoId} is not registered.`);
  }

  const workspace = createWorkspace(repo.root);
  return createPlatformApi(workspace);
}

export const api = new Proxy({} as any, {
  get(target, prop) {
    return async (...args: any[]) => {
      const activeApi = await getSessionApi();
      return (activeApi as any)[prop](...args);
    };
  }
});

export async function buildMcpServer() {
  const server = new McpServer({
    name: 'projectmesh',
    version: '0.1.0',
  });

  server.registerTool(
    'list_workspaces',
    {
      description: 'List all registered repositories/workspaces in the ProjectMesh registry. Indicates which workspace is active for the current session. Workspace selection is session-scoped.',
      inputSchema: z.object({}),
    },
    async () => {
      const config = await readReposConfig();
      const session = sessionStore.getStore();
      const sessionId = session ? session.sessionId : 'default';
      const activeId = sessionWorkspaceMap.get(sessionId) || config.activeRepoId;

      const workspaces = config.repos.map((repo) => ({
        id: repo.id,
        name: repo.name,
        root: repo.root,
        activeForCurrentSession: repo.id === activeId,
      }));

      return { content: [{ type: 'text', text: JSON.stringify(workspaces, null, 2) }] };
    },
  );

  server.registerTool(
    'switch_workspace',
    {
      description: 'Switch the active workspace context for the current session. This selection is session-isolated and does not affect other chat sessions/connections.',
      inputSchema: z.object({
        repoId: z.string().describe('The ID of the repository/workspace to switch to.'),
      }),
    },
    async ({ repoId }) => {
      const config = await readReposConfig();
      const repo = config.repos.find((r) => r.id === repoId);
      if (!repo) {
        return {
          content: [{ type: 'text', text: `Workspace with ID '${repoId}' is not registered.` }],
          isError: true,
        };
      }

      const session = sessionStore.getStore();
      const sessionId = session ? session.sessionId : 'default';
      sessionWorkspaceMap.set(sessionId, repoId);

      return {
        content: [{ type: 'text', text: `Successfully switched workspace context to ${repo.name} (${repo.root}) for this session.` }],
      };
    },
  );

  server.registerTool(
    'read_file',
    {
      description: 'Read a text file inside the active repository workspace.',
      inputSchema: z.object({ path: z.string() }),
    },
    async ({ path }) => ({ content: [{ type: 'text', text: await api.readFile({ path }) }] }),
  );

  server.registerTool(
    'list_files',
    {
      description: 'List files within the active repository workspace.',
      inputSchema: z.object({ path: z.string().optional(), limit: z.number().int().positive().optional() }),
    },
    async (input) => ({
      content: [{ type: 'text', text: JSON.stringify(await api.listFiles(input), null, 2) }],
    }),
  );

  server.registerTool(
    'search_code',
    {
      description: 'Search repository code for a case-insensitive text query.',
      inputSchema: z.object({ query: z.string(), limit: z.number().int().positive().optional() }),
    },
    async (input) => ({
      content: [{ type: 'text', text: JSON.stringify(await api.searchCode(input), null, 2) }],
    }),
  );

  server.registerTool(
    'get_project_structure',
    {
      description: 'Return a shallow project tree for the active workspace.',
      inputSchema: z.object({ maxDepth: z.number().int().min(0).optional() }),
    },
    async (input) => ({
      content: [{ type: 'text', text: JSON.stringify(await api.getProjectStructure(input), null, 2) }],
    }),
  );

  server.registerTool(
    'get_project_context',
    {
      description: 'Summarize repository context and analysis for the active workspace.',
      inputSchema: z.object({}),
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(await api.getProjectContext(), null, 2) }],
    }),
  );

  server.registerTool(
    'git_status',
    { description: 'Return `git status --short` for the active repository.', inputSchema: z.object({}) },
    async () => ({ content: [{ type: 'text', text: await api.gitStatus() }] }),
  );

  server.registerTool(
    'git_diff',
    { description: 'Return `git diff` for the active repository.', inputSchema: z.object({}) },
    async () => ({ content: [{ type: 'text', text: await api.gitDiff() }] }),
  );

  server.registerTool(
    'git_log',
    {
      description: 'Return recent git log entries for the active repository.',
      inputSchema: z.object({ limit: z.number().int().positive().optional() }),
    },
    async (input) => ({
      content: [{ type: 'text', text: JSON.stringify(await api.gitLog(input), null, 2) }],
    }),
  );

  server.registerTool(
    'git_branch',
    { description: 'Return the current branch and known local branches.', inputSchema: z.object({}) },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(await api.gitBranch(), null, 2) }] }),
  );

  server.registerTool(
    'create_task',
    {
      description: 'Create a new task under `.projectmesh/tasks/`.',
      inputSchema: z.object({
        id: z.string().optional().describe('Optional unique task ID (e.g. task-001). If not provided, one will be generated automatically.'),
        objective: z.string(),
        background: z.string(),
        requirements: z.array(z.string()),
        affectedFiles: z.array(z.string()),
        implementationPlan: z.array(z.string()),
        acceptanceCriteria: z.array(z.string()),
        risks: z.array(z.string()),
        status: z.string(),
      }),
    },
    async (input) => {
      try {
        const text = await api.createTask(input);
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'update_task',
    {
      description: 'Update a task under `.projectmesh/tasks/`.',
      inputSchema: z.object({
        id: z.string().optional().describe('The ID of the task to update (e.g. task-001). If not provided, updates the default active task.'),
        objective: z.string(),
        background: z.string(),
        requirements: z.array(z.string()),
        affectedFiles: z.array(z.string()),
        implementationPlan: z.array(z.string()),
        acceptanceCriteria: z.array(z.string()),
        risks: z.array(z.string()),
        status: z.string(),
      }),
    },
    async (input) => {
      try {
        const text = await api.updateTask(input);
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'complete_task',
    {
      description: 'Archive a task into `.projectmesh/tasks/completed/`.',
      inputSchema: z.object({
        id: z.string().optional().describe('The ID of the task to complete (e.g. task-001). If not provided, completes the default active task.'),
        summary: z.string(),
        finalStatus: z.string()
      }),
    },
    async (input) => ({ content: [{ type: 'text', text: await api.completeTask(input) }] }),
  );

  server.registerTool(
    'get_task_packet',
    {
      description: 'Generate and retrieve the self-contained task packet containing the task description, repo architecture, coding style, architectural decisions, and the content of all affected source files.',
      inputSchema: z.object({
        taskId: z.string().optional().describe('The ID of the task to generate packet for (e.g. task-001). If not provided, generates packet for default active task.')
      }),
    },
    async (input) => {
      const result = await api.generateTaskPacket(input);
      return {
        content: [
          {
            type: 'text',
            text: `Task Packet generated successfully at: ${result.filePath}\n\n${result.content}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'execute_task_agent',
    {
      description: 'Request execution of a task by a local agent (e.g., claude, gemini, codex, custom). This will register a pending execution request which you must review and approve in your terminal by running `projectmesh execute`.',
      inputSchema: z.object({
        executorId: z.string().describe("The ID of the executor agent (e.g. 'claude', 'gemini', 'codex', 'custom')"),
        taskId: z.string().optional().describe("The ID of the task to execute (e.g. 'task-001'). If not provided, it defaults to the active task."),
      }),
    },
    async ({ executorId, taskId }) => {
      const pendingPath = await api.requestExecution({ executorId, taskId });
      return {
        content: [
          {
            type: 'text',
            text: `Execution request registered. For security, you must approve and run this command from your terminal: run 'projectmesh execute' to start it.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'create_review',
    {
      description: 'Create a review document under `.projectmesh/reviews/`.',
      inputSchema: z.object({ title: z.string(), body: z.string(), kind: z.string() }),
    },
    async (input) => ({ content: [{ type: 'text', text: await api.createReview(input) }] }),
  );

  server.registerTool(
    'update_memory',
    {
      description: 'Append durable knowledge to `.projectmesh/memory.md`.',
      inputSchema: z.object({ content: z.string() }),
    },
    async (input) => ({ content: [{ type: 'text', text: await api.updateMemory(input) }] }),
  );

  server.registerTool(
    'update_decision',
    {
      description: 'Append an architectural decision to `.projectmesh/decisions.md`.',
      inputSchema: z.object({ content: z.string() }),
    },
    async (input) => ({ content: [{ type: 'text', text: await api.updateDecision(input) }] }),
  );

  server.registerTool(
    'update_architecture',
    {
      description: 'Update `.projectmesh/architecture.md` using direct content or fresh repository analysis.',
      inputSchema: z.object({
        content: z.string().optional(),
        append: z.boolean().optional(),
        regenerateFromAnalysis: z.boolean().optional(),
      }),
    },
    async (input) => {
      if (input.regenerateFromAnalysis) {
        const analysis = await api.analyzeRepository();
        return { content: [{ type: 'text', text: await api.updateArchitecture({ analysis }) }] };
      }
      return { content: [{ type: 'text', text: await api.updateArchitecture(input) }] };
    },
  );

  server.registerTool(
    'verify_projectmesh_write_permissions',
    {
      description: 'Check whether a path is writable under the `.projectmesh`-only security policy.',
      inputSchema: z.object({ path: z.string() }),
    },
    async (input) => ({
      content: [{ type: 'text', text: JSON.stringify(await api.verifyProjectmeshWritePermissions(input), null, 2) }],
    }),
  );

  return server;
}

export async function startMcpServer() {
  const server = await buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
