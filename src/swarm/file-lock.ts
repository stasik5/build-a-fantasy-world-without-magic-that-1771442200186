/**
 * In-process file lock to prevent concurrent workers from writing to the same file.
 * Workers acquire a lock before writing and release it after.
 */

class FileLockManager {
  private locks = new Map<string, { workerIndex: number; acquiredAt: number }>();
  private waitQueues = new Map<string, Array<() => void>>();

  async acquire(filePath: string, workerIndex: number): Promise<void> {
    const normalized = filePath.toLowerCase();

    while (this.locks.has(normalized)) {
      const holder = this.locks.get(normalized)!;
      // If the same worker already holds the lock, allow re-entry
      if (holder.workerIndex === workerIndex) return;

      // Wait for the lock to be released
      await new Promise<void>((resolve) => {
        const queue = this.waitQueues.get(normalized) ?? [];
        queue.push(resolve);
        this.waitQueues.set(normalized, queue);
      });
    }

    this.locks.set(normalized, { workerIndex, acquiredAt: Date.now() });
  }

  release(filePath: string): void {
    const normalized = filePath.toLowerCase();
    this.locks.delete(normalized);

    // Wake the next waiter
    const queue = this.waitQueues.get(normalized);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) this.waitQueues.delete(normalized);
      next();
    }
  }

  isLocked(filePath: string): boolean {
    return this.locks.has(filePath.toLowerCase());
  }

  getHolder(filePath: string): number | null {
    const lock = this.locks.get(filePath.toLowerCase());
    return lock?.workerIndex ?? null;
  }
}

export const fileLockManager = new FileLockManager();
