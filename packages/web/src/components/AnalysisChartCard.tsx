import { BarChart, LineChart, ScatterChart } from "echarts/charts";
import {
	AriaComponent,
	DataZoomComponent,
	GraphicComponent,
	GridComponent,
	LegendComponent,
	MarkLineComponent,
	TitleComponent,
	TooltipComponent,
} from "echarts/components";
import { type EChartsType, init, use } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { ChartNoAxesCombined, Download, Expand, RefreshCw, Table2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ChartArtifact, type ChartReference, validateChartArtifact } from "../../chart-contracts.ts";
import { chartHeight, chartRequery, chartTime, chartZoomViewport, createChartOptions } from "../chart-options.ts";

use([
	LineChart,
	ScatterChart,
	BarChart,
	GridComponent,
	TooltipComponent,
	LegendComponent,
	DataZoomComponent,
	AriaComponent,
	TitleComponent,
	GraphicComponent,
	MarkLineComponent,
	SVGRenderer,
]);

function saveBlob(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export function AnalysisChartCard({
	reference,
	onRequery,
	disabled = false,
}: {
	reference: ChartReference;
	onRequery?: (text: string) => void;
	disabled?: boolean;
}) {
	const card = useRef<HTMLElement>(null),
		surface = useRef<HTMLDivElement>(null),
		instance = useRef<EChartsType | null>(null);
	const [visible, setVisible] = useState(false);
	const [data, setData] = useState<ChartArtifact | null>(null);
	const [error, setError] = useState("");
	const [actionError, setActionError] = useState("");
	const [showData, setShowData] = useState(false),
		[page, setPage] = useState(0),
		[exporting, setExporting] = useState(false);
	useEffect(() => {
		if (!card.current) return;
		const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "300px" });
		observer.observe(card.current);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		if (!visible || data) return;
		const controller = new AbortController();
		void fetch(`/api/tools/charts/${reference.id}.json`, { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) throw new Error("图表快照不可读取，可能已归档或本机服务不可用。");
				const chart = validateChartArtifact(await response.json());
				if (chart.id !== reference.id) throw new Error("图表编号不匹配。");
				if (!controller.signal.aborted) {
					setData(chart);
					setError("");
				}
			})
			.catch((failure: unknown) => {
				if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "图表加载失败。");
			});
		return () => controller.abort();
	}, [visible, data, reference.id]);
	useEffect(() => {
		if (!visible || !data || !surface.current) return;
		const element = surface.current;
		const chart = init(element, undefined, { renderer: "svg" });
		instance.current = chart;
		chart.setOption(createChartOptions(data, element.clientWidth));
		const observer = new ResizeObserver(() => chart.resize());
		observer.observe(element);
		return () => {
			observer.disconnect();
			chart.dispose();
			instance.current = null;
		};
	}, [visible, data]);
	const download = async (format: "png" | "svg") => {
		if (!data || !instance.current || exporting) return;
		setExporting(true);
		setActionError("");
		let exported: EChartsType | undefined;
		try {
			const zoom = chartZoomViewport(instance.current.getOption().dataZoom);
			const note = `导出当前横轴缩放：${(zoom?.[0]?.start ?? 0).toFixed(1)}%～${(zoom?.[0]?.end ?? 100).toFixed(1)}%；CSV包含完整快照。`;
			const width = 1000,
				height = chartHeight(data) + 300;
			exported = init(null, undefined, { renderer: "svg", ssr: true, width, height });
			exported.setOption(createChartOptions({ ...data, notes: [...data.notes, note] }, width, true));
			if (zoom) exported.setOption({ dataZoom: zoom });
			const svg = exported.renderToSVGString();
			if (format === "svg")
				saveBlob(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), `DCMA-${data.kind}-${data.id}.svg`);
			else {
				const svgUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
				try {
					const picture = new Image();
					await new Promise<void>((resolve, reject) => {
						picture.onload = () => resolve();
						picture.onerror = () => reject(new Error("图片转换失败。"));
						picture.src = svgUrl;
					});
					const canvas = document.createElement("canvas");
					canvas.width = width * 2;
					canvas.height = height * 2;
					const context = canvas.getContext("2d");
					if (!context) throw new Error("浏览器不支持图片导出。");
					context.fillStyle = "#fff";
					context.fillRect(0, 0, canvas.width, canvas.height);
					context.drawImage(picture, 0, 0, canvas.width, canvas.height);
					const blob = await new Promise<Blob>((resolve, reject) =>
						canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("PNG生成失败。"))), "image/png"),
					);
					saveBlob(blob, `DCMA-${data.kind}-${data.id}.png`);
				} finally {
					URL.revokeObjectURL(svgUrl);
				}
			}
		} catch (failure) {
			setActionError(failure instanceof Error ? failure.message : "图表下载失败。");
		} finally {
			exported?.dispose();
			setExporting(false);
		}
	};
	const enlarge = async () => {
		setActionError("");
		try {
			if (document.fullscreenElement === card.current) await document.exitFullscreen();
			else await card.current?.requestFullscreen();
		} catch {
			setActionError("浏览器未允许全屏，请检查设置。");
		}
	};
	const requery = () => {
		if (!data || !onRequery) return;
		onRequery(chartRequery(data));
	};
	const tableRows =
		data?.rows
			.slice(page * 50, page * 50 + 50)
			.map((cells, index) => ({ id: `${reference.id}/${page * 50 + index}`, cells })) ?? [];
	return (
		<section ref={card} className="analysis-chart-card" aria-label={data?.title ?? "分析图表"}>
			<header className="analysis-chart-heading">
				<span className="analysis-chart-icon">
					<ChartNoAxesCombined size={18} />
				</span>
				<div>
					<h3>{data?.title ?? "正在读取图表快照"}</h3>
					{data && (
						<p>
							{data.sources.map((source) => source.device ?? source.table).join(" / ")}
							<span className="analysis-chart-badge">
								{data.sources.some((source) => source.kind === "simulation") ? "模拟数据" : "历史真实采集"}
							</span>
						</p>
					)}
				</div>
			</header>
			{error ? (
				<p role="alert" className="analysis-chart-error">
					{error}
				</p>
			) : !data ? (
				<p className="analysis-chart-loading">正在加载已保存的数据…</p>
			) : (
				<>
					<div className="analysis-chart-scope">
						{data.sources.map((source, index) => (
							<p key={`${source.table}/${index}`}>
								{data.sources.length > 1 ? `${index ? "B" : "A"} · ` : ""}dcma.{source.table} ·{" "}
								{chartTime(source.from)} ～ {chartTime(source.to)}（北京时间）
							</p>
						))}
					</div>
					<div
						ref={surface}
						className="analysis-chart-surface"
						style={{ height: chartHeight(data) }}
						role="img"
						aria-label={`${data.title}，${data.sourceRecords}条来源记录；可打开数据视图阅读数值。`}
					/>
					<div className="analysis-chart-actions">
						<button type="button" onClick={() => void enlarge()}>
							<Expand size={14} />
							放大
						</button>
						<button type="button" aria-expanded={showData} onClick={() => setShowData(!showData)}>
							<Table2 size={14} />
							数据视图
						</button>
						<button type="button" disabled={exporting || !visible} onClick={() => void download("png")}>
							<Download size={14} />
							PNG
						</button>
						<button type="button" disabled={exporting || !visible} onClick={() => void download("svg")}>
							<Download size={14} />
							SVG
						</button>
						<a href={`/api/tools/charts/${data.id}.csv`} download>
							<Download size={14} />
							导出图表数据
						</a>
						{onRequery && (
							<button type="button" disabled={disabled} onClick={requery}>
								<RefreshCw size={14} />
								重新查询该时段
							</button>
						)}
					</div>
					{actionError && (
						<p role="alert" className="analysis-chart-error">
							{actionError}
						</p>
					)}
					{showData && (
						<div className="analysis-chart-data">
							<div className="analysis-chart-data-scroll">
								<table>
									<thead>
										<tr>
											{data.columns.map((column) => (
												<th key={column.key}>
													{column.label}
													{column.unit ? `（${column.unit}）` : ""}
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{tableRows.map((row) => (
											<tr key={row.id}>
												{row.cells.map((value, column) => (
													<td key={data.columns[column].key}>
														{value === null
															? "—"
															: data.columns[column].role === "time"
																? chartTime(String(value))
																: String(value)}
													</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</div>
							<div className="analysis-chart-pagination">
								<button type="button" disabled={!page} onClick={() => setPage(page - 1)}>
									上一页
								</button>
								<span>
									{page + 1}/{Math.max(1, Math.ceil(data.rows.length / 50))} · 共{data.rows.length}行
								</span>
								<button
									type="button"
									disabled={(page + 1) * 50 >= data.rows.length}
									onClick={() => setPage(page + 1)}
								>
									下一页
								</button>
							</div>
						</div>
					)}
					<footer className="analysis-chart-notes">
						<p>
							来源 {data.sourceRecords} 条 · 排除/缺失 {data.excluded} 条 · {data.aggregation} · 显示{" "}
							{data.displayRows.length} 行
						</p>
						<p>
							查询时间 {chartTime(data.sources[0].queriedAt)} ·{" "}
							{data.sources.some((source) => source.preview) ? "近期预览" : "完整受限窗口"}
						</p>
						{data.notes.map((note) => (
							<p key={note}>{note}</p>
						))}
					</footer>
				</>
			)}
		</section>
	);
}
