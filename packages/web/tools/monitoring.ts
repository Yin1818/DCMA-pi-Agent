import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dashboardTables, numericFields } from "../../../dashboard/database/dashboard-types.ts";
import { type MonitoringSpec, type MonitorObservation, ToolInputError, validateRule } from "./contracts.ts";
import { preparePrivateDirectory } from "./runtime-files.ts";

interface Task {
	id: string;
	spec: MonitoringSpec;
	status: "active" | "paused";
	createdAt: string;
	updatedAt: string;
	lastCheckedAt: string | null;
	lastState: "alert" | "normal" | "unknown" | null;
	lastError: string | null;
}

interface Alert {
	id: string;
	taskId: string;
	state: "active" | "recovered" | "unknown";
	createdAt: string;
	updatedAt: string;
	recoveredAt: string | null;
	evidence: Record<string, unknown>;
	closedReason?: "condition_recovered" | "rule_changed";
	recoveryEvidence?: Record<string, unknown>;
	ruleSnapshot?: MonitoringSpec;
}

interface Store {
	version: 1;
	tasks: Task[];
	alerts: Alert[];
	droppedAlerts: number;
}

export interface ManageInput {
	action: "list" | "create" | "update" | "pause" | "resume";
	taskId?: string;
	spec?: MonitoringSpec;
}

interface Proposal {
	id: string;
	createdAt: string;
	expiresAt: string;
	input: ManageInput;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE = /password|passwd|secret|token|credential|authorization|cookie|api.?key|connection|dsn|raw|sql/i;

function invalid(): never {
	throw new ToolInputError("监测配置或本地记录无效。");
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function iso(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function specFrom(value: unknown): MonitoringSpec {
	if (
		!object(value) ||
		!dashboardTables.includes(value.table as MonitoringSpec["table"]) ||
		![value.intervalSeconds, value.windowSeconds, value.staleAfterSeconds].every(Number.isInteger) ||
		typeof value.intervalSeconds !== "number" ||
		value.intervalSeconds < 30 ||
		value.intervalSeconds > 86400 ||
		typeof value.windowSeconds !== "number" ||
		value.windowSeconds < 60 ||
		value.windowSeconds > 3600 ||
		typeof value.staleAfterSeconds !== "number" ||
		value.staleAfterSeconds < 30 ||
		value.staleAfterSeconds > 86400 ||
		value.intervalSeconds > value.windowSeconds ||
		!object(value.rule)
	)
		invalid();
	const rule = value.rule;
	if (
		!numericFields.includes(rule.metric as MonitoringSpec["rule"]["metric"]) ||
		(rule.operator !== "gt" && rule.operator !== "lt") ||
		typeof rule.threshold !== "number" ||
		(rule.recoveryThreshold !== undefined && typeof rule.recoveryThreshold !== "number") ||
		typeof rule.minDurationSeconds !== "number" ||
		typeof rule.maxGapSeconds !== "number" ||
		typeof rule.unit !== "string" ||
		typeof rule.source !== "string" ||
		rule.minDurationSeconds > value.windowSeconds ||
		rule.maxGapSeconds > value.windowSeconds ||
		/[\u0000-\u001f]/.test(rule.unit + rule.source) ||
		/https?:\/\/|password|secret|token|api.?key|authorization/i.test(rule.source)
	)
		invalid();
	const result: MonitoringSpec = {
		table: value.table as MonitoringSpec["table"],
		intervalSeconds: value.intervalSeconds,
		windowSeconds: value.windowSeconds,
		staleAfterSeconds: value.staleAfterSeconds,
		rule: {
			metric: rule.metric as MonitoringSpec["rule"]["metric"],
			operator: rule.operator,
			threshold: rule.threshold,
			minDurationSeconds: rule.minDurationSeconds,
			maxGapSeconds: rule.maxGapSeconds,
			unit: rule.unit,
			source: rule.source,
			...(rule.recoveryThreshold === undefined ? {} : { recoveryThreshold: rule.recoveryThreshold }),
		},
	};
	try {
		validateRule(result.rule);
	} catch {
		invalid();
	}
	return result;
}

function evidenceFrom(value: unknown): Record<string, unknown> {
	// Keep structured measurements and short labels, never database rows or connection details.
	let budget = 6000;
	function clean(item: unknown, depth: number): unknown {
		if (budget <= 0 || depth > 5) return null;
		budget -= 8;
		if (item === null || typeof item === "boolean") return item;
		if (typeof item === "number") return Number.isFinite(item) ? item : null;
		if (typeof item === "string") {
			if (
				/https?:\/\/|postgres(?:ql)?:|mysql:|bearer\s|password|secret|token|api.?key|authorization|[A-Za-z0-9_+/=-]{48,}/i.test(
					item,
				)
			)
				return "[redacted]";
			const text = item.replace(/[\u0000-\u001f]/g, " ").slice(0, Math.min(300, budget));
			budget -= Buffer.byteLength(text);
			return text;
		}
		if (Array.isArray(item)) return item.slice(0, 30).map((entry) => clean(entry, depth + 1));
		if (object(item)) {
			const result: Record<string, unknown> = {};
			for (const [key, entry] of Object.entries(item).slice(0, 40)) {
				if (budget <= 0) break;
				if (SENSITIVE.test(key) || key.length > 64 || !/^[\w\u4e00-\u9fff .-]+$/.test(key)) continue;
				budget -= Buffer.byteLength(key) + 8;
				result[key] = clean(entry, depth + 1);
			}
			return result;
		}
		return null;
	}
	const result = clean(value, 0);
	return object(result) && Buffer.byteLength(JSON.stringify(result)) <= 8192 ? result : {};
}

function storeFrom(value: unknown): Store {
	if (
		!object(value) ||
		value.version !== 1 ||
		!Array.isArray(value.tasks) ||
		value.tasks.length > 20 ||
		!Array.isArray(value.alerts) ||
		value.alerts.length > 1000 ||
		!Number.isSafeInteger(value.droppedAlerts) ||
		typeof value.droppedAlerts !== "number" ||
		value.droppedAlerts < 0
	)
		invalid();
	const ids = new Set<string>();
	const tasks: Task[] = value.tasks.map((task: unknown) => {
		if (
			!object(task) ||
			typeof task.id !== "string" ||
			!UUID.test(task.id) ||
			ids.has(task.id) ||
			(task.status !== "active" && task.status !== "paused") ||
			!iso(task.createdAt) ||
			!iso(task.updatedAt) ||
			(task.lastCheckedAt !== null && !iso(task.lastCheckedAt)) ||
			![null, "alert", "normal", "unknown"].includes(task.lastState as string | null) ||
			(task.lastError !== null && task.lastError !== "监测数据暂不可用。")
		)
			invalid();
		ids.add(task.id);
		return {
			id: task.id,
			spec: specFrom(task.spec),
			status: task.status,
			createdAt: task.createdAt,
			updatedAt: task.updatedAt,
			lastCheckedAt: task.lastCheckedAt,
			lastState: task.lastState,
			lastError: task.lastError,
		} as Task;
	});
	const alertIds = new Set<string>();
	const active = new Set<string>();
	const alerts: Alert[] = value.alerts.map((alert: unknown) => {
		if (
			!object(alert) ||
			typeof alert.id !== "string" ||
			!UUID.test(alert.id) ||
			alertIds.has(alert.id) ||
			typeof alert.taskId !== "string" ||
			!ids.has(alert.taskId) ||
			!["active", "recovered", "unknown"].includes(alert.state as string) ||
			!iso(alert.createdAt) ||
			!iso(alert.updatedAt) ||
			!object(alert.evidence) ||
			(alert.state === "recovered" ? !iso(alert.recoveredAt) : alert.recoveredAt !== null) ||
			Buffer.byteLength(JSON.stringify(alert.evidence)) > 8192 ||
			(alert.closedReason !== undefined &&
				!["condition_recovered", "rule_changed"].includes(alert.closedReason as string)) ||
			(alert.closedReason !== undefined && alert.state !== "recovered") ||
			(alert.recoveryEvidence !== undefined &&
				(!object(alert.recoveryEvidence) ||
					Buffer.byteLength(JSON.stringify(alert.recoveryEvidence)) > 8192 ||
					alert.state !== "recovered")) ||
			(alert.state === "active" && active.has(alert.taskId))
		)
			invalid();
		alertIds.add(alert.id);
		if (alert.state === "active") active.add(alert.taskId);
		return {
			id: alert.id,
			taskId: alert.taskId,
			state: alert.state,
			createdAt: alert.createdAt,
			updatedAt: alert.updatedAt,
			recoveredAt: alert.recoveredAt,
			evidence: evidenceFrom(alert.evidence),
			...(alert.closedReason === undefined ? {} : { closedReason: alert.closedReason }),
			...(alert.recoveryEvidence === undefined ? {} : { recoveryEvidence: evidenceFrom(alert.recoveryEvidence) }),
			...(alert.ruleSnapshot === undefined ? {} : { ruleSnapshot: specFrom(alert.ruleSnapshot) }),
		} as Alert;
	});
	return { version: 1, tasks, alerts, droppedAlerts: value.droppedAlerts };
}

export function createMonitoringService(
	directory: string,
	observe: (spec: MonitoringSpec, signal: AbortSignal) => Promise<MonitorObservation>,
) {
	const file = join(directory, "monitoring.json");
	let data: Store = { version: 1, tasks: [], alerts: [], droppedAlerts: 0 };
	let loaded = false;
	let failed = false;
	let stopped = false;
	let started = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let controller: AbortController | undefined;
	let ticking = false;
	let queue: Promise<unknown> = Promise.resolve();
	const proposals = new Map<string, Proposal>();
	const due = new Map<string, number>();

	async function load(allowFailed = false): Promise<void> {
		if (failed && !(allowFailed && loaded)) throw new ToolInputError("本地监测存储不可用，请人工检查。");
		if (loaded) return;
		try {
			await preparePrivateDirectory(directory);
			let content: string;
			try {
				const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				try {
					const info = await handle.stat();
					const maximum = 12 * 1024 * 1024;
					if (!info.isFile() || info.size > maximum) invalid();
					const buffer = Buffer.alloc(maximum + 1);
					let length = 0;
					while (length < buffer.length) {
						const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
						if (bytesRead === 0) break;
						length += bytesRead;
					}
					if (length > maximum) invalid();
					content = buffer.subarray(0, length).toString("utf8");
				} finally {
					await handle.close();
				}
			} catch (error) {
				if (object(error) && error.code === "ENOENT") {
					loaded = true;
					return;
				}
				throw error;
			}
			if (Buffer.byteLength(content) > 12 * 1024 * 1024) invalid();
			data = storeFrom(JSON.parse(content) as unknown);
			loaded = true;
		} catch {
			failed = true;
			throw new ToolInputError("本地监测存储不可用，请人工检查。");
		}
	}

	function serialized<T>(operation: () => Promise<T>, allowFailed = false): Promise<T> {
		const result = queue.then(async () => {
			await load(allowFailed);
			return operation();
		});
		queue = result.catch(() => undefined);
		return result;
	}

	async function save(next: Store): Promise<void> {
		const temporary = join(directory, `.monitoring-${randomUUID()}.tmp`);
		try {
			await preparePrivateDirectory(directory);
			await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
			await rename(temporary, file);
			data = next;
		} catch {
			failed = true;
			proposals.clear();
			await unlink(temporary).catch(() => undefined);
			throw new ToolInputError("本地监测存储写入失败。");
		}
	}

	function pruneProposals(): void {
		for (const [id, proposal] of proposals) if (Date.parse(proposal.expiresAt) <= Date.now()) proposals.delete(id);
	}

	function taskFor(input: ManageInput): Task {
		const task = data.tasks.find((entry) => entry.id === input.taskId);
		if (!task) throw new ToolInputError("监测任务不存在。");
		return task;
	}

	function validateInput(input: ManageInput): ManageInput {
		if (!object(input) || !["list", "create", "update", "pause", "resume"].includes(input.action)) invalid();
		if (input.action === "list") return { action: "list" };
		if (input.action === "create") {
			if (data.tasks.length >= 20) throw new ToolInputError("最多允许20个监测任务。");
			return { action: "create", spec: specFrom(input.spec) };
		}
		if (typeof input.taskId !== "string" || !UUID.test(input.taskId)) invalid();
		taskFor(input);
		return {
			action: input.action,
			taskId: input.taskId,
			...(input.action === "update" ? { spec: specFrom(input.spec) } : {}),
		};
	}

	function record(next: Store, task: Task, observation: MonitorObservation, now: string): void {
		const evidence = evidenceFrom(observation.evidence);
		const active = next.alerts.find((entry) => entry.taskId === task.id && entry.state === "active");
		if (observation.state === "alert") {
			if (active) active.updatedAt = now;
			else
				next.alerts.push({
					id: randomUUID(),
					taskId: task.id,
					state: "active",
					createdAt: now,
					updatedAt: now,
					recoveredAt: null,
					evidence,
					ruleSnapshot: structuredClone(task.spec),
				});
		} else if (observation.state === "normal" && active) {
			active.state = "recovered";
			active.updatedAt = now;
			active.recoveredAt = now;
			active.closedReason = "condition_recovered";
			active.recoveryEvidence = evidence;
		} else if (observation.state === "unknown" && task.lastState !== "unknown") {
			next.alerts.push({
				id: randomUUID(),
				taskId: task.id,
				state: "unknown",
				createdAt: now,
				updatedAt: now,
				recoveredAt: null,
				evidence,
			});
		}
		task.lastCheckedAt = now;
		task.lastState = observation.state;
		task.lastError = observation.state === "unknown" ? "监测数据暂不可用。" : null;
		while (next.alerts.length > 1000) {
			const index = next.alerts.findIndex((entry) => entry.state !== "active");
			next.alerts.splice(index < 0 ? 0 : index, 1);
			next.droppedAlerts++;
		}
	}

	function tick(): void {
		if (stopped || failed || ticking) return;
		ticking = true;
		void serialized(async () => {
			for (const task of data.tasks.slice().sort((a, b) => (due.get(a.id) ?? 0) - (due.get(b.id) ?? 0))) {
				if (stopped) break;
				if (task.status !== "active" || (due.get(task.id) ?? 0) > Date.now()) continue;
				due.set(task.id, Date.now() + task.spec.intervalSeconds * 1000);
				controller = new AbortController();
				let observation: MonitorObservation;
				try {
					const result = await observe(structuredClone(task.spec), controller.signal);
					observation =
						object(result) && ["alert", "normal", "unknown"].includes(result.state) && object(result.evidence)
							? result
							: { state: "unknown", evidence: {} };
				} catch {
					observation = { state: "unknown", evidence: {} };
				}
				controller = undefined;
				if (stopped) break;
				const next = structuredClone(data);
				const current = next.tasks.find((entry) => entry.id === task.id);
				if (current) record(next, current, observation, new Date().toISOString());
				await save(next);
				due.set(task.id, Date.now() + task.spec.intervalSeconds * 1000);
				break;
			}
		})
			.catch(() => undefined)
			.finally(() => {
				ticking = false;
			});
	}

	return {
		start(): void {
			if (started || stopped) return;
			started = true;
			timer = setInterval(tick, 1000);
			timer.unref();
			tick();
		},
		async stop(): Promise<void> {
			stopped = true;
			if (timer) clearInterval(timer);
			controller?.abort();
			proposals.clear();
			await queue;
		},
		manage(input: ManageInput, signal?: AbortSignal): Promise<unknown> {
			return serialized(
				async () => {
					signal?.throwIfAborted();
					const safe = validateInput(input);
					if (safe.action === "list")
						return {
							tasks: structuredClone(data.tasks),
							total: data.tasks.length,
							serviceError: failed ? "本地监测存储不可用，监测已停止，请人工检查。" : null,
						};
					if (failed) throw new ToolInputError("本地监测存储不可用，请人工检查。");
					if (stopped) throw new ToolInputError("监测服务已停止。");
					pruneProposals();
					if (proposals.size >= 100) throw new ToolInputError("待确认操作过多，请稍后重试。");
					const id = randomUUID();
					const proposal: Proposal = {
						id,
						createdAt: new Date().toISOString(),
						expiresAt: new Date(Date.now() + 600000).toISOString(),
						input: safe,
					};
					proposals.set(id, proposal);
					return {
						status: "pending_confirmation",
						proposal: structuredClone(proposal),
						approvalPath: `/api/monitoring/confirm/${id}`,
					};
				},
				object(input) && input.action === "list",
			);
		},
		getAlerts(
			input: {
				taskId?: string;
				state?: "active" | "recovered" | "unknown" | "all";
				limit?: number;
			},
			signal?: AbortSignal,
		): Promise<unknown> {
			return serialized(async () => {
				signal?.throwIfAborted();
				if (
					!object(input) ||
					(input.taskId !== undefined && (typeof input.taskId !== "string" || !UUID.test(input.taskId))) ||
					(input.state !== undefined && !["active", "recovered", "unknown", "all"].includes(input.state)) ||
					(input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 5 || input.limit > 100))
				)
					invalid();
				const alerts = data.alerts.filter(
					(entry) =>
						(!input.taskId || entry.taskId === input.taskId) &&
						(!input.state || input.state === "all" || entry.state === input.state),
				);
				return {
					alerts: structuredClone(
						alerts
							.slice()
							.reverse()
							.slice(0, input.limit ?? 50),
					),
					total: alerts.length,
					droppedAlerts: data.droppedAlerts,
					serviceError: failed ? "本地监测存储不可用，监测已停止，请人工检查。" : null,
				};
			}, true);
		},
		getProposal(id: string): unknown | undefined {
			pruneProposals();
			const proposal = proposals.get(id);
			return proposal ? structuredClone(proposal) : undefined;
		},
		confirmProposal(id: string): Promise<unknown> {
			return serialized(async () => {
				if (stopped) throw new ToolInputError("监测服务已停止。");
				pruneProposals();
				const proposal = proposals.get(id);
				if (!proposal) throw new ToolInputError("确认请求已过期或已使用。");
				proposals.delete(id);
				const input = validateInput(proposal.input);
				const next = structuredClone(data);
				const now = new Date().toISOString();
				let task: Task;
				if (input.action === "create") {
					task = {
						id: randomUUID(),
						spec: specFrom(input.spec),
						status: "active",
						createdAt: now,
						updatedAt: now,
						lastCheckedAt: null,
						lastState: null,
						lastError: null,
					};
					next.tasks.push(task);
				} else {
					const existing = next.tasks.find((entry) => entry.id === input.taskId);
					if (!existing) invalid();
					task = existing;
					if (input.action === "update") {
						for (const alert of next.alerts) {
							if (alert.taskId !== task.id || alert.state !== "active") continue;
							alert.state = "recovered";
							alert.closedReason = "rule_changed";
							alert.recoveredAt = now;
							alert.updatedAt = now;
							alert.ruleSnapshot ??= structuredClone(task.spec);
						}
						task.spec = specFrom(input.spec);
						task.lastState = null;
						task.lastCheckedAt = null;
						task.lastError = null;
					}
					if (input.action === "pause") task.status = "paused";
					if (input.action === "resume") task.status = "active";
					task.updatedAt = now;
				}
				await save(next);
				due.delete(task.id);
				return { status: "confirmed", task: structuredClone(task) };
			});
		},
	};
}
