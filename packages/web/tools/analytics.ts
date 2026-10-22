import { createCodeHistory } from "../../../dashboard/database/code-events.ts";
import { finiteNumber } from "../../../dashboard/database/dashboard-data.ts";
import {
	type DashboardRecord,
	dashboardTables,
	fieldLabels,
	type NumericField,
	numericFields,
} from "../../../dashboard/database/dashboard-types.ts";
import {
	type AnalysisWindow,
	type StateRuleSet,
	type ThresholdRule,
	ToolInputError,
	validateRange,
	validateRule,
} from "./contracts.ts";

function finite(value: number): number | null {
	return Number.isFinite(value) ? value : null;
}

function metricValue(record: DashboardRecord, metric: NumericField): number | null {
	const value = record.values[metric];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function prepare(window: AnalysisWindow, metrics: NumericField[] = []) {
	validateRange(window);
	if (
		!dashboardTables.includes(window.table) ||
		metrics.length > numericFields.length ||
		metrics.some((metric) => !numericFields.includes(metric)) ||
		new Set(metrics).size !== metrics.length
	) {
		throw new ToolInputError("数据表或数值字段无效，字段不得重复。");
	}
	const from = Date.parse(window.from),
		to = Date.parse(window.to);
	let invalidTimeRecords = 0,
		outsideRangeRecords = 0;
	const rows: { record: DashboardRecord; time: number }[] = [];
	for (const record of window.records) {
		const time = record.acquiredAt === null ? Number.NaN : Date.parse(record.acquiredAt);
		if (!Number.isFinite(time)) invalidTimeRecords++;
		else if (time < from || time > to) outsideRangeRecords++;
		else rows.push({ record, time });
	}
	rows.sort((a, b) => a.time - b.time || a.record.id.localeCompare(b.record.id, undefined, { numeric: true }));
	const counts = new Map<number, number>();
	for (const row of rows) counts.set(row.time, (counts.get(row.time) ?? 0) + 1);
	return { rows, counts, invalidTimeRecords, outsideRangeRecords };
}

function scope(window: AnalysisWindow) {
	const times = window.records
		.flatMap((record) =>
			record.acquiredAt && Number.isFinite(Date.parse(record.acquiredAt)) ? [record.acquiredAt] : [],
		)
		.sort();
	return {
		schema: "dcma",
		timeInterpretation: "Asia/Shanghai_provisional",
		unitsVerified: false,
		coverage: { firstSampleAt: times[0] ?? null, lastSampleAt: times.at(-1) ?? null, timeValidRecords: times.length },
		table: window.table,
		from: window.from,
		to: window.to,
		queriedAt: window.queriedAt,
		kind: window.table === "real_data" ? "acquired" : "simulation",
		complete: window.complete,
		availableFields: window.availableFields,
		excludedIdentityRows: window.excludedIdentityRows,
	};
}

function positiveSeconds(value: number, name: string): void {
	if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(value * 1000)) {
		throw new ToolInputError(`${name}必须是有限正数。`);
	}
}

export function checkDataQuality(window: AnalysisWindow, metrics: NumericField[], maxGapSeconds: number) {
	positiveSeconds(maxGapSeconds, "最大采样间隔");
	const data = prepare(window, metrics);
	const times = [...data.counts.keys()];
	const leadingGapSeconds = times.length ? (times[0] - Date.parse(window.from)) / 1000 : null;
	const trailingGapSeconds = times.length ? (Date.parse(window.to) - times[times.length - 1]) / 1000 : null;
	const gaps: { from: string; to: string; seconds: number }[] = [];
	let gapCount = 0,
		largestGapSeconds: number | null = null;
	for (let i = 1; i < times.length; i++) {
		const seconds = (times[i] - times[i - 1]) / 1000;
		largestGapSeconds = Math.max(largestGapSeconds ?? 0, seconds);
		if (seconds > maxGapSeconds) {
			gapCount++;
			if (gaps.length < 20)
				gaps.push({ from: new Date(times[i - 1]).toISOString(), to: new Date(times[i]).toISOString(), seconds });
		}
	}
	let duplicateTimestamps = 0,
		duplicateRows = 0;
	for (const count of data.counts.values()) {
		if (count > 1) {
			duplicateTimestamps++;
			duplicateRows += count - 1;
		}
	}
	const fields = metrics.map((metric) => {
		let missing = 0,
			zeros = 0;
		for (const { record } of data.rows) {
			const value = metricValue(record, metric);
			if (value === null) missing++;
			else if (value === 0) zeros++;
		}
		return {
			metric,
			fieldAvailable: window.availableFields.includes(metric),
			valid: data.rows.length - missing,
			missing,
			zeros,
			missingFraction: data.rows.length ? missing / data.rows.length : null,
		};
	});
	return {
		...scope(window),
		status:
			data.rows.length === 0
				? "unknown"
				: gapCount ||
						(leadingGapSeconds !== null && leadingGapSeconds > maxGapSeconds) ||
						(trailingGapSeconds !== null && trailingGapSeconds > maxGapSeconds) ||
						window.excludedIdentityRows ||
						duplicateRows ||
						fields.some((field) => field.missing > 0) ||
						window.invalidTimeRows ||
						data.invalidTimeRecords
					? "issues"
					: "ok",
		records: data.rows.length,
		invalidTimeRowsInSource: window.invalidTimeRows,
		invalidTimeRangeAttribution: "unknown",
		invalidTimeRecords: data.invalidTimeRecords,
		outsideRangeRecords: data.outsideRangeRecords,
		duplicateTimestamps,
		duplicateRows,
		maxGapSeconds,
		largestGapSeconds,
		gapCount,
		leadingGapSeconds,
		trailingGapSeconds,
		boundaryCoverageMeaning: "无端点采样不一定是采集失败，需结合预期采样周期确认",
		gaps,
		gapsTruncated: gapCount > gaps.length,
		fields,
	};
}

function statistics(rows: ReturnType<typeof prepare>["rows"], counts: Map<number, number>, metric: NumericField) {
	let count = 0,
		missing = 0,
		zeros = 0,
		minimum: number | null = null,
		maximum: number | null = null,
		scale = 0;
	let first: { at: string; value: number; time: number } | null = null;
	let last: { at: string; value: number; time: number } | null = null;
	for (const { record, time } of rows) {
		const value = metricValue(record, metric);
		if (value === null) {
			missing++;
			continue;
		}
		count++;
		if (value === 0) zeros++;
		minimum = minimum === null ? value : Math.min(minimum, value);
		maximum = maximum === null ? value : Math.max(maximum, value);
		scale = Math.max(scale, Math.abs(value));
		if (counts.get(time) === 1) {
			last = { at: new Date(time).toISOString(), value, time };
			first ??= last;
		}
	}
	let normalizedMean = 0,
		normalizedSquares = 0,
		seen = 0;
	if (scale > 0) {
		for (const { record } of rows) {
			const value = metricValue(record, metric);
			if (value === null) continue;
			seen++;
			const normalized = value / scale;
			const delta = normalized - normalizedMean;
			normalizedMean += delta / seen;
			normalizedSquares += delta * (normalized - normalizedMean);
		}
	}
	const durationSeconds = first && last ? (last.time - first.time) / 1000 : 0;
	return {
		metric,
		count,
		missing,
		zeros,
		mean: count ? finite(normalizedMean * scale) : null,
		populationStdDev: count ? finite(Math.sqrt(Math.max(0, normalizedSquares / count)) * scale) : null,
		min: minimum,
		max: maximum,
		first: first ? { at: first.at, value: first.value } : null,
		last: last ? { at: last.at, value: last.value } : null,
		slopePerSecond:
			first && last && durationSeconds > 0
				? finite(last.value / durationSeconds - first.value / durationSeconds)
				: null,
		slopeMethod: "first_to_last_unique_timestamp",
		overflow:
			count > 0 &&
			(!Number.isFinite(normalizedMean * scale) ||
				!Number.isFinite(Math.sqrt(Math.max(0, normalizedSquares / count)) * scale)),
	};
}

export function summarizeMetrics(window: AnalysisWindow, metrics: NumericField[], bucketSeconds?: number) {
	const data = prepare(window, metrics);
	const buckets: { from: string; to: string; records: number; metrics: ReturnType<typeof statistics>[] }[] = [];
	if (bucketSeconds !== undefined) {
		positiveSeconds(bucketSeconds, "聚合桶秒数");
		const from = Date.parse(window.from),
			to = Date.parse(window.to),
			width = bucketSeconds * 1000;
		const bucketCount = Math.max(1, Math.ceil((to - from) / width));
		if (bucketCount > 200) throw new ToolInputError("聚合桶数超过200，请增大聚合桶秒数。");
		const grouped = new Map<number, typeof data.rows>();
		for (const row of data.rows) {
			const index = Math.min(bucketCount - 1, Math.floor((row.time - from) / width));
			const group = grouped.get(index) ?? [];
			group.push(row);
			grouped.set(index, group);
		}
		for (let index = 0; index < bucketCount; index++) {
			const rows = grouped.get(index) ?? [];
			buckets.push({
				from: new Date(from + index * width).toISOString(),
				to: new Date(Math.min(to, from + (index + 1) * width)).toISOString(),
				records: rows.length,
				metrics: metrics.map((metric) => statistics(rows, data.counts, metric)),
			});
		}
	}
	return {
		...scope(window),
		missingFields: metrics.filter((field) => !window.availableFields.includes(field)),
		records: data.rows.length,
		metrics: metrics.map((metric) => statistics(data.rows, data.counts, metric)),
		bucketSeconds: bucketSeconds ?? null,
		bucketBoundary: "left_closed_right_open_except_range_end",
		buckets,
		invalidTimeRowsInSource: window.invalidTimeRows,
		invalidTimeRangeAttribution: "unknown",
		invalidTimeRecords: data.invalidTimeRecords,
		outsideRangeRecords: data.outsideRangeRecords,
		sampled: false,
	};
}

export function compareMetricWindows(a: AnalysisWindow, b: AnalysisWindow, metrics: NumericField[]) {
	const first = summarizeMetrics(a, metrics),
		second = summarizeMetrics(b, metrics);
	return {
		a: first,
		b: second,
		comparisons: first.metrics.map((entry, index) => {
			const other = second.metrics[index];
			const delta = entry.mean !== null && other.mean !== null ? finite(other.mean - entry.mean) : null;
			return {
				metric: entry.metric,
				meanA: entry.mean,
				meanB: other.mean,
				meanDelta: delta,
				meanChangePercent:
					delta !== null && entry.mean !== null && entry.mean !== 0
						? finite((delta / Math.abs(entry.mean)) * 100)
						: null,
				status: delta === null ? "unknown" : "observed",
				causalInterpretation: "not_established",
			};
		}),
	};
}

interface ThresholdEvent {
	startedAt: string;
	lastSeenAt: string;
	endedAt: string | null;
	endReason: "recovered" | "missing_value" | "duplicate_timestamp" | "gap" | "window_end";
	startUncertain: boolean;
	samples: number;
	observedDurationSeconds: number;
	qualified: boolean;
}

export function analyzeThresholdEvents(window: AnalysisWindow, rule: ThresholdRule) {
	validateRule(rule);
	if (!window.availableFields.includes(rule.metric)) throw new ToolInputError("当前来源不存在所请求的数值字段。");
	if (rule.operator !== "gt" && rule.operator !== "lt") throw new ToolInputError("阈值运算符必须是gt或lt。");
	const data = prepare(window, [rule.metric]);
	const recovery = rule.recoveryThreshold ?? rule.threshold;
	const events: ThresholdEvent[] = [];
	let active: ThresholdEvent | null = null,
		previousTime: number | null = null,
		normalEstablished = false;
	let eventCount = 0,
		qualifiedCount = 0,
		observedDurationSeconds = 0,
		qualifiedDurationSeconds = 0;
	let latestCondition: {
		state: "alert" | "normal" | "unknown";
		at: string | null;
		value: number | null;
		reason: string;
	} = { state: "unknown", at: null, value: null, reason: "no_usable_samples" };
	const finish = (reason: ThresholdEvent["endReason"], endedAt: string | null) => {
		if (!active) return;
		active.endReason = reason;
		active.endedAt = endedAt;
		active.qualified = active.observedDurationSeconds >= rule.minDurationSeconds;
		eventCount++;
		observedDurationSeconds += active.observedDurationSeconds;
		if (active.qualified) {
			qualifiedCount++;
			qualifiedDurationSeconds += active.observedDurationSeconds;
		}
		events.push(active);
		if (events.length > 50) events.shift();
		active = null;
	};
	for (const { record, time } of data.rows) {
		const at = new Date(time).toISOString(),
			value = metricValue(record, rule.metric);
		if (data.counts.get(time)! > 1 || value === null) {
			const reason = data.counts.get(time)! > 1 ? "duplicate_timestamp" : "missing_value";
			finish(reason, null);
			normalEstablished = false;
			previousTime = null;
			latestCondition = { state: "unknown", at, value: null, reason };
			continue;
		}
		if (previousTime !== null && (time - previousTime) / 1000 > rule.maxGapSeconds) {
			finish("gap", null);
			normalEstablished = false;
		}
		const triggered = rule.operator === "gt" ? value > rule.threshold : value < rule.threshold;
		const recovered = rule.operator === "gt" ? value <= recovery : value >= recovery;
		if (active && recovered) finish("recovered", at);
		if (recovered) normalEstablished = true;
		if (!active && triggered)
			active = {
				startedAt: at,
				lastSeenAt: at,
				endedAt: null,
				endReason: "window_end",
				startUncertain: !normalEstablished,
				samples: 0,
				observedDurationSeconds: 0,
				qualified: false,
			};
		if (active) {
			active.samples++;
			active.lastSeenAt = at;
			active.observedDurationSeconds = (time - Date.parse(active.startedAt)) / 1000;
			active.qualified = active.observedDurationSeconds >= rule.minDurationSeconds;
			latestCondition = {
				state: active.qualified ? "alert" : "unknown",
				at,
				value,
				reason: active.qualified ? "duration_met" : "duration_pending",
			};
		} else
			latestCondition = {
				state: recovered ? "normal" : "unknown",
				at,
				value,
				reason: recovered ? "recovery_condition" : "hysteresis_without_active_event",
			};
		previousTime = time;
	}
	finish("window_end", null);
	return {
		...scope(window),
		rule,
		records: data.rows.length,
		latestCondition,
		aggregate: { eventCount, qualifiedCount, observedDurationSeconds, qualifiedDurationSeconds },
		events: events.reverse(),
		eventsTruncated: eventCount > events.length,
		invalidTimeRowsInSource: window.invalidTimeRows,
		invalidTimeRangeAttribution: "unknown",
		invalidTimeRecords: data.invalidTimeRecords,
		continuity: "nulls_duplicates_and_gaps_break_events",
		durationBasis: "observed_sample_span",
		durationDefinition: "lastSeenAt_minus_startedAt_excludes_recovery_sample",
	};
}

export function getCodeEvents(window: AnalysisWindow, page = 1) {
	if (!["fault_code", "alarm_code"].every((field) => window.availableFields.includes(field)))
		throw new ToolInputError("当前来源缺少故障码或报警码字段，不能将未取得代码数据解释为0次事件。");
	if (!Number.isInteger(page) || page < 1 || page > 200) throw new ToolInputError("事件页码必须是1至200的整数。");
	const data = prepare(window);
	const history = createCodeHistory({ table: window.table, page, from: window.from, to: window.to });
	for (const { record } of data.rows) {
		const raw = { ...record.raw };
		for (const field of ["fault_code", "alarm_code"] as const) {
			if (typeof raw[field] === "string" && !raw[field].trim()) raw[field] = null;
		}
		history.add(raw);
	}
	const result = history.finish();
	const codeCoverage = (["fault_code", "alarm_code"] as const).map((field) => {
		const usable = data.rows.filter(
			({ record }) => record.raw[field] !== null && String(record.raw[field]).trim() !== "",
		).length;
		return { field, usable, missing: data.rows.length - usable };
	});
	const anyUsable = codeCoverage.some((item) => item.usable > 0);
	const codeCount = result.codes.length;
	let codeTextTruncated = false;
	const boundCode = (code: string) => {
		if (code.length > 128) codeTextTruncated = true;
		return code.slice(0, 128);
	};
	return {
		...result,
		...scope(window),
		status: !anyUsable ? "unknown" : codeCoverage.some((item) => item.missing > 0) ? "partial" : "observed",
		codeCoverage,
		countsAreObserved: true,
		faults: codeCoverage[0].usable ? result.faults : null,
		alarms: codeCoverage[1].usable ? result.alarms : null,
		total: anyUsable ? result.total : null,
		open: anyUsable ? result.open : null,
		events: result.events.map((event) => ({ ...event, code: boundCode(event.code) })),
		codes: result.codes
			.slice(0, 100)
			.map((entry) => ({ ...entry, code: boundCode(entry.code), durationMs: finite(entry.durationMs) })),
		codeCount,
		codesTruncated: codeCount > 100,
		codeTextTruncated,
		eventsTruncated: result.total > result.events.length,
		hasMore: result.total > page * result.pageSize,
		invalidTimeRowsInSource: window.invalidTimeRows,
		invalidTimeRangeAttribution: "unknown",
		invalidTimeRecords: data.invalidTimeRecords,
		scope: "window_only",
		continuity: "code_history_semantics_no_gap_inference",
		currentStateInterpretation: "not_established",
	};
}

export function assessDeviceState(
	window: AnalysisWindow,
	staleAfterSeconds: number,
	now = Date.now(),
	ruleSet?: StateRuleSet,
) {
	positiveSeconds(staleAfterSeconds, "数据过期秒数");
	if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new ToolInputError("当前时间无效。");
	const data = prepare(window);
	const latest = data.rows.at(-1);
	const ageSeconds = latest ? finite((now - latest.time) / 1000) : null;
	const duplicateLatest = latest ? data.counts.get(latest.time)! > 1 : false;
	const freshness =
		ageSeconds === null || ageSeconds < 0 || duplicateLatest
			? "unknown"
			: ageSeconds > staleAfterSeconds
				? "stale"
				: "fresh";
	const windowEndAgeSeconds = (now - Date.parse(window.to)) / 1000;
	const historicalWindowOnly =
		window.table === "real_data" || windowEndAgeSeconds < 0 || windowEndAgeSeconds > staleAfterSeconds;
	if (
		ruleSet &&
		(!ruleSet.source.trim() ||
			ruleSet.source.length > 500 ||
			!ruleSet.version.trim() ||
			ruleSet.version.length > 160 ||
			ruleSet.rules.length === 0 ||
			ruleSet.rules.length > 20 ||
			ruleSet.rules.some(
				(rule) =>
					!["running", "stopped", "fault"].includes(rule.state) ||
					rule.all.length === 0 ||
					rule.all.length > 10 ||
					rule.all.some(
						(condition) =>
							!Object.hasOwn(fieldLabels, condition.field) ||
							!["eq", "gt", "lt"].includes(condition.operator) ||
							(typeof condition.value === "number"
								? !Number.isFinite(condition.value)
								: condition.value.length > 300) ||
							(condition.operator !== "eq" && finiteNumber(condition.value) === null),
					),
			))
	) {
		throw new ToolInputError("设备状态规则配置无效或超过长度限制。");
	}
	const conditionEvidence =
		ruleSet?.rules.map((rule) => {
			const conditions = rule.all.map((condition) => {
				const raw = latest?.record.raw[condition.field] ?? null;
				const missing = raw === null || (typeof raw === "string" && raw.trim() === "");
				const numeric = missing ? null : finiteNumber(raw);
				const expected = finiteNumber(condition.value);
				let matched: boolean | null = null;
				if (!missing) {
					if (condition.operator === "eq")
						matched =
							typeof condition.value === "number"
								? numeric === null
									? null
									: numeric === condition.value
								: raw === condition.value;
					else if (numeric !== null && expected !== null)
						matched = condition.operator === "gt" ? numeric > expected : numeric < expected;
				}
				return {
					...condition,
					observed: typeof raw === "string" ? raw.slice(0, 128) : raw,
					matched,
					observedTruncated: typeof raw === "string" && raw.length > 128,
				};
			});
			return { state: rule.state, matched: conditions.every((condition) => condition.matched === true), conditions };
		}) ?? [];
	const matchedStates = [...new Set(conditionEvidence.filter((rule) => rule.matched).map((rule) => rule.state))];
	const unknownPossibleStates = [
		...new Set(
			conditionEvidence
				.filter(
					(rule) =>
						rule.conditions.some((condition) => condition.matched === null) &&
						rule.conditions.every((condition) => condition.matched !== false),
				)
				.map((rule) => rule.state),
		),
	];
	const possibleConflict = unknownPossibleStates.some((state) => state !== matchedStates[0]);
	const observedState =
		!duplicateLatest && matchedStates.length === 1 && !possibleConflict ? matchedStates[0] : "unknown";
	const currentState = freshness === "fresh" && !historicalWindowOnly ? observedState : "unknown";
	const rawCodes: {
		field: string;
		value: string | number | null;
		nonzeroObserved: boolean | null;
		truncated: boolean;
	}[] = [];
	if (latest) {
		for (const field of ["status", "fault_code", "alarm_code", "control_word", "status_word"] as const) {
			const raw = latest.record.raw[field];
			const text = raw === null ? null : String(raw);
			rawCodes.push({
				field,
				value: typeof raw === "string" ? raw.slice(0, 128) : raw,
				nonzeroObserved: text === null || text.trim() === "" ? null : text.trim() !== "0",
				truncated: typeof raw === "string" && raw.length > 128,
			});
		}
	}
	return {
		...scope(window),
		assessedAt: new Date(now).toISOString(),
		latestAt: latest ? new Date(latest.time).toISOString() : null,
		ageSeconds,
		staleAfterSeconds,
		freshness,
		observedState,
		currentState,
		unknownPossibleStates,
		running: currentState === "running" ? true : currentState === "stopped" ? false : "unknown",
		reason: !ruleSet
			? "raw_code_decoding_rules_not_configured"
			: historicalWindowOnly
				? "historical_or_future_window"
				: freshness !== "fresh"
					? "latest_sample_not_fresh_or_unique"
					: matchedStates.length > 1
						? "conflicting_state_rules"
						: possibleConflict
							? "missing_fields_allow_conflicting_state"
							: observedState === "unknown"
								? "no_unique_matching_state_rule"
								: "configured_state_rule",
		ruleSource: ruleSet ? { source: ruleSet.source, version: ruleSet.version } : null,
		conditionEvidence,
		latestTimestampAmbiguous: duplicateLatest,
		rawCodes,
		historicalWindowOnly,
		invalidTimeRowsInSource: window.invalidTimeRows,
		invalidTimeRangeAttribution: "unknown",
	};
}
