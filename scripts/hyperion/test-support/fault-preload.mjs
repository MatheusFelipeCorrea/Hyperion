/**
 * Test support: make `child_process.spawnSync` throw, to exercise a CLI's top-level
 * error handler (`main().catch(...)`). Load with `node --import <file-url of this>`.
 *
 * HYPERION_FAULT_ENTRY  optional entry-script basename (e.g. "setup.mjs"): only that
 *                       process is affected — handy when loaded via NODE_OPTIONS.
 */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const only = process.env.HYPERION_FAULT_ENTRY;
if (!only || path.basename(process.argv[1] || "") === only) {
  childProcess.spawnSync = () => {
    throw new Error("injected spawnSync failure");
  };
  syncBuiltinESMExports();
}
