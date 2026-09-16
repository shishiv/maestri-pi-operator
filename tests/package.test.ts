import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function buildFixture(t: TestContext, compiler: string) {
	const root = await mkdtemp(path.join(tmpdir(), "mpo-build-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "scripts"));
	await mkdir(path.join(root, "dist"));
	await mkdir(path.join(root, "node_modules/typescript/bin"), { recursive: true });
	await copyFile(new URL("../scripts/build.mjs", import.meta.url), path.join(root, "scripts/build.mjs"));
	await writeFile(path.join(root, "tsconfig.build.json"), "{}\n");
	await writeFile(path.join(root, "dist/healthy.txt"), "prior dist\n");
	await writeFile(path.join(root, "node_modules/typescript/bin/tsc"), compiler);
	return root;
}

test("ships the Firstmate process-event adapter manifest", async () => {
	const manifest = JSON.parse(await readFile(new URL("../firstmate-extension.json", import.meta.url), "utf8"));
	const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	assert.deepEqual(manifest, {
		schema: "firstmate.extension-manifest.v1",
		id: "org.maestri.pi-operator",
		version: packageManifest.version,
		host_protocols: [1],
		entrypoint: "bin/mpo-extension",
		capabilities: [{ name: "process-event-adapter", versions: [1], adapter_names: ["maestri-ask"] }],
		required_consents: ["credential-store"],
	});
	assert.equal((await stat(new URL("../bin/mpo-extension", import.meta.url))).mode & 0o111, 0o111);
});

test("failed compilation preserves the prior distributable", async (t) => {
	const root = await buildFixture(t, `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const output = process.argv[process.argv.indexOf("--outDir") + 1];
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, "partial.js"), "invalid build\\n");
process.exitCode = 1;
`);
	await assert.rejects(exec(process.execPath, [path.join(root, "scripts/build.mjs")], { cwd: root }));
	assert.equal(await readFile(path.join(root, "dist/healthy.txt"), "utf8"), "prior dist\n");
	assert.deepEqual((await readdir(root)).filter((entry) => entry.startsWith(".dist-build-") || entry.startsWith("dist.previous-")), []);
});

test("a complete staged build replaces dist", async (t) => {
	const root = await buildFixture(t, `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const output = process.argv[process.argv.indexOf("--outDir") + 1];
mkdirSync(output, { recursive: true });
for (const file of ["index.js", "ask-runner.mjs", "extension-cli.mjs"]) writeFileSync(path.join(output, file), "export {};\\n");
writeFileSync(path.join(output, "index.d.ts"), 'export * from "./readiness.ts";\\n');
`);
	await exec(process.execPath, [path.join(root, "scripts/build.mjs")], { cwd: root });
	await assert.rejects(readFile(path.join(root, "dist/healthy.txt")));
	assert.equal(await readFile(path.join(root, "dist/index.js"), "utf8"), "export {};\n");
	assert.deepEqual((await readdir(root)).filter((entry) => entry.startsWith(".dist-build-") || entry.startsWith("dist.previous-")), []);
});
