import type {
	EChartsOption,
	SeriesOption,
	TooltipComponentFormatterCallbackParams,
	XAXisComponentOption,
	YAXisComponentOption,
} from "echarts";
import type { ChartArtifact } from "../chart-contracts.ts";

const colors = ["#2563eb", "#0f766e", "#b45309", "#7c3aed"];
export function chartZoomViewport(value: unknown): { start: number; end: number }[] {
	if (!Array.isArray(value)) return [];
	return value.map((item: { start?: number; end?: number }) => ({
		start: typeof item.start === "number" && Number.isFinite(item.start) ? Math.max(0, Math.min(100, item.start)) : 0,
		end: typeof item.end === "number" && Number.isFinite(item.end) ? Math.max(0, Math.min(100, item.end)) : 100,
	}));
}
export function chartRequery(data: ChartArtifact): string {
	const metric = [
		data.request.xMetric,
		...(data.request.metrics ?? data.series.map((item) => item.key).filter((key) => key !== "count")),
	]
		.filter(Boolean)
		.join("、");
	return `请重新查询${data.sources.map((source, index) => `${data.sources.length > 1 ? `${String.fromCharCode(65 + index)}段：` : ""}dcma.${source.table}，UTC ${source.from}至${source.to}`).join("；")}，并生成${{ line: "折线图", scatter: "散点图", bar: "柱状图", histogram: "直方图" }[data.kind]}。${data.sources.length > 1 ? "进行A/B窗口指标均值比较。" : ""}${metric ? `指标为${metric}。` : "使用原窗口代码事件次数。"}${data.request.bucketSeconds ? `分桶${data.request.bucketSeconds}秒，聚合${data.request.aggregation}。` : ""}${data.request.bins ? `分${data.request.bins}箱。` : ""}这是重新读取该固定时段，不要改变历史消息的图表。`;
}
export function chartTime(value: string | number): string {
	return new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(new Date(value));
}
export function chartHeight(chart: ChartArtifact): number {
	return 300 + Math.max(0, chart.series.length - 1) * 180;
}
export function createChartOptions(chart: ChartArtifact, width: number, exporting = false): EChartsOption {
	const category = chart.columns.find((column) => column.key === chart.xKey)?.role === "category";
	const xColumn = chart.columns.find((column) => column.key === chart.xKey)!;
	const xIndex = chart.columns.indexOf(xColumn);
	const top = exporting ? 125 : 0;
	const series: SeriesOption[] = [];
	const xAxes: XAXisComponentOption[] = [],
		yAxes: YAXisComponentOption[] = [];
	const grids = chart.series.map((item, index) => {
		const valueIndex = chart.columns.findIndex((column) => column.key === item.key);
		xAxes.push({
			type: category ? "category" : chart.kind === "scatter" ? "value" : "time",
			gridIndex: index,
			...(category ? { data: chart.displayRows.map((row) => String(row[xIndex])) } : {}),
			name:
				chart.kind === "scatter"
					? `${xColumn.label}（${xColumn.unit ?? "单位未确认"}）`
					: chart.kind === "histogram"
						? xColumn.label
						: "",
			nameLocation: "middle",
			nameGap: 27,
			nameTextStyle: { fontSize: 11, color: "#475569" },
			axisLabel: {
				fontSize: 10,
				hideOverlap: true,
				...(chart.kind === "line" || (!category && chart.kind === "bar")
					? { formatter: (value: number) => chartTime(value).slice(6) }
					: {}),
				...(category ? { overflow: "truncate", width: width < 500 ? 65 : 110 } : {}),
			},
			axisLine: { lineStyle: { color: "#cbd5e1" } },
			axisTick: { show: false },
			splitLine: { show: false },
		} as XAXisComponentOption);
		yAxes.push({
			type: "value",
			gridIndex: index,
			name: `${item.label}（${item.unit ?? "单位未确认"}）`,
			nameTextStyle: { color: "#475569", fontSize: 11, align: "left", padding: [0, 0, 0, -35] },
			nameGap: 17,
			scale: chart.kind !== "bar" && chart.kind !== "histogram",
			axisLabel: { fontSize: 10, formatter: (value: number) => Number(value.toPrecision(5)).toString() },
			splitLine: { lineStyle: { color: "#e8eef5", type: "dashed" } },
			axisLine: { show: false },
		});
		series.push({
			name: item.label,
			type: chart.kind === "scatter" ? "scatter" : chart.kind === "line" ? "line" : "bar",
			xAxisIndex: index,
			yAxisIndex: index,
			data: chart.displayRows.map((row) =>
				category
					? row[valueIndex]
					: [chart.kind === "scatter" ? row[xIndex] : Date.parse(String(row[xIndex])), row[valueIndex]],
			),
			connectNulls: false,
			showSymbol: chart.displayRows.length < 60,
			symbolSize: chart.kind === "scatter" ? 6 : 4,
			barMaxWidth: 32,
			itemStyle: { color: colors[index], opacity: chart.kind === "scatter" ? 0.72 : 1 },
			lineStyle: { width: 2, type: index % 2 ? "dashed" : "solid" },
			...(chart.threshold?.metric === item.key
				? {
						markLine: {
							silent: true,
							symbol: "none",
							lineStyle: { color: "#dc2626", type: "dashed" },
							label: { formatter: `阈值 ${chart.threshold.value} ${chart.threshold.unit}` },
							data: [{ yAxis: chart.threshold.value }],
						},
					}
				: {}),
		} as SeriesOption);
		return {
			left: width < 500 ? 55 : 70,
			right: 24,
			top: top + 60 + index * 180,
			height: chart.series.length === 1 ? 165 : 125,
			containLabel: false,
		};
	});
	const source = chart.sources
		.map(
			(scope) =>
				`${scope.device ?? scope.table} · dcma.${scope.table} · ${scope.kind === "simulation" ? "模拟数据" : "历史真实采集"}\n${chartTime(scope.from)} ～ ${chartTime(scope.to)}（北京时间）`,
		)
		.join("\n");
	return {
		animation: false,
		backgroundColor: "#fff",
		color: colors,
		textStyle: { fontFamily: "system-ui, PingFang SC, Microsoft YaHei, sans-serif" },
		aria: {
			enabled: true,
			description: `${chart.title}。${chart.sourceRecords}条来源记录，${chart.aggregation}。可使用数据视图读取数值。`,
		},
		...(exporting
			? {
					title: {
						text: chart.title,
						subtext: source,
						left: 20,
						top: 12,
						textStyle: { fontSize: 19, color: "#0f172a" },
						subtextStyle: { fontSize: 12, color: "#475569", lineHeight: 18 },
					},
					graphic: [
						{
							type: "text",
							left: 20,
							bottom: 12,
							style: {
								text: [
									`来源 ${chart.sourceRecords} 条 · 显示 ${chart.displayRows.length} 行 · ${chart.aggregation}`,
									...chart.notes,
								].join("\n"),
								fontSize: 11,
								fill: "#64748b",
								lineHeight: 17,
								width: width - 40,
								overflow: "break",
							},
						},
					],
				}
			: {}),
		legend: { top: top + 4, left: 10, type: "scroll", textStyle: { fontSize: 11, color: "#475569" } },
		tooltip: {
			trigger: chart.kind === "scatter" ? "item" : "axis",
			...(chart.kind === "scatter"
				? {
						formatter: (params: TooltipComponentFormatterCallbackParams) => {
							const point = Array.isArray(params) ? params[0] : params;
							const row = chart.displayRows[point.dataIndex];
							if (!row) return "";
							const timeIndex = chart.columns.findIndex((column) => column.role === "time");
							return [
								`采集时间 ${chartTime(String(row[timeIndex]))}（北京时间）`,
								...[xColumn, chart.columns.find((column) => column.key === chart.series[0].key)!].map(
									(column) =>
										`${column.label}：${row[chart.columns.indexOf(column)]}（${column.unit ?? "单位未确认"}）`,
								),
							].join("\n");
						},
					}
				: {}),
			renderMode: "richText",
			confine: true,
			backgroundColor: "#fff",
			borderColor: "#dbe5f1",
			textStyle: { fontSize: 12, color: "#1e293b" },
		},
		grid: grids,
		xAxis: xAxes,
		yAxis: yAxes,
		series,
		dataZoom: [
			{ type: "inside", xAxisIndex: chart.series.map((_, index) => index), filterMode: "none" },
			{
				type: "slider",
				xAxisIndex: chart.series.map((_, index) => index),
				filterMode: "none",
				bottom: exporting ? 140 : 10,
				height: 20,
				borderColor: "#e2e8f0",
				fillerColor: "#dbeafe",
				textStyle: { fontSize: 10 },
				showDetail: false,
			},
		],
	};
}
