# Active Task

## Objective
Transform ProjectMesh into an AI engineering orchestration layer with architect-to-executor task handoff workflow.

## Background
ProjectMesh should not be positioned as only an AI memory system. The goal is to enable ChatGPT (architect) to plan, create structured engineering tasks, and have Codex (executor) implement with minimal repeated context reading. The shared .projectmesh workspace becomes the collaboration layer between AI agents.

## Requirements
- Add a clear Task Packet concept for executor handoff.
- Create an Architect Mode and Executor Mode workflow separation where possible.
- Generate focused context packets containing objective, relevant architecture, decisions, affected files, constraints, and acceptance criteria.
- Improve review loop support so implementation can be reviewed and tracked.
- Preserve the repo-native .projectmesh approach.
- Avoid turning the project into a generic vector memory system; focus on structured engineering context and workflow.

## Affected Files
- .projectmesh/tasks
- src
- README.md
- tests

## Implementation Plan
- Inspect current task, workspace, MCP, and CLI architecture.
- Design the smallest clean abstraction for architect-generated task packets.
- Implement executor-facing task/context generation.
- Add or improve review workflow integration.
- Add tests for new workflow behaviour.
- Update documentation and examples showing ChatGPT architect -> Codex executor flow.

## Acceptance Criteria
- A developer can create a structured implementation task from an architect workflow.
- An executor agent can consume the task without needing unnecessary repo-wide context discovery.
- ProjectMesh clearly communicates the architect/executor workflow.
- Tests cover the new functionality.
- README explains the new AI collaboration workflow.

## Risks
- Avoid overengineering with unnecessary AI memory features.
- Do not break existing MCP/task functionality.
- Keep backwards compatibility where possible.

## Status
active
