/**
 * Bounded-concurrency `map`.
 *
 * The sidebar's batch routes fan out over per-directory work (an `opendir`
 * plus its symlink probes, a watch registration). `Promise.all` over a
 * client-supplied list would open every one of those at once, so a single
 * refresh round could pin hundreds of file descriptors; the file tree's own
 * symlink probe already runs this way (see `fs-tree.ts`).
 *
 * Order is preserved regardless of completion order, which matters because
 * the client matches batch results back to the paths it asked about.
 */

/**
 * Run `run` over every item with at most `limit` calls in flight.
 *
 * @param items - the input list (read once, synchronously).
 * @param limit - max concurrent invocations; values below 1 are clamped to 1
 *   so a mis-typed bound degrades to serial execution, never to a stall.
 * @param run - one unit of work; a rejection propagates to the caller.
 * @returns the results in input order.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  const width = Math.max(1, Math.min(Math.floor(limit), items.length))
  let next = 0
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      out[index] = await run(items[index]!)
    }
  })
  await Promise.all(workers)
  return out
}