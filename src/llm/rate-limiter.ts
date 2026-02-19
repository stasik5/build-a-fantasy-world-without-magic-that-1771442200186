import { CONFIG } from '../config.js';
import { messageBus } from '../swarm/message-bus.js';

class RateLimiter {
  private activeCount = 0;
  private maxConcurrent: number;
  private maxPerHour: number;
  private callTimestamps: number[] = [];
  private waitQueue: Array<() => void> = [];

  constructor(maxConcurrent: number, maxPerHour: number) {
    this.maxConcurrent = maxConcurrent;
    this.maxPerHour = maxPerHour;
  }

  async acquire(): Promise<void> {
    // Wait for a concurrency slot
    while (this.activeCount >= this.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }

    // Enforce hourly rate limit
    this.pruneOldTimestamps();
    while (this.callTimestamps.length >= this.maxPerHour) {
      const oldestTimestamp = this.callTimestamps[0]!;
      const waitMs = oldestTimestamp + 3_600_000 - Date.now() + 100; // +100ms buffer
      if (waitMs > 0) {
        messageBus.emit('rate-limit:wait', { waitMs });
        await this.sleep(waitMs);
      }
      this.pruneOldTimestamps();
    }

    this.activeCount++;
    this.callTimestamps.push(Date.now());
  }

  release(): void {
    this.activeCount--;
    // Wake the next waiter
    const next = this.waitQueue.shift();
    if (next) next();
  }

  getStatus() {
    this.pruneOldTimestamps();
    return {
      active: this.activeCount,
      maxConcurrent: this.maxConcurrent,
      callsInWindow: this.callTimestamps.length,
      maxPerHour: this.maxPerHour,
    };
  }

  private pruneOldTimestamps(): void {
    const oneHourAgo = Date.now() - 3_600_000;
    while (this.callTimestamps.length > 0 && this.callTimestamps[0]! < oneHourAgo) {
      this.callTimestamps.shift();
    }
  }

  updateLimits(maxConcurrent: number, maxPerHour: number): void {
    this.maxConcurrent = maxConcurrent;
    this.maxPerHour = maxPerHour;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export { RateLimiter };

// Global rate limiter for orchestrator/general use
export const rateLimiter = new RateLimiter(CONFIG.MAX_CONCURRENT, CONFIG.MAX_CALLS_PER_HOUR);

// Factory to create rate limiters for workers (each worker gets its own)
export function createWorkerRateLimiter(): RateLimiter {
  // Each worker gets its own rate limiter with same limits
  // This allows workers to operate in parallel without blocking each other
  return new RateLimiter(CONFIG.MAX_CONCURRENT, CONFIG.MAX_CALLS_PER_HOUR);
}
