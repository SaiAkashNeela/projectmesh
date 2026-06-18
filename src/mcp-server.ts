import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

import { getActiveRepo } from './platform-config.js';
import { createPlatformApi } from './mcp-tools.js';
import { createWorkspace } from './workspace.js';

export async function buildMcpServer() {
  const activeRepo = await getActiveRepo();
  const workspace = createWorkspace(activeRepo.root);
  const api = createPlatformApi(workspace);
  const server = new McpServer({
    name: 'projectmesh',
    version: '0.1.0',
  });

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
      description: 'Create or replace `.projectmesh/tasks/active.md` for the active repository.',
      inputSchema: z.object({
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
    async (input) => ({ content: [{ type: 'text', text: await api.createTask(input) }] }),
  );

  server.registerTool(
    'update_task',
    {
      description: 'Update `.projectmesh/tasks/active.md` for the active repository.',
      inputSchema: z.object({
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
    async (input) => ({ content: [{ type: 'text', text: await api.updateTask(input) }] }),
  );

  server.registerTool(
    'complete_task',
    {
      description: 'Archive the active task into `.projectmesh/tasks/completed/`.',
      inputSchema: z.object({ summary: z.string(), finalStatus: z.string() }),
    },
    async (input) => ({ content: [{ type: 'text', text: await api.completeTask(input) }] }),
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
      content: [{ type: 'text', text: JSON.stringify(api.verifyProjectmeshWritePermissions(input), null, 2) }],
    }),
  );

  return server;
}

export async function startMcpServer() {
  const server = await buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
