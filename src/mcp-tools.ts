import type { AnalysisResult } from './types.js';
import {
  completeTask,
  createReview,
  createTask,
  ensureProjectmeshWorkspace,
  updateArchitecture,
  updateArchitectureFromAnalysis,
  updateDecision,
  updateMemory,
} from './ai-workspace.js';
import { analyzeRepository, getProjectContext, getProjectStructure, listFiles, searchCode } from './repository-analysis.js';
import { createGitTools } from './git.js';
import type { Workspace } from './workspace.js';
import { verifyProjectmeshWritePermissions } from './workspace.js';

export function createPlatformApi(workspace: Workspace) {
  const git = createGitTools(workspace);

  return {
    async readFile(input: { path: string }) {
      return workspace.readTextFile(input.path);
    },
    async listFiles(input: { path?: string; limit?: number }) {
      return listFiles(workspace, input.path ?? '.', input.limit ?? 500);
    },
    async searchCode(input: { query: string; limit?: number }) {
      return searchCode(workspace, input.query, input.limit ?? 50);
    },
    async getProjectStructure(input: { maxDepth?: number } = {}) {
      return getProjectStructure(workspace, input.maxDepth ?? 2);
    },
    async getProjectContext() {
      return getProjectContext(workspace);
    },
    gitStatus() {
      return git.gitStatus();
    },
    gitDiff() {
      return git.gitDiff();
    },
    gitLog(input: { limit?: number } = {}) {
      return git.gitLog(input);
    },
    gitBranch() {
      return git.gitBranch();
    },
    async createTask(input: Parameters<typeof createTask>[1]) {
      await ensureProjectmeshWorkspace(workspace);
      return createTask(workspace, input);
    },
    async updateTask(input: Parameters<typeof createTask>[1]) {
      await ensureProjectmeshWorkspace(workspace);
      return createTask(workspace, input);
    },
    completeTask(input: Parameters<typeof completeTask>[1]) {
      return completeTask(workspace, input);
    },
    createReview(input: Parameters<typeof createReview>[1]) {
      return createReview(workspace, input);
    },
    async updateMemory(input: { content: string }) {
      return updateMemory(workspace, input.content);
    },
    async updateDecision(input: { content: string }) {
      return updateDecision(workspace, input.content);
    },
    async updateArchitecture(input: { content?: string; analysis?: AnalysisResult; append?: boolean }) {
      if (input.analysis) {
        return updateArchitectureFromAnalysis(workspace, input.analysis);
      }
      return updateArchitecture(workspace, input.content ?? '', { append: input.append });
    },
    verifyProjectmeshWritePermissions(input: { path: string }) {
      return verifyProjectmeshWritePermissions(workspace, input.path);
    },
    analyzeRepository() {
      return analyzeRepository(workspace);
    },
  };
}
