# Active Task

## Objective
Add multi-repository workspace registry support so different AI chats can work with different ProjectMesh-enabled repos.

## Background
ProjectMesh currently operates around a single active workspace. For the multi-project AI architect workflow, users should be able to have multiple repositories registered and select the correct repo context per AI session without mixing project context.

## Requirements
- Create a global ProjectMesh repository registry (for example ~/.projectmesh/repos.json).
- Register repositories when ProjectMesh is initialized/setup.
- Store repository name, path, and relevant workspace metadata.
- Add MCP support to list available workspaces.
- Add MCP support to select/switch the workspace context for a session.
- Ensure selected workspace controls which .projectmesh files and tools are exposed.
- Prevent context leakage between different repositories.
- Keep existing single-workspace behaviour working for compatibility.

## Affected Files
- src/
- tests/
- README.md
- .projectmesh/

## Implementation Plan
- Inspect current workspace selection and MCP context handling.
- Design global repository registry storage.
- Implement repository registration and lookup.
- Add workspace listing MCP capability.
- Add session-scoped workspace selection.
- Ensure all existing task/context operations use the selected workspace.
- Add tests for multiple repos, switching, and isolation.
- Update documentation with multi-project workflow.

## Acceptance Criteria
- Multiple ProjectMesh repos can be registered.
- Different AI sessions can target different repositories.
- Selecting one repo does not expose another repo's context.
- Existing commands continue working.
- Tests verify repository isolation.
- Documentation explains the new workflow.

## Risks
- Do not make all registered repositories readable at once.
- Do not leak .projectmesh data between projects.
- Keep backwards compatibility.

## Status
completed
