/** Explicit paid acceptance run only. Never imported by unit tests or invoked by CI. */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

if (process.env.DCMA_RUN_LIVE_ACCEPTANCE !== "1")
	throw new Error("真实模型验收会消耗额度，须显式设置 DCMA_RUN_LIVE_ACCEPTANCE=1。");
const base = process.env.DCMA_ACCEPTANCE_URL ?? "http://127.0.0.1:3000";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error("验收只允许本机服务。");
const snapshotResponse = await fetch(`${base}/api/database/dashboard?table=real_data_01&limit=50`, {
	signal: AbortSignal.timeout(20000),
});
if (!snapshotResponse.ok) throw new Error("当前设备接口不可用，未发起付费模型验收。");
const snapshot = (await snapshotResponse.json()) as { queriedAt: string; latest?: { acquiredAt: string | null } };
if (!snapshot.latest?.acquiredAt) throw new Error("没有可用采集时间，未发起付费模型验收。");
const end = Date.parse(snapshot.latest.acquiredAt);
const beijing = (time: number) => new Date(time + 8 * 3600000).toISOString().replace("T", " ").slice(0, 23);
const window = `北京时间${beijing(end - 180000)}至${beijing(end)}`;
const first = `北京时间${beijing(end - 180000)}至${beijing(end - 90001)}`;
const second = `北京时间${beijing(end - 90000)}至${beijing(end)}`;
const prefix = "当前选择是dcma.real_data_01，模拟来源。";
interface Case {
	id: string;
	text: string;
	expected: string[];
}
const cases: Case[] = [
	{
		id: "catalog",
		text: "项目现在能读到哪些工业数据表，每张表有什么列？只查目录，不要读取采样。",
		expected: ["list_industrial_tables"],
	},
	{
		id: "snapshot",
		text: "看看当前来源最新的电机温度、电流和实际转速，注明采集时间，不算历史均值。",
		expected: ["read_industrial_dashboard"],
	},
	{
		id: "rows",
		text: "查询当前表中电机温度大于等于0的最新两条原始记录，只取编号、采集时间和电机温度，不要统计。",
		expected: ["read_industrial_rows"],
	},
	{
		id: "profile",
		text: "请查本机设备台账：当前设备有没有登记厂家、型号、单位和额定值？未配置的注明。不要根据采样猜测。",
		expected: ["get_device_profile"],
	},
	{
		id: "quality",
		text: `检查${window}的电机温度数据质量，最大允许采样间隔30秒，请报告缺失、重复和间断，暂时不统计均值。`,
		expected: ["check_data_quality"],
	},
	{
		id: "statistics",
		text: `对${window}的电机温度，以30秒最大采样间隔检查质量，再计算整个时段的均值、最大值和标准差，不要用最近100条代替。`,
		expected: ["summarize_metrics"],
	},
	{
		id: "comparison",
		text: `比较${first}和${second}两个时段的电机温度均值，给出后一段减前一段的差值和变化率。最大允许采样间隔30秒，只描述差异，不推断工况。`,
		expected: ["compare_metric_windows"],
	},
	{
		id: "threshold",
		text: `分析${window}电机温度连续超限事件。仅为验收的临时规则：单位℃，大于80触发，小于等于75恢复，最短持续30秒，最大采样间隔30秒，依据是用户本次验收规则。不要创建后台任务。`,
		expected: ["analyze_threshold_events"],
	},
	{
		id: "codes",
		text: `统计${window}观测到的故障和报警事件，连续同码合并，列代码和次数。不要解释厂家代码含义。`,
		expected: ["get_code_events"],
	},
	{
		id: "state",
		text: `评估${window}的设备状态，采样超过60秒视为过期。查已配置状态规则，缺少规则则明确未知，不要凭电流猜运行。`,
		expected: ["assess_device_state"],
	},
	{
		id: "fault_lookup",
		text: "请从本机已导入资料查询厂家Siemens、型号SINAMICS G120、资料版本验收未配置版本中的故障码F30001含义。查不到请明确未找到，不联网也不要凭记忆解释。",
		expected: ["lookup_fault_code"],
	},
	{
		id: "knowledge",
		text: "在本地已导入手册和维修案例里搜索电机温度过高散热排查，返回资料片段和出处。没有资料就如实说明，不需要查询数据库。",
		expected: ["search_maintenance_knowledge"],
	},
	{
		id: "evidence",
		text: `整理${window}的诊断证据包，包含设备资料、数据质量、温度和电流统计及故障报警事件。最大允许采样间隔30秒，根因保持未确认。只整理证据，不需要下载报告。`,
		expected: ["build_diagnostic_evidence"],
	},
	{
		id: "report",
		text: `检查${window}电机温度数据质量并计算均值和极值，然后生成可下载的Markdown和JSON证据报告。最大允许采样间隔30秒，请给下载链接，不要只给文字结论。`,
		expected: ["export_analysis_report"],
	},
	{
		id: "alerts",
		text: "查看本机后台最近20条告警及恢复记录，包括数据未知事件。不要新建或修改监测任务，也不要读取设备采样。",
		expected: ["get_alert_history"],
	},
	{
		id: "monitoring",
		text: "先列出现有后台任务。如果没有，请为当前模拟来源生成待我确认的监测提案：每60秒检查最近300秒，采样超过120秒视为过期，电机温度单位℃，大于80触发，小于等于75恢复，持续30秒且最大采样间隔60秒。依据是用户本次验收临时规则，只生成确认链接，不要启用、不要向外通知。",
		expected: ["manage_monitoring_task"],
	},
	{
		id: "relative",
		text: "过去三分钟电机温度平均多少、最高多少？只做统计，缺失不要当零，不判断故障。",
		expected: ["summarize_metrics"],
	},
	{
		id: "bundle_variant",
		text: `帮我把${window}的设备登记、温度和电流的完整统计、数据缺漏以及故障报警记录一起整理，方便交给维修人员。采样允许间隔30秒。现在只收集依据，先别断定原因，也不导出文件。`,
		expected: ["build_diagnostic_evidence"],
	},
	{
		id: "report_variant",
		text: `把${window}电机温度的平均、最高、最低值做成能保存到电脑的报告，两种格式都要：Markdown和JSON。不要做其他分析。`,
		expected: ["summarize_metrics", "export_analysis_report"],
	},
	{
		id: "compare_variant",
		text: `A段是${first}，B段是${second}。电流的采样均值B比A增加还是减少，百分比是多少？不需要查看最新采样。`,
		expected: ["compare_metric_windows"],
	},
	{
		id: "threshold_variant",
		text: `只查${window}电机温度大于80℃并持续至少30秒的次数和已观测持续时间；恢复界限75℃，采样断开超过30秒就中断事件。这些是我本次临时给的标准，不是厂家标准。不要变成后台监控。`,
		expected: ["analyze_threshold_events"],
	},
	{
		id: "clarification",
		text: `请告诉我${window}电机温度有没有持续超温。我的阈值、单位和允许采样间隔还没有确认，请先告诉我缺哪些条件，不要自行假设。`,
		expected: [],
	},
];
const allowed: Record<string, string[]> = {
	catalog: ["list_industrial_tables"],
	snapshot: ["read_industrial_dashboard", "get_device_profile"],
	rows: ["list_industrial_tables", "read_industrial_rows"],
	profile: ["get_device_profile"],
	quality: ["check_data_quality"],
	statistics: ["check_data_quality", "summarize_metrics"],
	comparison: ["check_data_quality", "compare_metric_windows"],
	threshold: ["analyze_threshold_events"],
	codes: ["get_code_events"],
	state: ["assess_device_state", "get_device_profile"],
	fault_lookup: ["lookup_fault_code"],
	knowledge: ["search_maintenance_knowledge"],
	evidence: ["build_diagnostic_evidence"],
	report: ["check_data_quality", "summarize_metrics", "build_diagnostic_evidence", "export_analysis_report"],
	alerts: ["get_alert_history"],
	monitoring: ["manage_monitoring_task"],
	relative: ["summarize_metrics"],
	bundle_variant: ["build_diagnostic_evidence"],
	report_variant: ["summarize_metrics", "export_analysis_report"],
	compare_variant: ["compare_metric_windows"],
	threshold_variant: ["analyze_threshold_events"],
	clarification: [],
};
const requested = process.argv.slice(2);
const selected = requested.length ? cases.filter((item) => requested.includes(item.id)) : cases.slice(0, 16);
if (!selected.length) throw new Error("未找到验收用例。");
const directory = fileURLToPath(new URL("../.dcma-runtime/acceptance/", import.meta.url));
await mkdir(directory, { recursive: true, mode: 0o700 });
const results: Record<string, unknown>[] = [];
const file = `${directory}/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
for (const item of selected) {
	const started = Date.now();
	const events: Record<string, unknown>[] = [];
	let answer = "";
	let error: string | null = null;
	try {
		const response = await fetch(`${base}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-DCMA-Client": "web" },
			body: JSON.stringify({
				model: "deepseek/deepseek-flash",
				table: "real_data_01",
				database: true,
				text: item.text,
				context: prefix,
				history: [],
			}),
			signal: AbortSignal.timeout(125000),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		if (!response.body) throw new Error("没有响应流");
		let buffer = "",
			done = false;
		const decoder = new TextDecoder();
		const consume = (line: string) => {
			if (!line.trim()) return;
			const event = JSON.parse(line) as Record<string, unknown>;
			if (event.type === "delta") answer += String(event.text ?? "");
			else {
				events.push(event);
				if (event.type === "done") done = true;
				if (event.type === "error") error = String(event.message);
			}
		};
		for await (const chunk of response.body) {
			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) consume(line);
		}
		buffer += decoder.decode();
		consume(buffer);
		if (!done && !error) error = "流未正常结束";
	} catch (failure) {
		error = failure instanceof Error ? failure.message : "请求失败";
	}
	const starts = events.filter((event) => event.type === "tool_start");
	const ends = events.filter((event) => event.type === "tool_end");
	const used = starts.map((event) => String(event.tool));
	const missing = item.expected.filter((name) => !used.includes(name));
	const failed = ends.filter((event) => event.ok !== true).map((event) => String(event.tool));
	const unnecessary = used.filter((name) => !allowed[item.id]?.includes(name));
	if (
		used.includes("build_diagnostic_evidence") &&
		used.some((name) =>
			["check_data_quality", "summarize_metrics", "get_code_events", "get_device_profile"].includes(name),
		)
	)
		unnecessary.push("duplicated_bundle_components");
	for (const name of new Set(used)) {
		const maximum =
			name === "manage_monitoring_task" || (name === "check_data_quality" && item.id === "comparison") ? 2 : 1;
		if (used.filter((value) => value === name).length > maximum) unnecessary.push(`repeated:${name}`);
	}
	const semanticErrors: string[] = [];
	if (starts.length !== ends.length) semanticErrors.push("unfinished_tool_calls");
	for (const event of starts) {
		const parameters = event.parameters as Record<string, unknown>;
		const ranges = parameters.a && parameters.b ? [parameters.a, parameters.b] : [parameters];
		for (const [index, value] of ranges.entries()) {
			const range = value as Record<string, unknown>;
			if (typeof range.from !== "string" || typeof range.to !== "string") continue;
			const from = Date.parse(range.from),
				to = Date.parse(range.to);
			if (item.id === "relative") {
				if (Math.abs(to - started) > 30000 || Math.abs(to - from - 180000) > 2000)
					semanticErrors.push("relative_time_mismatch");
			} else {
				const comparison = item.id === "comparison" || item.id === "compare_variant";
				const expectedFrom = comparison && index === 1 ? end - 90000 : end - 180000;
				const expectedTo = comparison && index === 0 && ranges.length === 2 ? end - 90001 : end;
				// Separate quality calls may target either of the two comparison windows.
				const qualityRange =
					comparison &&
					ranges.length === 1 &&
					((from === end - 180000 && to === end - 90001) || (from === end - 90000 && to === end));
				if (!qualityRange && (from !== expectedFrom || to !== expectedTo))
					semanticErrors.push("requested_time_mismatch");
			}
		}
	}
	const tokens = events
		.filter((event) => event.type === "usage")
		.reduce((sum, event) => sum + Number(event.totalTokens ?? 0), 0);
	const downloads: { path: string; status: number }[] = [];
	for (const path of new Set(answer.match(/\/api\/tools\/reports\/[0-9a-f-]{36}\.(?:md|json)/g) ?? [])) {
		const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10000) });
		downloads.push({ path, status: response.status });
		await response.body?.cancel();
	}
	if (
		(item.id === "report" || item.id === "report_variant") &&
		(downloads.length !== 2 || !/\]\(\/api\/tools\/reports\//.test(answer))
	)
		semanticErrors.push("download_links_missing");
	if (downloads.some((entry) => entry.status !== 200)) semanticErrors.push("download_failed");
	if (item.id === "monitoring") {
		const path = answer.match(/\/api\/monitoring\/confirm\/[0-9a-f-]{36}/)?.[0];
		if (!path || !ends.some((event) => (event.summary as Record<string, unknown>)?.status === "pending_confirmation"))
			semanticErrors.push("confirmation_proposal_missing");
		else {
			const page = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10000) });
			if (page.status !== 200 || !(await page.text()).includes("确认执行此操作"))
				semanticErrors.push("confirmation_page_unavailable");
		}
	}
	const result = {
		id: item.id,
		question: item.text,
		expected: item.expected,
		used,
		missing,
		failed,
		unnecessary,
		semanticErrors,
		error,
		durationMs: Date.now() - started,
		tokens,
		events,
		answer,
		downloads,
	};
	results.push(result);
	if (missing.length || failed.length || unnecessary.length || semanticErrors.length || error) process.exitCode = 1;
	await writeFile(
		file,
		JSON.stringify(
			{ model: "deepseek/deepseek-flash", source: "live_project_mysql", date: new Date().toISOString(), results },
			null,
			2,
		),
		{ mode: 0o600 },
	);
	console.log(
		JSON.stringify({
			id: item.id,
			used,
			missing,
			failed,
			unnecessary,
			semanticErrors,
			error,
			tokens,
			seconds: Math.round(result.durationMs / 1000),
			downloads: downloads.map((entry) => entry.status),
		}),
	);
}
console.log(`Private evidence: ${file}`);
