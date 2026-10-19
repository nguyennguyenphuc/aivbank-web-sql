import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { EconomyService } from './economy.service.js';
import type { RewardGrant, WalletSnapshot } from './economy.types.js';
import type { DailyGiftClaimResult, DailyGiftStatus } from '../../../../shared/contracts/economy/index.js';

const SPIN_REWARDS: RewardGrant[][] = [
  [{ currency: 'soft', amount: 100 }],
  [{ currency: 'soft', amount: 250 }],
  [{ itemId: 'hammer', quantity: 1 }],
  [{ itemId: 'extraMoves', quantity: 1 }],
];

@Injectable()
export class RewardService {
  constructor(@Inject(EconomyService) private readonly economy: EconomyService) {}

  async dailySpin(accountId: string, day: string, idempotencyKey: string): Promise<{ reward: RewardGrant[]; wallet: WalletSnapshot }> {
    const normalizedDay = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : new Date().toISOString().slice(0, 10);
    const digest = createHash('sha256').update(`${accountId}:${normalizedDay}:daily-spin-v1`).digest();
    const reward = SPIN_REWARDS[digest.readUInt32BE(0) % SPIN_REWARDS.length];
    const wallet = await this.economy.grant(accountId, reward, 'daily-spin', normalizedDay, idempotencyKey, `daily-spin:${accountId}:${normalizedDay}`);
    return { reward, wallet };
  }

  async starterPack(accountId: string): Promise<WalletSnapshot> {
    const claimId = `starter-pack:${accountId}`;
    if (await this.economy.isClaimed(claimId)) return this.economy.wallet(accountId);
    try {
      return await this.economy.grant(accountId, [
      { currency: 'soft', amount: 250 },
      { itemId: 'hammer', quantity: 3 },
      { itemId: 'shuffle', quantity: 3 },
      { itemId: 'lightning', quantity: 2 },
      { itemId: 'extraMoves', quantity: 2 },
      ], 'starter-pack', 'starter.v1', claimId, claimId);
    } catch (error) {
      if (!(error instanceof ConflictException) || !await this.economy.isClaimed(claimId)) throw error;
      return this.economy.wallet(accountId);
    }
  }

  async dailyGiftStatus(accountId: string): Promise<DailyGiftStatus> {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const nextClaimAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
    return { day, claimed: await this.economy.isClaimed(`daily-gift:${accountId}:${day}`), amount: 150, nextClaimAt };
  }

  async dailyGift(accountId: string, day: string, idempotencyKey: string): Promise<DailyGiftClaimResult> {
    const status = await this.dailyGiftStatus(accountId);
    if (day !== status.day) throw new BadRequestException('Daily gift day must match the current UTC day. Refresh gift status and retry.');
    if (!idempotencyKey.trim()) throw new BadRequestException('Idempotency key is required');
    const claimId = `daily-gift:${accountId}:${status.day}`;
    if (!status.claimed) {
      try {
        await this.economy.grant(accountId, [{ currency: 'soft', amount: status.amount }], 'daily-gift', status.day, idempotencyKey, claimId);
      } catch (error) {
        // Another tab or API process may settle the same day's claim first.
        // Only a confirmed claim makes this conflict a successful recovery.
        if (!(error instanceof ConflictException) || !await this.economy.isClaimed(claimId)) throw error;
      }
    }
    return { wallet: await this.economy.wallet(accountId), dailyGift: { ...status, claimed: true } };
  }

  buyExtraMoves(accountId: string, attemptId: string, idempotencyKey: string): Promise<WalletSnapshot> {
    // Authorize an immediate +5 continuation in local practice. The client
    // applies the moves only after this authoritative spend succeeds.
    return this.economy.spend(accountId, 'soft', 80, 'practice-extra-moves', attemptId, idempotencyKey);
  }
}
