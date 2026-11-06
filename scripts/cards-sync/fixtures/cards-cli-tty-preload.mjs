/**
 * Test support: makes `process.stdin.isTTY` true so a CLI's interactive (y/N)
 * prompt can be answered from a piped stdin. Loaded via NODE_OPTIONS by
 * cards-cli-harness.mjs (`tty: true`); stdin is only touched when the script
 * reads it, so piped input is left for the process that actually prompts.
 */
const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
Object.defineProperty(process, "stdin", {
  configurable: true,
  enumerable: descriptor.enumerable,
  get() {
    const stdin = descriptor.get.call(process);
    stdin.isTTY = true;
    return stdin;
  },
});
