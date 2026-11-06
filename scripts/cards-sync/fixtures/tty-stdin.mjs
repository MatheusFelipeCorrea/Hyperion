/**
 * Test support: preload (via NODE_OPTIONS=--import) that makes the child's stdin
 * report as a TTY, so sync.mjs's live-sync confirmation prompt can be driven with piped input.
 */
Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
