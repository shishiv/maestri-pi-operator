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
	private readonly pi: ExtensionAPI;
	private readonly ctx: NotifierContext;
	private readonly root: string;
	private readonly owner: { pid: number; identity: ProcessIdentity };
	private readonly readIdentity: typeof readProcessIdentity;
	private readonly watchFactory: NonNullable<AskNotifierOptions["watch"]>;
	private watcher: Pick<FSWatcher, "close"> | null = null;
	private timer: NodeJS.Timeout | null = null;
	private scanning = false;
	private stopped = false;

	constructor(
		pi: ExtensionAPI,
		ctx: NotifierContext,
		root: string,
		owner: { pid: number; identity: ProcessIdentity },
		readIdentity: typeof readProcessIdentity,
		watchFactory: NonNullable<AskNotifierOptions["watch"]>,
	) {
		this.pi = pi;
		this.ctx = ctx;
		this.root = root;
		this.owner = owner;
		this.readIdentity = readIdentity;
		this.watchFactory = watchFactory;
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
		if (this.stopped || this.scanning || !this.ctx.isIdle()) return;
		this.scanning = true;
		try {
			for (const record of (await listRequests(this.root)).slice(0, 256)) {
				if (record.phase !== "terminal" || record.notification.state === "acked") continue;
				const key = `${record.request_id}:${record.notification.digest ?? "pending"}`;
				if (this.attempted.has(key)) continue;
				const claimed = await this.claim(record.request_id);
				if (!claimed) continue;
				const envelope = terminalEnvelope(claimed);
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
					await this.markSent(claimed.request_id, envelope.digest);
				} catch {
					await this.markFailed(claimed.request_id, envelope.digest);
				}
			}
		} finally {
			this.scanning = false;
		}
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.watcher?.close();
		this.watcher = null;
	}

	private async claim(requestId: string) {
		return withRequestLock(this.root, requestId, async () => {
			const record = await readRequest(this.root, requestId);
			if (record.phase !== "terminal" || record.notification.state === "acked") return null;
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
		notifier?.stop();
		const root = await ensureAskStateRoot(env).catch(() => null);
		if (!root) return;
		const owner = options.owner ?? await readIdentity(process.pid).then((identity) => identity
			? { pid: process.pid, identity: identity.identity }
			: null).catch(() => null);
		if (!owner) return;
		notifier = new AskNotifier(pi, ctx, root, owner, readIdentity, watchFactory);
		notifier.start();
		await notifier.scan();
	});

	pi.on("agent_end", async () => {
		await notifier?.scan();
	});

	pi.on("session_shutdown", async () => {
		notifier?.stop();
		notifier = null;
	});
}
