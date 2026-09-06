import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
rmSync(new URL("dist/", root), { recursive: true, force: true });
execFileSync(process.execPath, [
	fileURLToPath(new URL("node_modules/typescript/bin/tsc", root)),
	"-p", fileURLToPath(new URL("tsconfig.build.json", root)),
], { cwd: fileURLToPath(root), stdio: "inherit" });
