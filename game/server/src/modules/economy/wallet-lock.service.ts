import { Injectable } from '@nestjs/common';

@Injectable()
export class WalletLockService {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(accountId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = prior.then(() => current);
    this.tails.set(accountId, tail);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(accountId) === tail) this.tails.delete(accountId);
    }
  }
}
