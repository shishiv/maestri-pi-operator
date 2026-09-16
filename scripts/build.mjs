import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const distPath = path.join(rootPath, "dist");
const stagingPath = mkdtempSync(path.join(rootPath, ".dist-build-"));
const requiredOutputs = ["index.js", "index.d.ts", "ask-runner.mjs", "extension-cli.mjs"];

/** @param {string} directory */
function validateBuild(directory) {
	for (const output of requiredOutputs) {
		const outputPath = path.join(directory, output);
		if (!statSync(outputPath).isFile()) throw new Error(`build omitted ${output}`);
	}
}

/** @param {string} directory */
function installBuild(directory) {
	if (!existsSync(distPath)) {
		renameSync(directory, distPath);
		return;
	}
	const backupPath = `${distPath}.previous-${process.pid}`;
	renameSync(distPath, backupPath);
	try {
		renameSync(directory, distPath);
	} catch (installError) {
		try {
			renameSync(backupPath, distPath);
		} catch (restoreError) {
			throw new AggregateError([installError, restoreError], "failed to install build and restore prior dist");
		}
		throw installError;
	}
	rmSync(backupPath, { recursive: true });
}

try {
	execFileSync(process.execPath, [
		fileURLToPath(new URL("node_modules/typescript/bin/tsc", root)),
		"-p", fileURLToPath(new URL("tsconfig.build.json", root)),
		"--outDir", stagingPath,
	], { cwd: rootPath, stdio: "inherit" });
	validateBuild(stagingPath);
	installBuild(stagingPath);
} finally {
	rmSync(stagingPath, { recursive: true, force: true });
}
