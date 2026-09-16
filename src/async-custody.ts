import type { AskRequestRecord } from "./ask-store.ts";
import { readProcessIdentity, sameIdentity } from "./ask-store.ts";

export type AsyncRunner = NonNullable<AskRequestRecord["runner"]>;
export type ProcessGroupStatus = "alive" | "gone" | "unknown";
export type RunnerIdentityStatus = "verified" | "missing" | "mismatch" | "unreadable";

export interface RunnerInspection {
	identityStatus: RunnerIdentityStatus;
	groupStatus: ProcessGroupStatus;
	runner?: AsyncRunner;
}

function hasErrno(error: Error, code: string): boolean {
	return "code" in error && error.code === code;
}

export function processGroupStatus(pgid: number): ProcessGroupStatus {
	try {
		process.kill(-pgid, 0);
		return "alive";
	} catch (caught) {
		return caught instanceof Error && hasErrno(caught, "ESRCH") ? "gone" : "unknown";
	}
}

export async function inspectLaunchedRunner(
	pid: number | undefined,
	readIdentity: typeof readProcessIdentity,
): Promise<RunnerInspection> {
	if (!pid) return { identityStatus: "missing", groupStatus: "gone" };
	try {
		const current = await readIdentity(pid);
		if (!current) return { identityStatus: "missing", groupStatus: processGroupStatus(pid) };
		if (current.pgid !== pid) return { identityStatus: "mismatch", groupStatus: processGroupStatus(pid) };
		return {
			identityStatus: "verified",
			groupStatus: "alive",
			runner: { pid, pgid: current.pgid, identity: current.identity },
		};
	} catch {
		return { identityStatus: "unreadable", groupStatus: processGroupStatus(pid) };
	}
}

export async function inspectRecordedRunner(
	runner: AsyncRunner,
	readIdentity: typeof readProcessIdentity,
): Promise<RunnerInspection> {
	try {
		const current = await readIdentity(runner.pid);
		if (!current) return { identityStatus: "missing", groupStatus: processGroupStatus(runner.pgid) };
		if (current.pgid !== runner.pgid || !sameIdentity(current.identity, runner.identity)) {
			return { identityStatus: "mismatch", groupStatus: processGroupStatus(runner.pgid) };
		}
		return { identityStatus: "verified", groupStatus: "alive", runner };
	} catch {
		return { identityStatus: "unreadable", groupStatus: processGroupStatus(runner.pgid) };
	}
}

async function waitForGroupGone(pgid: number, deadline: number, intervalMs: number): Promise<boolean> {
	while (Date.now() < deadline) {
		if (processGroupStatus(pgid) === "gone") return true;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	return processGroupStatus(pgid) === "gone";
}

function signalGroup(pgid: number, signal: NodeJS.Signals): "sent" | "gone" {
	try {
		process.kill(-pgid, signal);
		return "sent";
	} catch (caught) {
		if (caught instanceof Error && hasErrno(caught, "ESRCH")) return "gone";
		throw caught;
	}
}

export async function terminateVerifiedRunner(
	runner: AsyncRunner,
	killGraceMs: number,
	readIdentity: typeof readProcessIdentity = readProcessIdentity,
): Promise<boolean> {
	const initial = await inspectRecordedRunner(runner, readIdentity);
	if (initial.identityStatus === "missing") return initial.groupStatus === "gone";
	if (initial.identityStatus !== "verified") return false;
	if (signalGroup(runner.pgid, "SIGTERM") === "gone") return processGroupStatus(runner.pgid) === "gone";
	if (await waitForGroupGone(runner.pgid, Date.now() + killGraceMs, 50)) return true;
	const beforeKill = await inspectRecordedRunner(runner, readIdentity);
	if (beforeKill.identityStatus !== "verified") return false;
	if (signalGroup(runner.pgid, "SIGKILL") === "gone") return processGroupStatus(runner.pgid) === "gone";
	return waitForGroupGone(runner.pgid, Date.now() + 5_000, 25);
}
