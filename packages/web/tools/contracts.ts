import type {
	DashboardField,
	DashboardRecord,
	DashboardTable,
	NumericField,
} from "../../../dashboard/database/dashboard-types.ts";

export interface StateRuleSet {
	source: string;
	version: string;
	rules: {
		state: "running" | "stopped" | "fault";
		all: { field: DashboardField; operator: "eq" | "gt" | "lt"; value: string | number }[];
	}[];
}

export interface AnalysisRange {
	table: DashboardTable;
	from: string;
	to: string;
}

export interface AnalysisWindow extends AnalysisRange {
	queriedAt: string;
	records: DashboardRecord[];
	invalidTimeRows: number;
	excludedIdentityRows: number;
	complete: true;
	availableFields: string[];
}

export interface ThresholdRule {
	metric: NumericField;
	operator: "gt" | "lt";
	threshold: number;
	recoveryThreshold?: number;
	minDurationSeconds: number;
	maxGapSeconds: number;
	unit: string;
	source: string;
}

export interface MonitoringSpec {
	table: DashboardTable;
	intervalSeconds: number;
	windowSeconds: number;
	staleAfterSeconds: number;
	rule: ThresholdRule;
}

export interface MonitorObservation {
	state: "alert" | "normal" | "unknown";
	evidence: Record<string, unknown>;
}

export class ToolInputError extends Error {}

function parseZonedTime(value: string): number {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
	if (!match) return Number.NaN;
	const [, year, month, day, hour, minute, second, , zone] = match;
	const days = new Date(`${year}-${month}-01T00:00:00.000Z`);
	if (!Number.isFinite(days.getTime())) return Number.NaN;
	days.setUTCMonth(days.getUTCMonth() + 1, 0);
	if (
		Number(day) < 1 ||
		Number(day) > days.getUTCDate() ||
		Number(hour) > 23 ||
		Number(minute) > 59 ||
		Number(second) > 59 ||
		(zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))
	)
		return Number.NaN;
	return Date.parse(value);
}

export function validateRange(range: AnalysisRange): AnalysisRange {
	const from = parseZonedTime(range.from),
		to = parseZonedTime(range.to);
	if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to - from > 7 * 86400000) {
		throw new ToolInputError(
			"时间必须是带明确时区的有效 ISO 字符串（北京时间用+08:00，UTC用Z），起点不晚于终点，单次范围不超过7天。",
		);
	}
	return { ...range, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export function validateRule(rule: ThresholdRule): void {
	if (
		![rule.threshold, rule.recoveryThreshold ?? rule.threshold, rule.minDurationSeconds, rule.maxGapSeconds].every(
			Number.isFinite,
		) ||
		rule.minDurationSeconds < 0 ||
		rule.maxGapSeconds <= 0 ||
		rule.maxGapSeconds > 86400 ||
		!rule.unit.trim() ||
		rule.unit.length > 32 ||
		!rule.source.trim() ||
		rule.source.length > 300 ||
		(rule.operator === "gt" && (rule.recoveryThreshold ?? rule.threshold) > rule.threshold) ||
		(rule.operator === "lt" && (rule.recoveryThreshold ?? rule.threshold) < rule.threshold)
	) {
		throw new ToolInputError("阈值、持续时间、最大间隔、单位或规则来源无效；恢复阈值必须位于回差方向。");
	}
}
