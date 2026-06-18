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

export async function getPlatformApi(repoId?: string) {
  const session = sessionStore.getStore();
  const sessionId = session ? session.sessionId : 'default';

  let targetRepoId = repoId;
  const config = await readReposConfig();

  if (!targetRepoId) {
    targetRepoId = sessionWorkspaceMap.get(sessionId);
  }

  if (!targetRepoId) {
    const currentDir = path.resolve(process.cwd());
    const matchingRepo = config.repos.find((r) => path.resolve(r.root) === currentDir);
    if (matchingRepo) {
      targetRepoId = matchingRepo.id;
      sessionWorkspaceMap.set(sessionId, targetRepoId);
    } else {
      const activeRepo = await getActiveRepo();
      targetRepoId = activeRepo.id;
      sessionWorkspaceMap.set(sessionId, targetRepoId);
    }
  }

  const repo = config.repos.find(
    (r) => r.id === targetRepoId || r.name === targetRepoId || path.resolve(r.root) === (targetRepoId ? path.resolve(targetRepoId) : ''),
  );
  if (!repo) {
    throw new Error(`Workspace ${targetRepoId} is not registered.`);
  }

  // Hard guard safety check
  if (repoId && repo.id !== repoId && repo.name !== repoId && path.resolve(repo.root) !== path.resolve(repoId)) {
    throw new Error(`Workspace mismatch. Expected ${repoId}, resolved ${repo.id}`);
  }

  const workspace = createWorkspace(repo.root);
  return {
    api: createPlatformApi(workspace),
    workspace,
    repo,
  };
}

// Kept for backwards compatibility if needed, but tool handlers should call getPlatformApi directly.
export const api = new Proxy({} as any, {
  get(target, prop) {
    return async (...args: any[]) => {
      const { api: activeApi } = await getPlatformApi();
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
      description: 'Read a text file inside the target repository workspace.',
      inputSchema: z.object({
        path: z.string(),
        repoId: z.string().optional().describe("Optional target repository ID or path (e.g. 'projectmesh')."),
      }),
    },
    async ({ path: p, repoId }) => {
      const { api: activeApi } = await getPlatformApi(repoId);
      return { content: [{ type: 'text', text: await activeApi.readFile({ path: p }) }] };
    },
  );

  server.registerTool(
    'list_files',
    {
      description: 'List files within the target repository workspace.',
      inputSchema: z.object({
        path: z.string().optional(),
        limit: z.number().int().positive().optional(),
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ path: p, limit, repoId }) => {
      const { api: activeApi, repo } = await getPlatformApi(repoId);
      const files = await activeApi.listFiles({ path: p, limit });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                activeWorkspace: repo.id,
                root: repo.root,
                files,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'search_code',
    {
      description: 'Search repository code for a case-insensitive text query.',
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().positive().optional(),
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ query, limit, repoId }) => {
      const { api: activeApi, repo } = await getPlatformApi(repoId);
      const matches = await activeApi.searchCode({ query, limit });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                activeWorkspace: repo.id,
                root: repo.root,
                matches,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_project_structure',
    {
      description: 'Return a shallow project tree for the target workspace.',
      inputSchema: z.object({
        maxDepth: z.number().int().min(0).optional(),
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ maxDepth, repoId }) => {
      const { api: activeApi, repo } = await getPlatformApi(repoId);
      const structure = await activeApi.getProjectStructure({ maxDepth });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                activeWorkspace: repo.id,
                root: repo.root,
                structure,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_project_context',
    {
      description: 'Summarize repository context and analysis for the target workspace.',
      inputSchema: z.object({
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ repoId }) => {
      const { api: activeApi, repo } = await getPlatformApi(repoId);
      const context = await activeApi.getProjectContext();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                activeWorkspace: repo.id,
                root: repo.root,
                ...context,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'git_status',
    {
      description: 'Return `git status --short` for the target repository.',
      inputSchema: z.object({
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ repoId }) => {
      const { api: activeApi, repo } = await getPlatformApi(repoId);
      const status = await activeApi.gitStatus();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                activeWorkspace: repo.id,
                root: repo.root,
                status,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'git_diff',
    {
      description: 'Return `git diff` for the target repository.',
      inputSchema: z.object({
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ repoId }) => {
      const { api: activeApi, repo } = await getPlatformApi(repoId);
      const diff = await activeApi.gitDiff();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                activeWorkspace: repo.id,
                root: repo.root,
                diff,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'git_log',
    {
      description: 'Return recent git log entries for the target repository.',
      inputSchema: z.object({
        limit: z.number().int().positive().optional(),
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ limit, repoId }) => {
      const { api: activeApi, repo } = await getPlatformApi(repoId);
      const log = await activeApi.gitLog({ limit });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                activeWorkspace: repo.id,
                root: repo.root,
                log,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'git_branch',
    {
      description: 'Return the current branch and known local branches.',
      inputSchema: z.object({
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ repoId }) => {
      const { api: activeApi, repo } = await getPlatformApi(repoId);
      const branchInfo = await activeApi.gitBranch();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                activeWorkspace: repo.id,
                root: repo.root,
                ...branchInfo,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'git_command',
    {
      description: 'Run an arbitrary git command inside the target repository workspace. Dangerous operations (merge, rebase, force options) are restricted for security.',
      inputSchema: z.object({
        args: z.array(z.string()).describe("The arguments to pass to git, e.g. ['commit', '-m', 'message'], ['add', '.'], or ['checkout', '-b', 'branch']."),
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ args, repoId }) => {
      try {
        const { api: activeApi, repo } = await getPlatformApi(repoId);
        const result = await activeApi.runGitCommand({ args });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  activeWorkspace: repo.id,
                  root: repo.root,
                  ...result,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }
    },
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
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ repoId, ...taskData }) => {
      try {
        const { api: activeApi, repo } = await getPlatformApi(repoId);
        const message = await activeApi.createTask(taskData);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  activeWorkspace: repo.id,
                  root: repo.root,
                  message,
                },
                null,
                2,
              ),
            },
          ],
        };
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
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ repoId, ...taskData }) => {
      try {
        const { api: activeApi, repo } = await getPlatformApi(repoId);
        const message = await activeApi.updateTask(taskData);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  activeWorkspace: repo.id,
                  root: repo.root,
                  message,
                },
                null,
                2,
              ),
            },
          ],
        };
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
        finalStatus: z.string(),
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ repoId, ...completeData }) => {
      const { api: activeApi, repo } = await getPlatformApi(repoId);
      const message = await activeApi.completeTask(completeData);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                activeWorkspace: repo.id,
                root: repo.root,
                message,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_task_packet',
    {
      description: 'Generate and retrieve the self-contained task packet containing the task description, repo architecture, coding style, architectural decisions, and the content of all affected source files.',
      inputSchema: z.object({
        taskId: z.string().optional().describe('The ID of the task to generate packet for (e.g. task-001). If not provided, generates packet for default active task.'),
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ taskId, repoId }) => {
      const { api: activeApi, repo } = await getPlatformApi(repoId);
      const result = await activeApi.generateTaskPacket({ taskId });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                activeWorkspace: repo.id,
                root: repo.root,
                filePath: result.filePath,
                content: result.content,
              },
              null,
              2,
            ),
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
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ executorId, taskId, repoId }) => {
      const { api: activeApi, repo } = await getPlatformApi(repoId);
      const pendingPath = await activeApi.requestExecution({ executorId, taskId });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                activeWorkspace: repo.id,
                root: repo.root,
                message: `Execution request registered. For security, you must approve and run this command from your terminal: run 'projectmesh execute' to start it.`,
                pendingPath,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'create_review',
    {
      description: 'Create a review document under `.projectmesh/reviews/`.',
      inputSchema: z.object({
        title: z.string(),
        body: z.string(),
        kind: z.string(),
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ repoId, ...reviewData }) => {
      const { api: activeApi, repo } = await getPlatformApi(repoId);
      const message = await activeApi.createReview(reviewData);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                activeWorkspace: repo.id,
                root: repo.root,
                message,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'update_memory',
    {
      description: 'Append durable knowledge to `.projectmesh/memory.md`.',
      inputSchema: z.object({
        content: z.string(),
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ content, repoId }) => {
      const { api: activeApi, repo } = await getPlatformApi(repoId);
      const message = await activeApi.updateMemory({ content });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                activeWorkspace: repo.id,
                root: repo.root,
                message,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'update_decision',
    {
      description: 'Append an architectural decision to `.projectmesh/decisions.md`.',
      inputSchema: z.object({
        content: z.string(),
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ content, repoId }) => {
      const { api: activeApi, repo } = await getPlatformApi(repoId);
      const message = await activeApi.updateDecision({ content });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                activeWorkspace: repo.id,
                root: repo.root,
                message,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'update_architecture',
    {
      description: 'Update `.projectmesh/architecture.md` using direct content or fresh repository analysis.',
      inputSchema: z.object({
        content: z.string().optional(),
        append: z.boolean().optional(),
        regenerateFromAnalysis: z.boolean().optional(),
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ content, append, regenerateFromAnalysis, repoId }) => {
      const { api: activeApi, repo } = await getPlatformApi(repoId);
      if (regenerateFromAnalysis) {
        const analysis = await activeApi.analyzeRepository();
        const message = await activeApi.updateArchitecture({ analysis });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  activeWorkspace: repo.id,
                  root: repo.root,
                  message,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const message = await activeApi.updateArchitecture({ content, append });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                activeWorkspace: repo.id,
                root: repo.root,
                message,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'verify_projectmesh_write_permissions',
    {
      description: 'Check whether a path is writable under the `.projectmesh`-only security policy.',
      inputSchema: z.object({
        path: z.string(),
        repoId: z.string().optional().describe("Optional target repository ID or path."),
      }),
    },
    async ({ path: p, repoId }) => {
      const { api: activeApi, repo } = await getPlatformApi(repoId);
      const result = await activeApi.verifyProjectmeshWritePermissions({ path: p });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                activeWorkspace: repo.id,
                root: repo.root,
                ...result,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}

export async function startMcpServer() {
  const server = await buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
