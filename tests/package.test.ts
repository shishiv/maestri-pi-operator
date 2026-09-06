import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";

const skillNames = [
	"maestri",
	"maestri-manager",
	"maestri-portal",
	"maestri-portal-devices",
	"maestri-routines",
	"maestri-workspace",
];

test("ships Maestri skills outside static package discovery", async () => {
	const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	assert.deepEqual(manifest.pi, { extensions: ["./dist/index.js"] });
	assert.ok(manifest.files.includes("resources"));
	for (const name of skillNames) {
		await stat(new URL(`../resources/skills/${name}/SKILL.md`, import.meta.url));
	}
});

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
