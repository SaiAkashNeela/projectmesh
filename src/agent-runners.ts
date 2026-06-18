import path from 'node:path';

export interface RunnerContext {
  objective: string;
  packetPath: string; // relative to workspace root
  workspaceRoot: string;
}

export abstract class AgentRunner {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly commandName: string;

  abstract buildCommand(context: RunnerContext): string;
}

export class ClaudeRunner extends AgentRunner {
  readonly id = 'claude';
  readonly name = 'Claude Code';
  readonly commandName = 'claude';

  buildCommand(context: RunnerContext): string {
    // Escape prompt string properly
    const prompt = `Please implement the active task: "${context.objective}". Complete details are in ${context.packetPath}.`;
    return `claude "${prompt.replace(/"/g, '\\"')}"`;
  }
}

export class CodexRunner extends AgentRunner {
  readonly id = 'codex';
  readonly name = 'Codex CLI';
  readonly commandName = 'codex';

  buildCommand(context: RunnerContext): string {
    return `codex-cli --task ${context.packetPath}`;
  }
}

export class OpenCodeRunner extends AgentRunner {
  readonly id = 'opencode';
  readonly name = 'OpenCode CLI';
  readonly commandName = 'opencode';

  buildCommand(context: RunnerContext): string {
    return `opencode "${context.packetPath}"`;
  }
}

export class GeminiRunner extends AgentRunner {
  readonly id = 'gemini';
  readonly name = 'Gemini CLI';
  readonly commandName = 'gemini';

  buildCommand(context: RunnerContext): string {
    const prompt = `Please implement the active task: "${context.objective}". Complete details are in ${context.packetPath}.`;
    return `gemini "${prompt.replace(/"/g, '\\"')}"`;
  }
}

export class GrokRunner extends AgentRunner {
  readonly id = 'grok';
  readonly name = 'Grok CLI';
  readonly commandName = 'grok';

  buildCommand(context: RunnerContext): string {
    const prompt = `Please implement the active task: "${context.objective}". Complete details are in ${context.packetPath}.`;
    return `grok "${prompt.replace(/"/g, '\\"')}"`;
  }
}

export const SUPPORTED_RUNNERS: AgentRunner[] = [
  new ClaudeRunner(),
  new CodexRunner(),
  new OpenCodeRunner(),
  new GeminiRunner(),
  new GrokRunner(),
];

export function getRunner(id: string): AgentRunner {
  const runner = SUPPORTED_RUNNERS.find((r) => r.id === id);
  if (!runner) {
    throw new Error(`Unsupported agent executor: ${id}`);
  }
  return runner;
}
