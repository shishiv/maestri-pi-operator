import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";

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
