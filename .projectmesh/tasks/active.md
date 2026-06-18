# Active Task

## Objective
Replace single active.md task workflow with a multi-task system that supports multiple AI chats and agents without overwriting tasks.

## Background
ProjectMesh currently uses .projectmesh/tasks/active.md as the handoff point. This works for one task at a time but multiple architect chats could overwrite each other's work. The task system should support concurrent tasks while keeping the architect -> context packet -> executor workflow.

## Requirements
- Move from a single active.md model to unique task files.
- Create unique task IDs automatically (example: task-001, task-002).
- Determine the next task ID by checking existing tasks or maintaining a reliable index.
- Never overwrite existing tasks when creating a new task.
- Support active, completed, and future backlog task states.
- Keep backwards compatibility by handling existing active.md if needed.
- Keep all task data inside repo-local .projectmesh.

## Affected Files
- src/
- tests/
- README.md
- .projectmesh/tasks/

## Implementation Plan
- Inspect current task creation, MCP tools, and task packet generation flow.
- Design task ID generation logic.
- Add multi-task folder structure under .projectmesh/tasks.
- Implement task creation that generates the next available ID safely.
- Add migration/compatibility handling for existing active.md.
- Update execution flow so agents can select a specific task.
- Add tests for ID generation, duplicate prevention, migration, and execution selection.
- Update documentation.

## Acceptance Criteria
- Creating multiple tasks does not overwrite previous tasks.
- Task IDs are generated automatically and safely.
- Existing tasks remain accessible.
- Executor agents can target a specific task.
- Tests cover task creation and ID handling.
- README reflects the multi-task workflow.

## Risks
- Do not break existing ProjectMesh workflow.
- Avoid duplicate task IDs.
- Do not move state outside .projectmesh.
- Keep active.md compatibility if existing users rely on it.

## Status
completed
