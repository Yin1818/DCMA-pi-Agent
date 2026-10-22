import {
	type DashboardTable,
	dashboardTables,
	type NumericField,
	numericFields,
} from "../../dashboard/database/dashboard-types.ts";

export const chartIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface ChartReference {
	version: 1;
	id: string;
}
export interface ChartRequest {
	evidenceId: string;
	kind: "line" | "scatter" | "bar" | "histogram";
	title?: string;
	metrics?: NumericField[];
	xMetric?: NumericField;
	bucketSeconds?: number;
	aggregation?: "mean" | "min" | "max";
	bins?: number;
}
export interface ChartColumn {
	key: string;
	label: string;
	unit: string | null;
	role: "time" | "value" | "category";
}
export interface ChartScope {
	table: DashboardTable;
	kind: "simulation" | "acquired";
	from: string;
	to: string;
	queriedAt: string;
	firstSampleAt: string | null;
	lastSampleAt: string | null;
	device: string | null;
	preview: boolean;
}
export type ChartRow = (number | string | null)[];
export interface ChartArtifact extends ChartReference {
	request: ChartRequest;
	createdAt: string;
	title: string;
	kind: ChartRequest["kind"];
	evidenceId: string;
	sourceTool: string;
	sources: ChartScope[];
	columns: ChartColumn[];
	xKey: string;
	series: { key: string; label: string; unit: string | null }[];
	rows: ChartRow[];
	displayRows: ChartRow[];
	sourceRecords: number;
	excluded: number;
	notes: string[];
	aggregation: string;
	threshold?: { metric: string; value: number; unit: string; source: string };
}
export function validateChartReference(value: unknown): ChartReference | null {
	if (
		!value ||
		typeof value !== "object" ||
		!("version" in value) ||
		value.version !== 1 ||
		!("id" in value) ||
		typeof value.id !== "string" ||
		!chartIdPattern.test(value.id)
	)
		return null;
	return { version: 1, id: value.id };
}
function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function label(value: unknown, maximum = 256): value is string {
	return typeof value === "string" && value.length <= maximum && !/[\u0000-\u001f]/.test(value);
}
function instant(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function validateChartArtifact(value: unknown): ChartArtifact {
	const invalid = () => {
		throw new Error("图表快照格式无效或版本不支持。");
	};
	if (
		!record(value) ||
		!validateChartReference(value) ||
		!instant(value.createdAt) ||
		!label(value.title, 100) ||
		!["line", "scatter", "bar", "histogram"].includes(String(value.kind)) ||
		typeof value.evidenceId !== "string" ||
		!chartIdPattern.test(value.evidenceId) ||
		!label(value.sourceTool, 64) ||
		!label(value.xKey, 64) ||
		!label(value.aggregation, 128)
	)
		return invalid();
	if (
		!Array.isArray(value.sources) ||
		!value.sources.length ||
		value.sources.length > 2 ||
		!value.sources.every(
			(source: unknown) =>
				record(source) &&
				dashboardTables.some((table) => table === source.table) &&
				["simulation", "acquired"].includes(String(source.kind)) &&
				instant(source.from) &&
				instant(source.to) &&
				Date.parse(source.from) <= Date.parse(source.to) &&
				instant(source.queriedAt) &&
				(source.firstSampleAt === null || instant(source.firstSampleAt)) &&
				(source.lastSampleAt === null || instant(source.lastSampleAt)) &&
				(source.device === null || label(source.device)) &&
				typeof source.preview === "boolean",
		)
	)
		return invalid();
	if (
		!Array.isArray(value.columns) ||
		value.columns.length < 2 ||
		value.columns.length > 8 ||
		!value.columns.every(
			(column: unknown) =>
				record(column) &&
				label(column.key, 64) &&
				label(column.label) &&
				(column.unit === null || label(column.unit, 32)) &&
				["time", "value", "category"].includes(String(column.role)),
		)
	)
		return invalid();
	if (
		!record(value.request) ||
		value.request.kind !== value.kind ||
		value.request.evidenceId !== value.evidenceId ||
		(value.request.metrics !== undefined &&
			(!Array.isArray(value.request.metrics) ||
				value.request.metrics.length > 4 ||
				!value.request.metrics.every((metric: unknown) => numericFields.some((field) => field === metric)))) ||
		(value.request.xMetric !== undefined &&
			!numericFields.some((field) => field === (value.request as Record<string, unknown>).xMetric))
	)
		return invalid();
	const keys = value.columns.map((column: Record<string, unknown>) => String(column.key));
	const request = value.request as Record<string, unknown>;
	if (
		(request.bucketSeconds !== undefined &&
			(typeof request.bucketSeconds !== "number" ||
				!Number.isFinite(request.bucketSeconds) ||
				request.bucketSeconds <= 0 ||
				request.bucketSeconds > 604800)) ||
		(request.aggregation !== undefined && !["mean", "min", "max"].includes(String(request.aggregation))) ||
		(request.bins !== undefined &&
			(!Number.isInteger(request.bins) || Number(request.bins) < 5 || Number(request.bins) > 50))
	)
		return invalid();
	if (new Set(keys).size !== keys.length || !keys.includes(value.xKey)) return invalid();
	if (
		!Array.isArray(value.series) ||
		!value.series.length ||
		value.series.length > 4 ||
		!value.series.every(
			(series: unknown) =>
				record(series) &&
				typeof series.key === "string" &&
				keys.includes(series.key) &&
				label(series.label) &&
				(series.unit === null || label(series.unit, 32)),
		)
	)
		return invalid();
	for (const key of ["rows", "displayRows"] as const) {
		const rows = value[key];
		if (
			!Array.isArray(rows) ||
			!rows.length ||
			rows.length > (key === "rows" ? 20000 : 8000) ||
			!rows.every(
				(row: unknown) =>
					Array.isArray(row) &&
					row.length === keys.length &&
					row.every((cell: unknown, index: number) => {
						const role = (value.columns as ChartColumn[])[index].role;
						return role === "value"
							? cell === null || (typeof cell === "number" && Number.isFinite(cell))
							: role === "time"
								? instant(cell)
								: label(cell);
					}),
			)
		)
			return invalid();
	}
	if (
		new Set((value.series as ChartArtifact["series"]).map((series) => series.key)).size !== value.series.length ||
		(value.series as ChartArtifact["series"]).some(
			(series) => (value.columns as ChartColumn[]).find((column) => column.key === series.key)?.role !== "value",
		)
	)
		return invalid();
	if (
		!Number.isSafeInteger(value.sourceRecords) ||
		Number(value.sourceRecords) < 0 ||
		!Number.isSafeInteger(value.excluded) ||
		Number(value.excluded) < 0 ||
		!Array.isArray(value.notes) ||
		value.notes.length > 20 ||
		!value.notes.every((note: unknown) => label(note, 500))
	)
		return invalid();
	if (
		value.threshold !== undefined &&
		(!record(value.threshold) ||
			typeof value.threshold.metric !== "string" ||
			!keys.includes(value.threshold.metric) ||
			typeof value.threshold.value !== "number" ||
			!Number.isFinite(value.threshold.value) ||
			!label(value.threshold.unit, 32) ||
			!label(value.threshold.source, 300))
	)
		return invalid();
	return value as unknown as ChartArtifact;
}
