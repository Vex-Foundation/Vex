import { z } from "zod";
import { chainSchema } from "./base-chain.js";
import { PASSWORD_MIN_LENGTH } from "../secrets.js";

export const walletRemovalInputSchema = z.object({
  chain: chainSchema, walletId: z.string().min(1).max(80),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(1024),
}).strict();
export type WalletRemovalInput = z.infer<typeof walletRemovalInputSchema>;
export const walletRecoveryInputSchema = walletRemovalInputSchema.extend({
  recoveryPassword: z.string().min(1).max(1024).optional(),
});
export type WalletRecoveryInput = z.infer<typeof walletRecoveryInputSchema>;
export const walletRemovalResultSchema = z.object({
  walletId: z.string(), address: z.string(), backupDir: z.string(),
  affectedChats: z.number().int().nonnegative(), pausedMissions: z.number().int().nonnegative(),
}).strict();
export type WalletRemovalResult = z.infer<typeof walletRemovalResultSchema>;
export const removedWalletsSchema = z.array(z.object({
  walletId: z.string(), chain: chainSchema, address: z.string(), label: z.string(),
  state: z.enum(["removing", "removed"]), removedAt: z.string(),
}));
export type RemovedWallets = z.infer<typeof removedWalletsSchema>;
