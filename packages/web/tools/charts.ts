import { randomUUID } from "node:crypto";
import { fieldLabels, type NumericField, numericFields } from "../../../dashboard/database/dashboard-types.ts";
import type { ChartArtifact, ChartColumn, ChartRequest, ChartRow, ChartScope } from "../chart-contracts.ts";
import { validateChartArtifact } from "../chart-contracts.ts";
import { type compareMetricWindows, type getCodeEvents, summarizeMetrics } from "./analytics.ts";
import { type AnalysisWindow, type ThresholdRule, ToolInputError } from "./contracts.ts";

export type ChartSource =
	| {
			type: "window" | "preview";
			window: AnalysisWindow;
			allowedMetrics: NumericField[];
			units: Partial<Record<NumericField, string>>;
			threshold?: ThresholdRule;
			maxGapSeconds?: number;
	  }
	| {
			type: "comparison";
			windows: [AnalysisWindow, AnalysisWindow];
			result: ReturnType<typeof compareMetricWindows>;
	  }
	| { type: "code_events"; window: AnalysisWindow; result: ReturnType<typeof getCodeEvents> };

function scope(window: AnalysisWindow, preview = false): ChartScope {
	const sorted = window.records
		.filter((row) => row.acquiredAt)
		.slice()
		.sort((a, b) => a.acquiredAt!.localeCompare(b.acquiredAt!));
	const device = sorted[0]?.raw.device_name;
	return {
		table: window.table,
		kind: window.table === "real_data" ? "acquired" : "simulation",
		from: window.from,
		to: window.to,
		queriedAt: window.queriedAt,
		firstSampleAt: sorted[0]?.acquiredAt ?? null,
		lastSampleAt: sorted.at(-1)?.acquiredAt ?? null,
		device: typeof device === "string" ? device.slice(0, 256).replace(/[\u0000-\u001f]/g, " ") : null,
		preview,
	};
}
function sampleLine(rows: ChartRow[], seriesCount: number): ChartRow[] {
	if (rows.length <= 2000) return rows.slice();
	const selected = new Set<number>([0, rows.length - 1]);
	for (let index = 1; index < rows.length; index++) {
		if (rows[index].slice(1).some((value, series) => (value === null) !== (rows[index - 1][series + 1] === null))) {
			selected.add(index - 1);
			selected.add(index);
		}
	}
	if (selected.size > 1000) throw new ToolInputError("缺失断点过多，请缩小时间范围；不能跨断点降采样。");
	const buckets = Math.max(1, Math.floor((2000 - selected.size) / (seriesCount * 2)));
	const width = Math.ceil(rows.length / buckets);
	for (let start = 0; start < rows.length; start += width) {
		for (let series = 1; series <= seriesCount; series++) {
			let low = -1,
				high = -1;
			for (let index = start; index < Math.min(start + width, rows.length); index++) {
				const value = rows[index][series];
				if (typeof value !== "number") continue;
				if (low < 0 || value < Number(rows[low][series])) low = index;
				if (high < 0 || value > Number(rows[high][series])) high = index;
			}
			if (low >= 0) selected.add(low);
			if (high >= 0) selected.add(high);
		}
	}
	return [...selected].sort((a, b) => a - b).map((index) => rows[index]);
}

export function buildChart(
	request: ChartRequest,
	source: ChartSource,
	sourceTool = "summarize_metrics",
): ChartArtifact {
	const fail = (message: string): never => {
		throw new ToolInputError(message);
	};
	if (!["line", "scatter", "bar", "histogram"].includes(request.kind)) fail("图型不支持。");
	if (
		request.title !== undefined &&
		(!request.title.trim() || request.title.length > 100 || /[\u0000-\u001f]/.test(request.title))
	)
		fail("图表标题须为100字以内的单行文本。");
	if (request.kind !== "scatter" && request.xMetric !== undefined) fail("只有散点图可指定横轴指标。");
	if (request.kind !== "histogram" && request.bins !== undefined) fail("只有直方图可指定箱数。");
	if (
		(request.kind === "scatter" || request.kind === "histogram") &&
		(request.bucketSeconds !== undefined || request.aggregation !== undefined)
	)
		fail("散点图和直方图不接受时间聚合。");
	if (request.aggregation !== undefined && !["mean", "min", "max"].includes(request.aggregation))
		fail("聚合方法无效。");
	const artifact: ChartArtifact = {
		request: { ...request },
		version: 1,
		id: randomUUID(),
		createdAt: new Date().toISOString(),
		title: request.title?.trim() ?? "",
		kind: request.kind,
		evidenceId: request.evidenceId,
		sourceTool,
		sources: [],
		columns: [],
		xKey: "time",
		series: [],
		rows: [],
		displayRows: [],
		sourceRecords: 0,
		excluded: 0,
		notes: ["MySQL无时区日期暂按北京时间解释；图表是查询快照，不自动更新。"],
		aggregation: "原始采样序列",
	};
	if (source.type === "comparison" || source.type === "code_events") {
		if (
			request.kind !== "bar" ||
			request.bucketSeconds !== undefined ||
			request.aggregation !== undefined ||
			request.xMetric !== undefined
		)
			fail("代码事件和窗口比较证据仅支持类别柱状图，不接受时间聚合。");
		artifact.xKey = "category";
		artifact.columns = [{ key: "category", label: "类别", unit: null, role: "category" }];
		if (source.type === "comparison") {
			const metrics = request.metrics ?? source.result.comparisons.slice(0, 4).map((item) => item.metric);
			if (
				!metrics.length ||
				metrics.length > 4 ||
				new Set(metrics).size !== metrics.length ||
				metrics.some((metric) => !source.result.comparisons.some((item) => item.metric === metric))
			)
				fail("比较证据不包含所选字段。");
			artifact.sources = source.windows.map((window) => scope(window));
			artifact.request.metrics = metrics;
			artifact.sourceRecords = source.windows.reduce((sum, window) => sum + window.records.length, 0);
			artifact.series = metrics.map((metric) => ({ key: metric, label: fieldLabels[metric], unit: null }));
			artifact.rows = ["A", "B"].map((name) => [
				name,
				...metrics.map((metric) => {
					const item = source.result.comparisons.find((entry) => entry.metric === metric)!;
					return name === "A" ? item.meanA : item.meanB;
				}),
			]);
			artifact.aggregation = "A/B窗口采样均值";
		} else {
			if (request.metrics?.length) fail("代码事件柱状图不接受数值测点；省略metrics。");
			if (source.result.codesTruncated || source.result.codeTextTruncated)
				fail("代码类别或文本已截断，请缩小查询范围后重新绘图。");
			artifact.sources = [scope(source.window)];
			artifact.sourceRecords = source.window.records.length;
			artifact.series = [{ key: "count", label: "已观测事件次数", unit: "次" }];
			artifact.rows = source.result.codes.map((item) => [
				`${item.field === "fault_code" ? "故障" : "报警"} ${item.code}`,
				item.count,
			]);
			artifact.aggregation = "窗口内连续代码事件次数";
			artifact.notes.push("代码事件次数不等于非零采样点数；事件窗口边界可能不完整。");
		}
		artifact.columns.push(...artifact.series.map((item) => ({ ...item, role: "value" as const })));
	} else {
		const metrics = request.metrics;
		if (
			!metrics?.length ||
			metrics.length > 4 ||
			new Set(metrics).size !== metrics.length ||
			metrics.some(
				(metric) =>
					!numericFields.includes(metric) ||
					!source.allowedMetrics.includes(metric) ||
					!source.window.availableFields.includes(metric),
			)
		)
			fail("请指定证据实际包含的1至4个不重复数值字段。");
		const selectedMetrics = metrics!;
		const rows = source.window.records
			.filter(
				(row) =>
					row.acquiredAt &&
					Date.parse(row.acquiredAt) >= Date.parse(source.window.from) &&
					Date.parse(row.acquiredAt) <= Date.parse(source.window.to),
			)
			.slice()
			.sort((a, b) => a.acquiredAt!.localeCompare(b.acquiredAt!));
		artifact.sources = [scope(source.window, source.type === "preview")];
		artifact.sourceRecords = rows.length;
		artifact.series = selectedMetrics.map((metric) => ({
			key: metric,
			label: fieldLabels[metric],
			unit: source.units[metric] ?? null,
		}));
		const timeColumn: ChartColumn = {
			key: "time",
			label: "采集时间（UTC；界面显示北京时间）",
			role: "time",
			unit: null,
		};
		if (request.kind === "scatter") {
			const x = request.xMetric;
			if (
				!x ||
				!source.allowedMetrics.includes(x) ||
				!source.window.availableFields.includes(x) ||
				selectedMetrics.length !== 1 ||
				x === selectedMetrics[0]
			)
				fail("散点图需要证据内不同的横轴指标和一个纵轴指标。");
			artifact.xKey = x!;
			artifact.columns = [
				timeColumn,
				{ key: x!, label: fieldLabels[x!], unit: source.units[x!] ?? null, role: "value" },
				...artifact.series.map((item) => ({ ...item, role: "value" as const })),
			];
			artifact.rows = rows.flatMap((row) =>
				typeof row.values[x!] === "number" && typeof row.values[selectedMetrics[0]] === "number"
					? [[row.acquiredAt, row.values[x!], row.values[selectedMetrics[0]]]]
					: [],
			);
			artifact.excluded = rows.length - artifact.rows.length;
			artifact.notes.push("同一采样记录配对；关联分布不能证明因果。");
		} else if (request.kind === "histogram") {
			const bins = request.bins ?? 20;
			if (selectedMetrics.length !== 1 || !Number.isInteger(bins) || bins < 5 || bins > 50)
				fail("直方图需要一个指标，箱数为5至50整数。");
			const values = rows.flatMap((row) => {
				const value = row.values[selectedMetrics[0]];
				return typeof value === "number" ? [value] : [];
			});
			if (!values.length) fail("没有有效数值可绘图。");
			const minimum = Math.min(...values),
				maximum = Math.max(...values);
			const padding = maximum === minimum ? Math.max(Math.abs(maximum) * 0.01, 0.01) : 0;
			const low = minimum - padding,
				high = maximum + padding,
				width = (high - low) / bins;
			if (!Number.isFinite(width) || width <= 0) fail("数值范围过大或过小，不能可靠分箱。");
			const counts = Array<number>(bins).fill(0);
			for (const value of values) counts[Math.min(bins - 1, Math.floor((value - low) / width))]++;
			artifact.xKey = "bin";
			artifact.columns = [
				{
					key: "bin",
					label: `${fieldLabels[selectedMetrics[0]]}区间${source.units[selectedMetrics[0]] ? `（${source.units[selectedMetrics[0]]}）` : "（单位未确认）"}`,
					unit: null,
					role: "category",
				},
				{ key: "count", label: "有效采样频数", unit: "条", role: "value" },
				{ key: "lower", label: "箱下界", unit: source.units[selectedMetrics[0]] ?? null, role: "value" },
				{ key: "upper", label: "箱上界", unit: source.units[selectedMetrics[0]] ?? null, role: "value" },
			];
			artifact.series = [{ key: "count", label: "有效采样频数", unit: "条" }];
			artifact.rows = counts.map((count, index) => {
				const lower = low + width * index,
					upper = index === bins - 1 ? high : low + width * (index + 1);
				return [`${lower.toPrecision(4)}～${upper.toPrecision(4)}`, count, lower, upper];
			});
			artifact.excluded = rows.length - values.length;
			artifact.aggregation = `${bins}箱，左闭右开，最后一箱包含最大值`;
		} else {
			artifact.columns = [timeColumn, ...artifact.series.map((item) => ({ ...item, role: "value" as const }))];
			if (
				(request.bucketSeconds === undefined) !== (request.aggregation === undefined) ||
				(request.kind === "bar" && request.bucketSeconds === undefined)
			)
				fail("时间聚合需要同时指定bucketSeconds与aggregation；时间柱状图必须聚合。");
			if (request.bucketSeconds !== undefined) {
				const summary = summarizeMetrics(source.window, selectedMetrics, request.bucketSeconds);
				artifact.rows = summary.buckets.map((bucket) => [
					bucket.from,
					...bucket.metrics.map((metric) => metric[request.aggregation!]),
				]);
				artifact.aggregation = `${request.bucketSeconds}秒分桶 · ${request.aggregation} · 采样点统计`;
			} else {
				const counts = new Map<string, number>();
				for (const row of rows) counts.set(row.acquiredAt!, (counts.get(row.acquiredAt!) ?? 0) + 1);
				artifact.rows = rows.map((row) => [
					row.acquiredAt!,
					...selectedMetrics.map((metric) => (counts.get(row.acquiredAt!)! > 1 ? null : row.values[metric])),
				]);
				if ([...counts.values()].some((count) => count > 1))
					artifact.notes.push("重复采集时间的曲线点保留为空，避免暗示唯一读数；CSV中同样标为未知。");
				if (source.maxGapSeconds) {
					const expanded: ChartRow[] = [];
					for (const row of artifact.rows) {
						const previous = expanded.at(-1);
						if (
							previous &&
							Date.parse(String(row[0])) - Date.parse(String(previous[0])) > source.maxGapSeconds * 1000
						)
							expanded.push([
								new Date((Date.parse(String(row[0])) + Date.parse(String(previous[0]))) / 2).toISOString(),
								...selectedMetrics.map(() => null),
							]);
						expanded.push(row);
					}
					artifact.rows = expanded;
					artifact.notes.push(`超过${source.maxGapSeconds}秒的采样间断以空点断线；空点为显示标记，不是采样。`);
				}
			}
			artifact.excluded = rows.filter((row) => selectedMetrics.some((metric) => row.values[metric] === null)).length;
			if (source.threshold && selectedMetrics.includes(source.threshold.metric))
				artifact.threshold = {
					metric: source.threshold.metric,
					value: source.threshold.threshold,
					unit: source.threshold.unit,
					source: source.threshold.source,
				};
		}
		if (source.type === "preview") artifact.notes.push("仅原工具返回的近期预览，不是完整历史窗口。");
	}
	if (artifact.rows.length > 20000) fail("图表数据超过20000行，请缩小范围。");
	const valueIndexes = artifact.series.map((series) =>
		artifact.columns.findIndex((column) => column.key === series.key),
	);
	if (!artifact.rows.some((row) => valueIndexes.some((index) => typeof row[index] === "number")))
		fail("没有有效数据可绘图。");
	artifact.title ||=
		`${request.kind === "histogram" ? fieldLabels[request.metrics![0]] : artifact.series.map((item) => item.label).join(" / ")} · ${{ line: "趋势", scatter: "配对散点", bar: "对比", histogram: "分布" }[request.kind]}`.slice(
			0,
			100,
		);
	artifact.displayRows =
		request.kind === "line"
			? sampleLine(artifact.rows, artifact.series.length)
			: request.kind === "scatter" && artifact.rows.length > 5000
				? Array.from({ length: 5000 }, (_, i) => artifact.rows[Math.floor((i * (artifact.rows.length - 1)) / 4999)])
				: artifact.rows.slice();
	if (artifact.rows.length !== artifact.displayRows.length)
		artifact.notes.push(
			`显示${artifact.displayRows.length}/${artifact.rows.length}行，经过确定性显示抽样；CSV保留快照完整数据。`,
		);
	if (artifact.series.some((series) => !series.unit))
		artifact.notes.push("测点单位未确认；不从字段名称推断单位。不同指标使用独立面板。");
	return validateChartArtifact(artifact);
}
