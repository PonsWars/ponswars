/**
 * The browser wallet, at arm's length (§68.2).
 *
 * EIP-1193 directly, with no connector library. Three methods are needed —
 * accounts, chain, sign — and every library that wraps them brings a modal, a
 * theme and a list of vendors, which is a product decision nobody has made
 * (§59.4). This is small enough to read in one sitting, which is the property
 * that matters for the code standing between a player and their wallet.
 *
 * ## What it will never do
 *
 * Ask for a transaction. Nothing here can move funds: the only signing method
 * called is `personal_sign`, and the message it signs is the one the server
 * issued. §45.2 puts real value behind a wallet transaction confirmation, and
 * that is somewhere else by design.
 */

/** The slice of EIP-1193 this uses. */
export interface Eip1193Provider {
  request(args: {
    readonly method: string;
    readonly params?: readonly unknown[];
  }): Promise<unknown>;
  on?: (event: string, handler: (...args: never[]) => void) => void;
  removeListener?: (event: string, handler: (...args: never[]) => void) => void;
}

export type WalletFailure =
  /** No wallet extension in this browser. */
  | { readonly kind: 'NO_WALLET' }
  /** The player closed the prompt, or refused. Not an error to shout about. */
  | { readonly kind: 'DECLINED' }
  /** Connected, but on a chain this deployment does not accept. */
  | { readonly kind: 'WRONG_CHAIN'; readonly chainId: number; readonly expected: number }
  | { readonly kind: 'FAILED'; readonly detail: string };

export type WalletResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: WalletFailure };

/**
 * EIP-1193's code for a user rejecting a prompt.
 *
 * Worth naming: a declined signature is the most common outcome of this whole
 * flow and is not a failure — showing an error for it would tell a player they
 * broke something by changing their mind.
 */
const USER_REJECTED = 4001;

/** The injected provider, or `null` when there is no wallet in this browser. */
export function browserProvider(): Eip1193Provider | null {
  const injected = (globalThis as { ethereum?: unknown }).ethereum;
  if (typeof injected !== 'object' || injected === null || !('request' in injected)) {
    return null;
  }
  return injected as Eip1193Provider;
}

/**
 * Connects, and returns the account and chain.
 *
 * `eth_requestAccounts` is the one call that opens the wallet's own UI. It is
 * called on a click and never on load: a page that asks for a wallet the moment
 * it opens is a page people close.
 */
export async function connectWallet(
  provider: Eip1193Provider,
): Promise<WalletResult<{ readonly address: string; readonly chainId: number }>> {
  try {
    const accounts: unknown = await provider.request({ method: 'eth_requestAccounts' });
    // Read defensively. This is an extension's answer, not a typed API, and a
    // wallet that returns an empty array is what "the player closed the prompt"
    // looks like in at least one of them.
    const address: unknown = Array.isArray(accounts) ? (accounts as unknown[])[0] : undefined;
    if (typeof address !== 'string') {
      return { ok: false, failure: { kind: 'DECLINED' } };
    }
    const chainId = await currentChain(provider);
    return { ok: true, value: { address, chainId } };
  } catch (error: unknown) {
    return { ok: false, failure: describe(error) };
  }
}

/** The chain the wallet is on, as a number. */
export async function currentChain(provider: Eip1193Provider): Promise<number> {
  const raw = await provider.request({ method: 'eth_chainId' });
  // Hex string by the specification, and a number from at least one wallet in
  // the wild. Both are read rather than one assumed.
  return typeof raw === 'string' ? Number.parseInt(raw, 16) : Number(raw);
}

/**
 * Asks the wallet to switch networks, and says whether it did.
 *
 * Offered rather than required: a player can switch in their wallet instead,
 * and a client that treats a refusal here as fatal has taken away the choice.
 */
export async function switchChain(
  provider: Eip1193Provider,
  chainId: number,
): Promise<WalletResult<void>> {
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${chainId.toString(16)}` }],
    });
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    return { ok: false, failure: describe(error) };
  }
}

/**
 * Signs the server's message (§45.2).
 *
 * `personal_sign` with the message first and the address second — the parameter
 * order is the reverse of `eth_sign` and getting it wrong produces a signature
 * over the address, which verifies as nobody.
 */
export async function signMessage(
  provider: Eip1193Provider,
  address: string,
  message: string,
): Promise<WalletResult<string>> {
  try {
    const signature = await provider.request({
      method: 'personal_sign',
      params: [message, address],
    });
    if (typeof signature !== 'string') {
      return { ok: false, failure: { kind: 'FAILED', detail: 'wallet returned no signature' } };
    }
    return { ok: true, value: signature };
  } catch (error: unknown) {
    return { ok: false, failure: describe(error) };
  }
}

function describe(error: unknown): WalletFailure {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code?: unknown };
    if (code === USER_REJECTED) {
      return { kind: 'DECLINED' };
    }
  }
  return {
    kind: 'FAILED',
    detail: error instanceof Error ? error.message : 'the wallet refused without saying why',
  };
}
