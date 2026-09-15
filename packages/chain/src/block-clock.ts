/**
 * When blocks were made, read sparingly.
 *
 * A trade needs its block's timestamp, and the public Robinhood Chain endpoint
 * does not put one on a log: `blockTimestamp` comes back as `0x0`. Reading
 * every block a trade landed in would be a call for nearly every block — the
 * chain makes about ten a second — so blocks are read only at anchors, and a
 * block between two anchors is placed on the line through them.
 *
 * That is accurate because block production is steady. Measured on mainnet,
 * interpolating across five minutes of blocks lands within a second of every
 * block's own timestamp, which is the timestamp's own resolution; across three
 * hours, within half a minute. Callers pick the anchor spacing by how much a
 * second matters to what they will do with the time.
 */

/** A block's timestamp, in milliseconds. */
export type ReadBlockTime = (block: bigint) => Promise<number>;

export class BlockClock {
  /** Block numbers with a known timestamp, ascending. */
  private readonly blocks: bigint[] = [];
  private readonly times = new Map<bigint, number>();

  constructor(private readonly readBlockTime: ReadBlockTime) {}

  /** A block's own timestamp, read once and kept as an anchor. */
  async read(block: bigint): Promise<number> {
    const known = this.times.get(block);
    if (known !== undefined) {
      return known;
    }
    const at = await this.readBlockTime(block);
    this.remember(block, at);
    return at;
  }

  /** Records a timestamp already read elsewhere. */
  remember(block: bigint, at: number): void {
    if (this.times.has(block)) {
      return;
    }
    this.times.set(block, at);
    this.blocks.splice(this.lowerBound(block), 0, block);
  }

  /**
   * The timestamp of each block, to within what `spacing` allows.
   *
   * A block is placed between the nearest anchors no further apart than
   * `spacing(block)`, reading anchors on a fixed grid where there are none, so
   * blocks close together share them. A block outside every anchor is read.
   */
  async timesOf(
    wanted: readonly bigint[],
    spacing: (block: bigint) => bigint,
  ): Promise<Map<bigint, number>> {
    const result = new Map<bigint, number>();
    for (const block of [...new Set(wanted)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const exact = this.times.get(block);
      if (exact !== undefined) {
        result.set(block, exact);
        continue;
      }
      const step = spacing(block);
      if (step < 1n) {
        throw new RangeError('Anchor spacing must be at least one block');
      }
      let [below, above] = this.around(block);
      if (below === null || above === null) {
        result.set(block, await this.read(block));
        continue;
      }
      if (above - below > step) {
        const cell = below + ((block - below) / step) * step;
        const next = cell + step < above ? cell + step : above;
        await this.read(cell);
        await this.read(next);
        [below, above] = this.around(block);
      }
      result.set(block, this.interpolate(block, below, above));
    }
    return result;
  }

  /** Forgets anchors older than `at`, keeping the newest of them to interpolate from. */
  forgetBefore(at: number): void {
    let drop = 0;
    while (drop + 1 < this.blocks.length) {
      const next = this.blocks[drop + 1];
      if (next === undefined || (this.times.get(next) ?? Infinity) >= at) {
        break;
      }
      drop += 1;
    }
    for (const block of this.blocks.splice(0, drop)) {
      this.times.delete(block);
    }
  }

  /** How many anchors are kept, for tests and logs. */
  get size(): number {
    return this.blocks.length;
  }

  private interpolate(block: bigint, below: bigint | null, above: bigint | null): number {
    const low = below === null ? undefined : this.times.get(below);
    const high = above === null ? undefined : this.times.get(above);
    if (below === null || above === null || low === undefined || high === undefined) {
      throw new Error(`No anchors around block ${block.toString()}`);
    }
    if (above === below) {
      return low;
    }
    const fraction = Number(block - below) / Number(above - below);
    // Block timestamps are whole seconds, so an estimate is too.
    return Math.round((low + (high - low) * fraction) / 1_000) * 1_000;
  }

  /** The nearest anchors at or below and at or above `block`. */
  private around(block: bigint): [bigint | null, bigint | null] {
    const index = this.lowerBound(block);
    const atOrAbove = this.blocks[index] ?? null;
    if (atOrAbove === block) {
      return [block, block];
    }
    return [this.blocks[index - 1] ?? null, atOrAbove];
  }

  private lowerBound(block: bigint): number {
    let low = 0;
    let high = this.blocks.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const value = this.blocks[middle];
      if (value !== undefined && value < block) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }
}
