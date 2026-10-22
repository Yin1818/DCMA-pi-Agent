import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeRecord } from "../../../dashboard/database/dashboard-data.ts";
import {
	analyzeThresholdEvents,
	assessDeviceState,
	checkDataQuality,
	compareMetricWindows,
	getCodeEvents,
	summarizeMetrics,
} from "../tools/analytics.ts";
import type { AnalysisWindow, MonitoringSpec, StateRuleSet } from "../tools/contracts.ts";
import { validateRange } from "../tools/contracts.ts";
import { createKnowledgeService } from "../tools/knowledge.ts";
import { createMonitoringService } from "../tools/monitoring.ts";
import { createEvidenceStore, exportReport, readReport } from "../tools/runtime-files.ts";

function window(values: (number | null)[], seconds = [0, 10, 20]): AnalysisWindow {
	return {
		table: "real_data_01",
		from: "2026-10-20T16:00:00.000Z",
		to: "2026-10-20T16:00:20.000Z",
		queriedAt: "2026-10-20T16:00:20.000Z",
		invalidTimeRows: 0,
		excludedIdentityRows: 0,
		complete: true,
		availableFields: [
			"id",
			"timestamp",
			"device_name",
			"inverter_name",
			"motor_temp",
			"speed_actual",
			"fault_code",
			"alarm_code",
		],
		records: values.map((value, index) =>
			normalizeRecord({
				id: index + 1,
				timestamp: `2026-10-21 00:00:${String(seconds[index]).padStart(2, "0")}`,
				device_name: "synthetic",
				inverter_name: "synthetic",
				motor_temp: value,
				speed_actual: 100,
				fault_code: 0,
				alarm_code: 0,
			}),
		),
	};
}
const rule = {
	metric: "motor_temp" as const,
	operator: "gt" as const,
	threshold: 80,
	recoveryThreshold: 75,
	minDurationSeconds: 10,
	maxGapSeconds: 15,
	unit: "synthetic",
	source: "synthetic fixture",
};

test("explicit Beijing offsets normalize to UTC once and preserve the requested interval", () => {
	assert.deepEqual(
		validateRange({
			table: "real_data_01",
			from: "2026-10-22T00:16:32.000+08:00",
			to: "2026-10-22T00:19:32.000+08:00",
		}),
		{ table: "real_data_01", from: "2026-10-21T16:16:32.000Z", to: "2026-10-21T16:19:32.000Z" },
	);
});

test("time parsing rejects impossible calendar dates and missing timezone", () => {
	assert.throws(() =>
		validateRange({
			table: "real_data_01",
			from: "2026-02-30T00:00:00.000+08:00",
			to: "2026-03-01T00:00:00.000+08:00",
		}),
	);
	assert.throws(() =>
		validateRange({ table: "real_data_01", from: "2026-10-22T00:00:00", to: "2026-10-22T00:01:00" }),
	);
});

test("statistics include zero, ignore missing numbers and use population standard deviation", () => {
	const result = summarizeMetrics(window([0, 2, 4]), ["motor_temp"], 10);
	assert.equal(result.metrics[0].mean, 2);
	assert.ok(Math.abs(result.metrics[0].populationStdDev! - Math.sqrt(8 / 3)) < 1e-12);
	assert.equal(result.metrics[0].min, 0);
	assert.equal(result.metrics[0].max, 4);
	assert.equal(result.metrics[0].zeros, 1);
	assert.equal(result.buckets.length, 2);
	assert.deepEqual(
		result.buckets.map((bucket) => bucket.records),
		[1, 2],
	);
	assert.equal(summarizeMetrics(window([null, 2, 4]), ["motor_temp"]).metrics[0].mean, 3);
});

test("quality distinguishes missing values, duplicate timestamps and interval gaps", () => {
	const quality = checkDataQuality(window([0, null, 4], [0, 0, 20]), ["motor_temp"], 15);
	assert.equal(quality.status, "issues");
	assert.equal(quality.duplicateRows, 1);
	assert.equal(quality.gapCount, 1);
	assert.equal(quality.fields[0].missing, 1);
	assert.equal(quality.fields[0].zeros, 1);
});

test("comparison reports B minus A and leaves percentage unknown for zero baseline", () => {
	const comparison = compareMetricWindows(window([0, 0, 0]), window([2, 2, 2]), ["motor_temp"]);
	assert.equal(comparison.comparisons[0].meanDelta, 2);
	assert.equal(comparison.comparisons[0].meanChangePercent, null);
});

test("threshold duration uses observed span and recovery is distinct from missing samples", () => {
	const result = analyzeThresholdEvents(window([90, 95, 70]), rule);
	assert.equal(result.aggregate.qualifiedCount, 1);
	assert.equal(result.aggregate.qualifiedDurationSeconds, 10);
	assert.equal(result.events[0].endReason, "recovered");
	assert.equal(result.latestCondition.state, "normal");
	const missing = analyzeThresholdEvents(window([90, null, 90]), rule);
	assert.equal(missing.aggregate.qualifiedCount, 0);
	assert.equal(missing.events[1].endReason, "missing_value");
	const duplicate = analyzeThresholdEvents(window([90, 95, 96], [0, 10, 10]), rule);
	assert.equal(duplicate.latestCondition.state, "unknown");
	assert.equal(duplicate.aggregate.qualifiedCount, 0);
});

test("code events distinguish no events from missing fields and missing code observations", () => {
	const normal = getCodeEvents(window([0, 2, 4]));
	assert.equal(normal.faults, 0);
	const missing = window([0, 2, 4]);
	for (const record of missing.records) {
		record.raw.fault_code = "   ";
		record.raw.alarm_code = null;
	}
	const result = getCodeEvents(missing);
	assert.equal(result.status, "unknown");
	assert.equal(result.total, null);
	assert.equal(result.events.length, 0);
	missing.availableFields = ["motor_temp"];
	assert.throws(() => getCodeEvents(missing), /缺少/);
});

test("state rules cannot claim current state for historical, stale or ambiguous observations", () => {
	const data = window([0, 2, 4]);
	const rules: StateRuleSet = {
		source: "synthetic fixture",
		version: "1",
		rules: [{ state: "running", all: [{ field: "speed_actual", operator: "gt", value: 50 }] }],
	};
	const now = Date.parse("2026-10-20T16:00:20.000Z");
	assert.equal(assessDeviceState(data, 60, now, rules).currentState, "running");
	assert.equal(assessDeviceState(data, 60, now + 61000, rules).currentState, "unknown");
	assert.equal(assessDeviceState({ ...data, table: "real_data" }, 60, now, rules).currentState, "unknown");
	data.records[2].raw.fault_code = null;
	rules.rules.push({ state: "fault", all: [{ field: "fault_code", operator: "gt", value: 0 }] });
	assert.equal(assessDeviceState(data, 60, now, rules).currentState, "unknown");
});

test("knowledge lookup and lexical search use isolated source data with exact version matching", async () => {
	const directory = await mkdtemp(join(tmpdir(), "dcma-knowledge-"));
	try {
		const service = createKnowledgeService(directory);
		assert.equal((await service.getDeviceProfile("real_data_01")).configured, false);
		await writeFile(
			join(directory, "profiles.json"),
			JSON.stringify({
				profiles: [
					{
						table: "real_data_01",
						manufacturer: "Synthetic",
						model: "M1",
						version: "1",
						source: "synthetic fixture",
						units: { motor_temp: "synthetic" },
						ratedValues: { motor_temp: { value: 100, unit: "synthetic", source: "synthetic fixture" } },
					},
				],
			}),
		);
		await writeFile(
			join(directory, "knowledge.json"),
			JSON.stringify({
				entries: [
					{
						id: "synthetic",
						manufacturer: "Synthetic",
						model: "M1",
						version: "1",
						kind: "manual",
						text: "合成测试资料：温度过高时检查散热。",
						source: { title: "synthetic", locator: "fixture paragraph 1", revision: "1" },
						codes: [{ kind: "fault", code: "F_TEST", meaning: "合成测试故障", steps: ["仅用于离线验收"] }],
					},
				],
			}),
		);
		const profile = await service.getDeviceProfile("real_data_01");
		assert.equal(profile.manufacturer, "Synthetic");
		assert.equal(profile.ratedValues?.motor_temp?.value, 100);
		const input = { manufacturer: "Synthetic", model: "M1", version: "1", kind: "fault" as const, code: "F_TEST" };
		assert.equal((await service.lookupFaultCode(input)).matches[0].meaning, "合成测试故障");
		assert.equal((await service.lookupFaultCode({ ...input, version: "2" })).found, false);
		const search = await service.searchMaintenanceKnowledge({ query: "温度过高", model: "M1" });
		assert.ok(search.matches[0].excerpt.includes("温度过高"));
		assert.equal(search.matches[0].source.locator, "fixture paragraph 1");
		await writeFile(join(directory, "profiles.json"), "{}");
		await assert.rejects(service.getDeviceProfile("real_data_01"), /配置或查询无效/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("reports reference real current-turn evidence and reject paths and symlinks", async () => {
	const directory = await mkdtemp(join(tmpdir(), "dcma-report-"));
	try {
		const store = createEvidenceStore();
		const record = store.add("summarize_metrics", { metric: "synthetic" }, { mean: 2 });
		const report = await exportReport(directory, "合成测试报告", store.get([record.id]));
		const saved = JSON.parse(await readReport(directory, `${report.reportId}.json`)) as {
			records: { result: { mean: number } }[];
		};
		assert.equal(saved.records[0].result.mean, 2);
		assert.throws(() => createEvidenceStore().get([record.id]), /不属于本轮/);
		await assert.rejects(readReport(directory, "../profiles.json"), /编号无效/);
		const target = join(directory, "report-11111111-1111-4111-8111-111111111111.json");
		await symlink(join(directory, `report-${report.reportId}.json`), target);
		await assert.rejects(readReport(directory, "11111111-1111-4111-8111-111111111111.json"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("monitor proposals do not activate tasks, explicit confirmation persists and prevents replay", async () => {
	const directory = await mkdtemp(join(tmpdir(), "dcma-monitor-"));
	const service = createMonitoringService(directory, async () => ({ state: "unknown", evidence: {} }));
	try {
		const spec: MonitoringSpec = {
			table: "real_data_01",
			intervalSeconds: 60,
			windowSeconds: 300,
			staleAfterSeconds: 120,
			rule,
		};
		const proposal = (await service.manage({ action: "create", spec })) as { proposal: { id: string } };
		assert.deepEqual(((await service.manage({ action: "list" })) as { tasks: unknown[] }).tasks, []);
		await service.confirmProposal(proposal.proposal.id);
		await assert.rejects(service.confirmProposal(proposal.proposal.id), /已过期或已使用/);
		const stored = JSON.parse(await readFile(join(directory, "monitoring.json"), "utf8")) as {
			tasks: { status: string }[];
		};
		assert.equal(stored.tasks[0].status, "active");
		assert.equal(((await service.getAlerts({})) as { total: number }).total, 0);
		const listed = (await service.manage({ action: "list" })) as { tasks: { id: string }[] };
		for (const action of ["pause", "resume", "update"] as const) {
			const change = (await service.manage({
				action,
				taskId: listed.tasks[0].id,
				...(action === "update" ? { spec: { ...spec, intervalSeconds: 30 } } : {}),
			})) as { proposal: { id: string } };
			const confirmed = (await service.confirmProposal(change.proposal.id)) as {
				task: { status: string; spec: MonitoringSpec };
			};
			assert.equal(confirmed.task.status, action === "pause" ? "paused" : "active");
			if (action === "update") assert.equal(confirmed.task.spec.intervalSeconds, 30);
		}
	} finally {
		await service.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

test("persisted monitor worker records alerts, preserves unknown and recovers with evidence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "dcma-worker-"));
	let service = createMonitoringService(directory, async () => ({ state: "alert", evidence: { fixture: true } }));
	try {
		const created = (await service.manage({
			action: "create",
			spec: { table: "real_data_01", intervalSeconds: 60, windowSeconds: 300, staleAfterSeconds: 120, rule },
		})) as { proposal: { id: string } };
		await service.confirmProposal(created.proposal.id);
		await service.stop();
		for (const state of ["alert", "unknown", "unknown", "normal"] as const) {
			service = createMonitoringService(directory, async () => ({ state, evidence: { fixture: true } }));
			service.start();
			// list is serialized after the immediate startup tick; no timer or real database is needed.
			await service.manage({ action: "list" });
			const result = (await service.getAlerts({})) as {
				alerts: { state: string; closedReason?: string; recoveryEvidence?: unknown }[];
				total: number;
			};
			assert.equal(result.total, state === "alert" ? 1 : 2);
			assert.equal(result.alerts.filter((entry) => entry.state === "active").length, state === "normal" ? 0 : 1);
			if (state === "normal") {
				const recovered = result.alerts.find((entry) => entry.state === "recovered");
				assert.equal(recovered?.closedReason, "condition_recovered");
				assert.deepEqual(recovered?.recoveryEvidence, { fixture: true });
			}
			await service.stop();
		}
	} finally {
		await service.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
