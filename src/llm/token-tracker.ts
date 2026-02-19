import { messageBus } from '../swarm/message-bus.js';

class TokenTracker {
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private callCount = 0;

  record(promptTokens: number, completionTokens: number): void {
    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;
    this.callCount++;

    messageBus.emit('tokens:update', this.getStats());
  }

  getStats() {
    return {
      promptTokens: this.totalPromptTokens,
      completionTokens: this.totalCompletionTokens,
      totalTokens: this.totalPromptTokens + this.totalCompletionTokens,
      callCount: this.callCount,
    };
  }

  reset(): void {
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.callCount = 0;
  }
}

export const tokenTracker = new TokenTracker();
