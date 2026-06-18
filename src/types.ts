export interface RepoRegistration {
  id: string;
  name: string;
  root: string;
  addedAt: string;
  lastUsedAt: string;
}

export interface ReposConfig {
  activeRepoId: string | null;
  repos: RepoRegistration[];
}

export interface TaskInput {
  objective: string;
  background: string;
  requirements: string[];
  affectedFiles: string[];
  implementationPlan: string[];
  acceptanceCriteria: string[];
  risks: string[];
  status: string;
}

export interface CompleteTaskInput {
  summary: string;
  finalStatus: string;
}

export interface ReviewInput {
  title: string;
  body: string;
  kind: string;
}

export interface AnalysisResult {
  frameworks: string[];
  languages: string[];
  packageManager: string;
  databaseTechnologies: string[];
  deploymentTechnologies: string[];
  majorServices: string[];
  folderStructureSummary: string[];
  packageFiles: string[];
}

export interface GitLogEntry {
  sha: string;
  author: string;
  date: string;
  message: string;
}

export interface SearchCodeMatch {
  file: string;
  line: number;
  text: string;
}

export interface ProjectContextResult {
  workspaceRoot: string;
  majorServices: string[];
  projectmeshFiles: string[];
  packageFiles: string[];
  analysis: AnalysisResult;
}

export interface AgentExecutor {
  id: string;
  name: string;
  command: string;
  description: string;
}

export interface PendingExecutionRequest {
  executorId: string;
  command: string;
  requestedAt: string;
}

export interface ExecutionState {
  executorId: string;
  command: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
}
