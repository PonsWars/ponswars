import type { SecretVault } from '@ponswars/genesis-service';
import {
  baseUnits,
  chainLabel,
  type SecretEntitlementState,
  type WalletAddress,
} from '@ponswars/shared-types';

/**
 * The Secret Stock Vault on Robinhood Chain, as the Genesis flow needs it (§8.4, §76.5).
 *
 * The decisions live here and the transport beside it (`rpcVaultContract`), so
 * the part that decides whether a player is shown a Secret is testable without
 * a chain:
 *
 * - **Covered?** Read from the contract at the moment it is asked (§8.3).
 * - **Reserve.** Simulated first. A simulation that reverts with
 *   `InsufficientCoverage` is `UNCOVERED` — the designed state, not a fault. One
 *   that reverts with `AlreadyEntitled` means a reservation for this wallet is
 *   already on chain: a transaction that landed before its claim was recorded.
 *   That reservation is found and returned, so a crash between the chain and
 *   the database costs nothing and never reserves twice.
 * - **Anything else throws**, and the flow holds the Secret back and tries again.
 *
 * Reservations for one wallet run one at a time in this process, so two reads
 * racing to reveal the same Secret send one transaction between them.
 */

export type ReserveSimulation = 'WOULD_RESERVE' | 'UNCOVERED' | 'ALREADY_ENTITLED';

/**
 * What the vault says a wallet holds (§8.5).
 *
 * `NONE` is the ordinary answer: one Secret exists per wallet at most, and
 * almost no wallet has one. A claimed entitlement stays `CLAIMED` forever —
 * the trophy is permanent, and the state is what stops a second reservation.
 */
export type SecretEntitlement = 'NONE' | SecretEntitlementState;

/** Reading a wallet's entitlement, without the key that reserves one. */
export interface SecretVaultReader {
  /** The reward one Secret pays, in the reward token's base units. */
  rewardAmount(): Promise<bigint>;
  entitlementOf(wallet: WalletAddress): Promise<SecretEntitlement>;
}

/** The slice of `SecretStockVault` the decisions read and write. */
export interface VaultContract {
  isCovered(): Promise<boolean>;
  rewardAmount(): Promise<bigint>;
  simulateReserve(wallet: WalletAddress): Promise<ReserveSimulation>;
  /** Sends `reserve(wallet)` and waits for it to land; the transaction hash. */
  sendReserve(wallet: WalletAddress): Promise<`0x${string}`>;
  /** The transaction that reserved for `wallet`, or `null` if none is found. */
  findReservation(wallet: WalletAddress): Promise<`0x${string}` | null>;
  hasReserverRole(account: `0x${string}`): Promise<boolean>;
}

export class ChainSecretVault implements SecretVault {
  readonly #contract: VaultContract;
  readonly #inFlight = new Map<WalletAddress, ReturnType<SecretVault['reserve']>>();

  constructor(contract: VaultContract) {
    this.#contract = contract;
  }

  isCovered(): Promise<boolean> {
    return this.#contract.isCovered();
  }

  reserve(wallet: WalletAddress): ReturnType<SecretVault['reserve']> {
    const running = this.#inFlight.get(wallet);
    if (running !== undefined) {
      return running;
    }
    const attempt = this.#reserve(wallet).finally(() => {
      this.#inFlight.delete(wallet);
    });
    this.#inFlight.set(wallet, attempt);
    return attempt;
  }

  async #reserve(wallet: WalletAddress): ReturnType<SecretVault['reserve']> {
    const simulation = await this.#contract.simulateReserve(wallet);
    if (simulation === 'UNCOVERED') {
      return { kind: 'UNCOVERED' };
    }

    const reservationTx =
      simulation === 'ALREADY_ENTITLED'
        ? await this.#contract.findReservation(wallet)
        : await this.#contract.sendReserve(wallet);
    if (reservationTx === null) {
      throw new Error(
        `The vault says ${wallet} is already entitled, but no reservation for it was found`,
      );
    }

    return {
      kind: 'RESERVED',
      reservation: {
        // One entitlement per wallet, ever (§6), so the wallet names it.
        entitlementId: `secret-${wallet}`,
        amount: baseUnits(await this.#contract.rewardAmount()),
        reservationTx,
      },
    };
  }
}

/**
 * Refuses a reserver key that the vault has not granted `RESERVER_ROLE`.
 *
 * Checked once at startup. A key without the role would fail every Secret
 * reservation, holding each Secret back forever while looking configured.
 */
export async function assertReserver(
  contract: VaultContract,
  account: `0x${string}`,
  chainId: number,
): Promise<void> {
  if (!(await contract.hasReserverRole(account))) {
    throw new Error(
      `SECRET_RESERVER_KEY is ${account}, which does not hold RESERVER_ROLE on the Secret ` +
        `Stock Vault on ${chainLabel(chainId)}. Grant it (contracts/script/GrantRoles.s.sol) ` +
        'or set SECRET_RESERVER_KEY=disabled.',
    );
  }
}
