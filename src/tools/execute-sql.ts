/**
 * Execute SQL queries on SQLite databases.
 * Supports parameterized queries for safety.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// Configuration
const MAX_ROWS = 100;           // Max rows to return from SELECT
const MAX_CELL_SIZE = 1000;     // Truncate cell values larger than this
const MAX_TOTAL_SIZE = 50000;   // Max total response size in chars
const BUSY_TIMEOUT = 5000;      // 5 second busy timeout for locked dbs

// Allowed databases cache (prevents reopening connections)
const dbCache = new Map<string, Database.Database>();

/**
 * Validate and resolve database path.
 * Ensures path is within project root and creates parent dirs if needed.
 */
function resolveDbPath(dbPath: string, projectRoot: string): { resolved: string; error?: string } {
  // Handle special :memory: database
  if (dbPath === ':memory:') {
    return { resolved: ':memory:' };
  }

  // Normalize path
  const normalized = path.normalize(dbPath);

  // Prevent path traversal attacks
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return {
      resolved: '',
      error: `Invalid database path: "${dbPath}". Use relative paths within the project (e.g., "data/mydb.db")`,
    };
  }

  // Resolve full path
  const resolved = path.resolve(projectRoot, normalized);

  // Ensure it's still within project root
  if (!resolved.startsWith(projectRoot)) {
    return {
      resolved: '',
      error: `Database path escapes project directory: "${dbPath}"`,
    };
  }

  // Create parent directories if needed
  const parentDir = path.dirname(resolved);
  try {
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
  } catch (err: any) {
    return {
      resolved: '',
      error: `Failed to create directory for database: ${err.message}`,
    };
  }

  return { resolved };
}

/**
 * Get or create a database connection.
 */
function getDb(resolvedPath: string, projectRoot: string): { db: Database.Database; error?: string } {
  // Handle memory databases (never cached)
  if (resolvedPath === ':memory:') {
    try {
      const db = new Database(':memory:');
      db.pragma(`busy_timeout = ${BUSY_TIMEOUT}`);
      return { db };
    } catch (err: any) {
      return { db: null as any, error: `Failed to create memory database: ${err.message}` };
    }
  }

  // Check cache
  const cached = dbCache.get(resolvedPath);
  if (cached) {
    try {
      // Test if connection is still valid
      cached.prepare('SELECT 1').get();
      return { db: cached };
    } catch {
      // Connection is dead, remove from cache
      dbCache.delete(resolvedPath);
    }
  }

  // Create new connection
  try {
    const db = new Database(resolvedPath);
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT}`);
    dbCache.set(resolvedPath, db);
    return { db };
  } catch (err: any) {
    return { db: null as any, error: `Failed to open database "${resolvedPath}": ${err.message}` };
  }
}

/**
 * Format a value for display (handle binary, null, large values).
 */
function formatValue(value: any): string {
  if (value === null) return 'NULL';
  if (value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (Buffer.isBuffer(value)) {
    // Binary data - show as hex with length
    const preview = value.slice(0, 32).toString('hex');
    const suffix = value.length > 32 ? `... (${value.length} bytes)` : ` (${value.length} bytes)`;
    return `<binary: ${preview}${suffix}>`;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[object]';
    }
  }
  const str = String(value);
  if (str.length > MAX_CELL_SIZE) {
    return str.slice(0, MAX_CELL_SIZE) + `... [truncated, ${str.length} chars total]`;
  }
  return str;
}

/**
 * Format query results as a readable table.
 */
function formatResults(rows: any[], columns: string[]): string {
  if (rows.length === 0) {
    return `Empty result set (${columns.length} column${columns.length !== 1 ? 's' : ''}: ${columns.join(', ')})`;
  }

  const lines: string[] = [];

  // Header
  lines.push(columns.join(' | '));
  lines.push('-'.repeat(Math.max(20, columns.join(' | ').length)));

  // Rows
  for (const row of rows) {
    const values = columns.map(col => formatValue((row as any)[col]));
    lines.push(values.join(' | '));
  }

  let result = lines.join('\n');

  // Add summary
  const summary = `\n\n(${rows.length} row${rows.length !== 1 ? 's' : ''} returned)`;
  result += summary;

  return result;
}

/**
 * Detect if a query is destructive (modifies data or schema).
 */
function isDestructiveQuery(sql: string): boolean {
  const normalized = sql.trim().toUpperCase();
  return (
    normalized.startsWith('DROP') ||
    normalized.startsWith('DELETE') ||
    normalized.startsWith('TRUNCATE') ||
    normalized.startsWith('ALTER') ||
    normalized.startsWith('UPDATE')
  );
}

/**
 * Detect if a query is read-only.
 */
function isReadOnlyQuery(sql: string): boolean {
  const normalized = sql.trim().toUpperCase();
  return (
    normalized.startsWith('SELECT') ||
    normalized.startsWith('PRAGMA') ||
    normalized.startsWith('EXPLAIN')
  );
}

/**
 * Execute a SQL query on a SQLite database.
 *
 * @param projectRoot - The project root directory
 * @param args - Tool arguments:
 *   - dbPath: Path to the SQLite database file (relative to project root) or ":memory:"
 *   - query: SQL query to execute
 *   - params: Optional array of parameters for parameterized queries (RECOMMENDED for user input)
 */
export async function executeSqlTool(
  projectRoot: string,
  args: { dbPath: string; query: string; params?: any[] }
): Promise<string> {
  const { dbPath, query, params } = args;

  // Validate required args
  if (!dbPath) {
    return 'Error: "dbPath" is required. Specify a database file path (e.g., "data/app.db") or ":memory:" for an in-memory database.';
  }
  if (!query) {
    return 'Error: "query" is required. Provide a SQL query to execute.';
  }

  // Validate parameterized query usage for SELECT with user input
  const trimmedQuery = query.trim().toUpperCase();
  if (trimmedQuery.startsWith('SELECT') && !params && query.includes("'")) {
    console.warn('Warning: SELECT query with string literals - consider using parameterized queries');
  }

  // Resolve database path
  const { resolved, error: pathError } = resolveDbPath(dbPath, projectRoot);
  if (pathError) {
    return `Error: ${pathError}`;
  }

  // Get database connection
  const { db, error: dbError } = getDb(resolved, projectRoot);
  if (dbError) {
    return `Error: ${dbError}`;
  }

  try {
    // Check if database file exists (for file-based dbs)
    const isExisting = resolved !== ':memory:' && fs.existsSync(resolved);
    const isReadonly = isReadOnlyQuery(query);
    const isDestructive = isDestructiveQuery(query);

    // Prepare and execute
    const stmt = db.prepare(query);

    // Bind parameters if provided
    const boundStmt = params && params.length > 0 ? stmt.bind(...params) : stmt;

    // Execute based on query type
    if (isReadonly || query.trim().toUpperCase().startsWith('SELECT')) {
      // SELECT queries - return rows
      const rows = boundStmt.all();
      const columns = stmt.columns().map(c => c.name);

      // Limit rows
      const limitedRows = rows.slice(0, MAX_ROWS);
      const wasLimited = rows.length > MAX_ROWS;

      let result = formatResults(limitedRows, columns);
      if (wasLimited) {
        result += `\n[Note: Result limited to ${MAX_ROWS} rows. Total rows: ${rows.length}]`;
      }

      // Check total size
      if (result.length > MAX_TOTAL_SIZE) {
        result = result.slice(0, MAX_TOTAL_SIZE) + `\n\n... [Output truncated at ${MAX_TOTAL_SIZE} characters]`;
      }

      return result;
    } else {
      // Modification queries (INSERT, UPDATE, DELETE, CREATE, DROP, etc.)
      const info = boundStmt.run();

      const parts: string[] = [];

      if (info.changes > 0) {
        parts.push(`${info.changes} row${info.changes !== 1 ? 's' : ''} affected`);
      }
      if (info.lastInsertRowid && info.lastInsertRowid > 0) {
        parts.push(`last insert rowid: ${info.lastInsertRowid}`);
      }

      // For schema operations, just report success
      if (info.changes === 0 && info.lastInsertRowid === 0) {
        parts.push('Query executed successfully');
      }

      // Add warning for destructive operations
      if (isDestructive) {
        parts.push('[Warning: This was a destructive operation]');
      }

      return parts.join(', ');
    }
  } catch (err: any) {
    // Provide helpful error messages
    let errorMsg = err.message;

    // Common SQLite errors with suggestions
    if (err.code === 'SQLITE_BUSY') {
      errorMsg = 'Database is locked by another process. Try again in a moment.';
    } else if (err.code === 'SQLITE_CONSTRAINT') {
      errorMsg = `Constraint violation: ${err.message}. Check for duplicate keys, foreign key violations, or NOT NULL constraints.`;
    } else if (err.code === 'SQLITE_ERROR') {
      // Syntax error - provide context
      if (err.message.includes('no such table')) {
        errorMsg = `${err.message}. Create the table first with CREATE TABLE, or check the table name.`;
      } else if (err.message.includes('no such column')) {
        errorMsg = `${err.message}. Check column names or alter the table to add the column.`;
      } else if (err.message.includes('syntax error')) {
        errorMsg = `SQL syntax error: ${err.message}. Check your query syntax.`;
      }
    } else if (err.code === 'SQLITE_READONLY') {
      errorMsg = 'Database is read-only. Check file permissions.';
    }

    return `Error: ${errorMsg}`;
  }
}

/**
 * List all tables in a database with their schemas.
 */
export async function listTablesTool(
  projectRoot: string,
  args: { dbPath: string }
): Promise<string> {
  const { dbPath } = args;

  if (!dbPath) {
    return 'Error: "dbPath" is required.';
  }

  // Resolve database path
  const { resolved, error: pathError } = resolveDbPath(dbPath, projectRoot);
  if (pathError) {
    return `Error: ${pathError}`;
  }

  // Check if file exists (for file-based dbs)
  if (resolved !== ':memory:' && !fs.existsSync(resolved)) {
    return `Error: Database file not found: "${dbPath}". Create it first by running a CREATE TABLE statement.`;
  }

  // Get database connection
  const { db, error: dbError } = getDb(resolved, projectRoot);
  if (dbError) {
    return `Error: ${dbError}`;
  }

  try {
    // Get all tables
    const tables = db.prepare(`
      SELECT name, type
      FROM sqlite_master
      WHERE type IN ('table', 'view')
      ORDER BY type, name
    `).all() as { name: string; type: string }[];

    if (tables.length === 0) {
      return `Database "${dbPath}" is empty. No tables or views found. Use execute_sql with a CREATE TABLE statement to create one.`;
    }

    const lines: string[] = [`Tables in "${dbPath}":`];

    for (const table of tables) {
      lines.push(`\n${table.type.toUpperCase()}: ${table.name}`);

      // Get schema for this table
      const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(table.name) as { sql: string } | undefined;
      if (schema?.sql) {
        lines.push(`  Schema: ${schema.sql}`);
      }

      // Get row count
      try {
        const count = db.prepare(`SELECT COUNT(*) as count FROM "${table.name}"`).get() as { count: number };
        lines.push(`  Rows: ${count.count}`);
      } catch {
        lines.push(`  Rows: (unable to count)`);
      }
    }

    return lines.join('\n');
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

/**
 * Initialize a new database with a schema.
 */
export async function initDatabaseTool(
  projectRoot: string,
  args: { dbPath: string; schema: string }
): Promise<string> {
  const { dbPath, schema } = args;

  if (!dbPath) {
    return 'Error: "dbPath" is required.';
  }
  if (!schema) {
    return 'Error: "schema" is required. Provide SQL statements to initialize the database (e.g., CREATE TABLE statements).';
  }

  // Resolve database path
  const { resolved, error: pathError } = resolveDbPath(dbPath, projectRoot);
  if (pathError) {
    return `Error: ${pathError}`;
  }

  // Check if file already exists
  if (resolved !== ':memory:' && fs.existsSync(resolved)) {
    return `Error: Database file already exists: "${dbPath}". Use execute_sql to modify an existing database, or choose a different name.`;
  }

  // Get database connection
  const { db, error: dbError } = getDb(resolved, projectRoot);
  if (dbError) {
    return `Error: ${dbError}`;
  }

  try {
    // Split schema into statements and execute each
    const statements = schema
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    const results: string[] = [];

    // Run in transaction for atomicity
    const transaction = db.transaction(() => {
      for (const stmt of statements) {
        try {
          db.exec(stmt + ';');
          results.push(`✓ ${stmt.slice(0, 50)}${stmt.length > 50 ? '...' : ''}`);
        } catch (err: any) {
          throw new Error(`Failed on statement "${stmt.slice(0, 30)}...": ${err.message}`);
        }
      }
    });

    transaction();

    return `Database "${dbPath}" initialized successfully.\n\nStatements executed:\n${results.map(r => '  ' + r).join('\n')}`;
  } catch (err: any) {
    // Clean up failed database
    if (resolved !== ':memory:') {
      try {
        dbCache.delete(resolved);
        if (fs.existsSync(resolved)) {
          fs.unlinkSync(resolved);
        }
      } catch {
        // Ignore cleanup errors
      }
    }

    return `Error: ${err.message}`;
  }
}

/**
 * Close all database connections (for cleanup).
 */
export function closeAllDatabases(): void {
  for (const [path, db] of dbCache) {
    try {
      db.close();
    } catch {
      // Ignore close errors
    }
  }
  dbCache.clear();
}
