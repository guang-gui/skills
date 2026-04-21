---
name: yapi-sync-controller
description: Use this skill when the user wants to sync a single Spring MVC controller to YApi by reading Java source code instead of swagger.json. This skill locates a controller by file path or class name, parses routes, Swagger annotations, request and response DTOs, and creates or updates interfaces in YApi grouped by controller.
---

# YApi Sync Controller

Use this skill when the user wants Codex to push a specific Java controller into YApi on demand.

This skill is designed for the current multi-module Java workspace, with the first target being `dc-site-admin`. It does not rely on a running `/v2/api-docs` endpoint. It reads source code and syncs methods one by one through YApi OpenAPI.

## Quick Start

1. Resolve the target controller.
   Accept either a Java file path or a class name/FQCN.
2. Load the local YApi config from `config/yapi.json`.
3. Run the sync script:

```powershell
node scripts/yapi_sync_controller.js --workspace D:\xls-code --controller dc-site-admin\src\main\java\com\central\admin\controller\b2c\B2cDeliveryController.java
```

Use `--dry-run` when validating parsing output without calling YApi:

```powershell
node scripts/yapi_sync_controller.js --workspace D:\xls-code --controller B2cDeliveryController --dry-run
```

## Workflow

### 1. Resolve the controller

- If `--controller` points to an existing `.java` file, use it directly.
- Otherwise treat it as a class name or FQCN and search the workspace.
- If search returns zero or multiple matches, stop and report the candidates instead of guessing.

### 2. Parse source code

- Read class-level `@RequestMapping` and `@Api(tags=...)`.
- Read method-level route annotations:
  - `@GetMapping`
  - `@PostMapping`
  - `@PutMapping`
  - `@DeleteMapping`
  - `@PatchMapping`
  - `@RequestMapping`
- Extract:
  - Java method name
  - HTTP method
  - full route
  - `@ApiOperation`
  - `@ApiImplicitParam(s)`
  - parameter annotations
  - return type
- Expand request and response DTOs recursively.

### 3. Sync to YApi

- Group interfaces by controller.
- Use the controller class name as the default YApi category name.
- Match existing interfaces by `HTTP method + full path`.
- Update when matched, create when missing.

### 4. Report results

Always return a concise summary with:

- controller path
- category name
- created count
- updated count
- skipped count
- failures with reasons

## Config

Create `config/yapi.json` in this skill directory.

Expected fields:

```json
{
  "baseUrl": "https://your-yapi-host",
  "token": "your-project-token",
  "projectId": 1
}
```

Do not place business secrets in the repo. Keep this file local to the skill directory.

## Implementation Notes

- Missing Swagger descriptions do not block sync.
- When a field comment is missing, keep the field name and Java type and note that the description is missing.
- `Map`, `Object`, unresolved generics, and cycle-heavy DTOs should be represented with placeholders instead of failing the whole sync.
- If network access is sandbox-blocked, request escalation and rerun the command.

## Resources

- YApi endpoint notes: `references/yapi-openapi-notes.md`
- Main sync script: `scripts/yapi_sync_controller.js`
