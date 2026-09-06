import { watch, type FSWatcher } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	atomicWriteRecord,
	ensureAskStateRoot,
	listRequests,
	readProcessIdentity,
	readRequest,
	sameIdentity,
	type ProcessIdentity,
	withRequestLock,
} from "./ask-store.ts";
import { canonicalJson, terminalEnvelope } from "./ask-terminal.ts";

export interface AskNotifierOptions {
	env?: Environment;
	readIdentity?: typeof readProcessIdentity;
	watch?: (path: string, listener: () => void) => Pick<FSWatcher, "close">;
	owner?: { pid: number; identity: ProcessIdentity };
}

type Environment = Readonly<Record<string, string | undefined>>;
type NotifierContext = { isIdle(): boolean };

class AskNotifier {
	private readonly attempted = new Set<string>();
	private readonly failed = new Set<string>();
	private readonly pi: ExtensionAPI;
	private readonly ctx: NotifierContext;
	private readonly root: string;
	private readonly owner: { pid: number; identity: ProcessIdentity };
	private readonly readIdentity: typeof readProcessIdentity;
	private readonly watchFactory: NonNullable<AskNotifierOptions["watch"]>;
	private readonly reportFailure: () => void;
	private watcher: Pick<FSWatcher, "close"> | null = null;
	private timer: NodeJS.Timeout | null = null;
	private scanning: Promise<void> | null = null;
	private rescanRequested = false;
	private stopped = false;
	private failureReported = false;

	constructor(
		pi: ExtensionAPI,
		ctx: NotifierContext,
		root: string,
		owner: { pid: number; identity: ProcessIdentity },
		readIdentity: typeof readProcessIdentity,
		watchFactory: NonNullable<AskNotifierOptions["watch"]>,
		reportFailure: () => void,
	) {
		this.pi = pi;
		this.ctx = ctx;
		this.root = root;
		this.owner = owner;
		this.readIdentity = readIdentity;
		this.watchFactory = watchFactory;
		this.reportFailure = reportFailure;
	}

	start(): void {
		this.watcher = this.watchFactory(this.root, () => this.schedule());
	}

	schedule(): void {
		if (this.stopped || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.scan();
		}, 25);
	}

	async scan(): Promise<void> {
		if (this.stopped || !this.ctx.isIdle()) return;
		if (this.scanning) {
			this.rescanRequested = true;
			return;
		}
		let finish = () => {};
		this.scanning = new Promise<void>((resolve) => { finish = resolve; });
		try {
			for (const record of (await listRequests(this.root)).slice(0, 256)) {
				if (this.stopped || !this.ctx.isIdle()) return;
				if (record.phase !== "terminal" || record.notification.state === "acked" || record.notification.state === "dispatching") continue;
				const key = `${record.request_id}:${terminalEnvelope(record).digest}`;
				if (this.attempted.has(key)) continue;
				const claimed = await this.claim(record.request_id);
				if (!claimed) continue;
				// Lock/identity IO can outlive idle or session shutdown. A claim is not a send.
				if (this.stopped || !this.ctx.isIdle()) return;
				const envelope = terminalEnvelope(claimed);
				await this.markDispatching(claimed.request_id, envelope.digest);
				if (this.stopped || !this.ctx.isIdle()) {
					await this.markFailed(claimed.request_id, envelope.digest);
					continue;
				}
				this.attempted.add(`${claimed.request_id}:${envelope.digest}`);
				try {
					this.pi.sendMessage({
						customType: "mpo.ask-terminal",
						content: canonicalJson({
							schema: "mpo.ask-terminal-followup.v1",
							request_id: claimed.request_id,
							digest: envelope.digest,
							next_action: "Call maestri_ask_request with action=result and this request_id, once. Do not resend the prompt.",
						}),
						display: true,
						details: { request_id: claimed.request_id, digest: envelope.digest },
					}, { deliverAs: "followUp", triggerTurn: true });
				} catch {
					this.failed.add(key);
					await this.markFailed(claimed.request_id, envelope.digest);
					continue;
				}
				await this.markSent(claimed.request_id, envelope.digest);
			}
			this.failureReported = false;
		} catch {
			// Scheduled scans have no awaiting Pi event handler to contain a rejection.
			if (!this.stopped && !this.failureReported) {
				this.failureReported = true;
				this.reportFailure();
			}
		} finally {
			this.scanning = null;
			finish();
			if (this.rescanRequested) {
				this.rescanRequested = false;
				this.schedule();
			}
		}
	}

	retryFailed(): void {
		for (const key of this.failed) this.attempted.delete(key);
		this.failed.clear();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.watcher?.close();
		this.watcher = null;
		// A sent notification still needs its durable write before session teardown.
		await this.scanning;
	}

	private async claim(requestId: string) {
		return withRequestLock(this.root, requestId, async () => {
			const record = await readRequest(this.root, requestId);
			if (record.phase !== "terminal" || record.notification.state === "acked" || record.notification.state === "dispatching") return null;
			const digest = terminalEnvelope(record).digest;
			const claim = record.notification.claim;
			if (claim && (claim.pid !== this.owner.pid || !sameIdentity(claim.identity, this.owner.identity))) {
				let current: Awaited<ReturnType<typeof readProcessIdentity>>;
				try {
					current = await this.readIdentity(claim.pid);
				} catch {
					return null;
				}
				if (current && sameIdentity(current.identity, claim.identity)) return null;
			}
			const claimed = {
				...record,
				notification: {
					...record.notification,
					digest,
					claim: this.owner,
				},
			};
			await atomicWriteRecord(this.root, claimed);
			return claimed;
		});
	}

	private async markDispatching(requestId: string, digest: string): Promise<void> {
		await withRequestLock(this.root, requestId, async () => {
			const record = await readRequest(this.root, requestId);
			if (record.notification.state === "acked" || record.notification.digest !== digest) return;
			await atomicWriteRecord(this.root, {
				...record,
				notification: {
					...record.notification,
					state: "dispatching",
				},
			});
		});
	}

	private async markSent(requestId: string, digest: string): Promise<void> {
		await withRequestLock(this.root, requestId, async () => {
			const record = await readRequest(this.root, requestId);
			if (record.notification.state === "acked" || record.notification.digest !== digest) return;
			await atomicWriteRecord(this.root, {
				...record,
				notification: {
					...record.notification,
					state: "sent",
					sent_at: new Date().toISOString(),
					attempts: record.notification.attempts + 1,
				},
			});
		});
	}

	private async markFailed(requestId: string, digest: string): Promise<void> {
		await withRequestLock(this.root, requestId, async () => {
			const record = await readRequest(this.root, requestId);
			if (record.notification.state === "acked" || record.notification.digest !== digest) return;
			await atomicWriteRecord(this.root, {
				...record,
				notification: {
					...record.notification,
					state: "pending",
					attempts: record.notification.attempts + 1,
					claim: null,
				},
			});
		});
	}
}

export function registerAskNotifier(pi: ExtensionAPI, options: AskNotifierOptions = {}): void {
	const env = options.env ?? process.env;
	const readIdentity = options.readIdentity ?? readProcessIdentity;
	const watchFactory = options.watch ?? ((path, listener) => watch(path, listener));
	let notifier: AskNotifier | null = null;

	pi.on("session_start", async (_event, ctx) => {
		await notifier?.stop();
		const root = await ensureAskStateRoot(env).catch(() => null);
		if (!root) return;
		const owner = options.owner ?? await readIdentity(process.pid).then((identity) => identity
			? { pid: process.pid, identity: identity.identity }
			: null).catch(() => null);
		if (!owner) return;
		notifier = new AskNotifier(pi, ctx, root, owner, readIdentity, watchFactory, () => {
			const message = "Maestri reply notifications could not read or update the request journal. Inspect the original request IDs with maestri_ask_request; do not resend prompts. Notification checks resume on the next event.";
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else console.error(message);
		});
		notifier.start();
		await notifier.scan();
	});

	pi.on("agent_end", async () => {
		await notifier?.scan();
	});

	// agent_end may still be busy while Pi retries, compacts, or drains follow-ups.
	// settled is the idle edge; scan still checks for a run started by another extension.
	pi.on("agent_settled", async () => {
		notifier?.retryFailed();
		await notifier?.scan();
	});

	pi.on("session_shutdown", async () => {
		await notifier?.stop();
		notifier = null;
	});
}
