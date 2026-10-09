/**
 * Shared CLI option parsing for the kit scripts.
 */
import { resolve } from "node:path";

export class CliArgError extends Error {}

/**
 * Value of `<flag> <value>` or `<flag>=<value>` in `argv`, or null when the flag is absent.
 * Throws CliArgError when the flag has no value or the next token is another option
 * (`--root --check` must not treat `--check` as the directory).
 */
export function optionValue(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1);
      if (!value) throw new CliArgError(`${flag}= needs a value`);
      return value;
    }
    if (arg === flag) {
      const value = argv[i + 1];
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new CliArgError(`${flag} needs a value${value ? ` (got option "${value}")` : ""}`);
      }
      return value;
    }
  }
  return null;
}

/** `--root <dir>` / `--root=<dir>` resolved against the cwd, or `fallback` when the flag is absent. */
export function parseRootArg(argv, fallback = null) {
  const value = optionValue(argv, "--root");
  return value === null ? fallback : resolve(value);
}

/** parseRootArg over process.argv; a malformed `--root` prints the reason and exits 2. */
export function rootArg(fallback = null, argv = process.argv.slice(2)) {
  try {
    return parseRootArg(argv, fallback);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(2);
  }
}
