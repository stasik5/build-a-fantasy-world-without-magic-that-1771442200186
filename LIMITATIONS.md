# Builder Swarm — Known Limitations & Self-Awareness Guide

This file is for YOU, the AI orchestrator and workers. Read it to avoid common failure modes.

## Architecture Constraints

### Context Window
- Each worker has a finite context window (~128K tokens for GLM-5).
- Long conversations with many tool calls will hit the limit. When this happens, early context is summarized and details are lost.
- **Mitigation**: Keep subtasks focused. One worker should not touch more than 5-8 files. If a subtask grows beyond 10 tool calls, something is wrong — break it down further.

### Worker Isolation
- Workers cannot talk to each other. They only see:
  - Their assigned subtask description
  - Summaries of completed sibling subtasks (truncated to 600 chars)
  - The project file tree
- Workers do NOT see each other's full code output. They must use `read_file` to see files written by other workers.
- **Mitigation**: When a subtask depends on another, the description MUST specify exact file paths, function names, export names, and API contracts. Never say "use the API from the other task" — say "import { createUser } from './services/user.js'".

### Single Session
- The system has no memory between runs. Each invocation starts fresh.
- Checkpoints save subtask state but not learned patterns or decisions.
- **Mitigation**: If resuming a project, read existing files thoroughly before making changes. Don't assume you remember what was built — verify with `read_file` and `glob_files`.

## Common Failure Modes

### 1. Import/Export Mismatches
**Symptom**: `Module not found` or `is not exported` errors after workers complete.
**Cause**: Worker A exports `createUser` but Worker B imports `addUser` because they never coordinated.
**Prevention**: The orchestrator MUST specify exact export names in subtask descriptions. Use the same naming in all subtask descriptions that share an interface.

### 2. File Overwrites
**Symptom**: A file written by Worker A is completely replaced by Worker B, losing Worker A's code.
**Cause**: Two subtasks modify the same file, and the second worker uses `write_file` without reading first.
**Prevention**:
- Never assign two concurrent subtasks that modify the same file.
- Always use `read_file` before `write_file` on existing files.
- Prefer `patch_file` for surgical edits to existing files.

### 3. Hallucinated APIs
**Symptom**: Code uses functions, methods, or options that don't exist in the library.
**Cause**: The LLM's training data is outdated or imprecise about specific API details.
**Prevention**: When unsure about a library's API, use `web_search` to look up the current documentation, then `web_reader` to read it. This is especially important for:
- React (hooks API changes between versions)
- Next.js (App Router vs Pages Router)
- Any library you haven't used extensively

### 4. Incomplete Error Handling
**Symptom**: App crashes on first unexpected input.
**Cause**: Workers focus on the happy path and skip error cases.
**Prevention**: Subtask descriptions should explicitly mention error handling requirements when relevant. The Integration & Testing subtask should test error cases.

### 5. Oversized Files
**Symptom**: Worker writes a 500+ line file that tries to do everything.
**Cause**: Subtask was too broad, or worker didn't break the work into modules.
**Prevention**: If a single file exceeds ~200 lines, it should probably be split. Orchestrator should plan subtasks at the right granularity.

### 6. Missing Dependencies
**Symptom**: `npm install` works but runtime fails because a package wasn't added.
**Cause**: Worker used `import` for a package but never ran `npm install <package>`.
**Prevention**: The setup/initialization subtask should install ALL dependencies. If a later subtask needs a new dependency, it MUST run `npm install <package>` before using it.

### 7. Path Issues
**Symptom**: Works on one OS but not another, or paths resolve incorrectly.
**Cause**: Using absolute paths, backslashes, or OS-specific path separators.
**Prevention**: Always use relative paths with forward slashes. Never hardcode absolute paths.

## Scope Limits — Be Honest About What You Can't Do

### DO NOT attempt:
- Projects requiring more than ~50 files — you will lose coherence
- Database migrations on production systems
- Complex state management across 10+ components
- Anything requiring visual inspection (CSS pixel-perfect work)
- Security-critical authentication systems without thorough review
- Real-time systems (WebSocket servers with complex state)
- Projects requiring multiple running services to test (e.g., frontend + backend + database simultaneously)

### BE CAUTIOUS with:
- TypeScript generics and complex type inference — verify with `tsc --noEmit`
- CSS layouts — test with simple cases first
- Async code with complex error handling — race conditions are invisible to you
- Monorepos — you can only effectively work in one package at a time

### YOU ARE GOOD AT:
- Self-contained web apps (HTML + CSS + JS)
- Express/Fastify API servers
- React/Vue/Svelte single-page apps
- CLI tools and scripts
- File processing and data transformation
- Adding features to existing small-to-medium codebases
- Converting between formats (JS→TS, REST→GraphQL, etc.)

## Worker Best Practices

1. **Read before write**. Always. No exceptions.
2. **Verify your work**. Run `node --check`, `tsc --noEmit`, or the project's build command after writing code.
3. **Use `glob_files`** to understand project structure before making assumptions.
4. **Use `web_search`** when you're not 100% sure about an API. A 20-second search prevents a failed subtask.
5. **Use `patch_file`** for small edits. Don't rewrite a 200-line file to change 3 lines.
6. **Report honestly**. If something didn't work, say so in your summary. Don't claim success when there are unresolved errors. The verification loop will catch it anyway.
