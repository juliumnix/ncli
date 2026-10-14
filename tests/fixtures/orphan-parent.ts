// Stand-in for the bunx re-exec parent in src/index.ts: supervise argv as the child.
import { superviseChild } from "../../src/shutdown";

process.exit(await superviseChild(process.argv.slice(2), process.env));
