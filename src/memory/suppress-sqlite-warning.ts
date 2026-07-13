/**
 * Suppress ONLY the node:sqlite ExperimentalWarning so it doesn't corrupt
 * Nexus's structured (JSON) stderr log stream. Other warnings are unaffected.
 *
 * This module has no imports and must be imported BEFORE `node:sqlite` wherever
 * the store is used — ESM evaluates imports in source order, so installing the
 * override here ensures it is in place before node:sqlite emits its load-time
 * warning.
 */
{
  const originalEmit = process.emit;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as { emit: typeof process.emit }).emit = function (
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...rest: any[]
  ): boolean {
    if (
      name === "warning" &&
      data &&
      typeof data === "object" &&
      data?.name === "ExperimentalWarning" &&
      /sqlite/i.test(String(data?.message ?? ""))
    ) {
      return false;
    }
    return originalEmit.apply(process, [name, data, ...rest]) as boolean;
  };
}
