import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { chartCsv, readChart } from "./chart-files.ts";
import type { IndustrialServices } from "./index.ts";
import { createIndustrialTools } from "./index.ts";
import { readReport } from "./runtime-files.ts";

function json(response: ServerResponse, status: number, data: unknown) {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(JSON.stringify(data));
}

/** Returns false when the request belongs to the chat/database/static handlers. */
export async function handleToolHttp(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	services: IndustrialServices,
): Promise<boolean> {
	if (url.pathname.startsWith("/api/tools/charts/")) {
		if (request.method !== "GET") {
			json(response, 405, { error: "仅支持 GET" });
			return true;
		}
		const match = /^\/api\/tools\/charts\/([0-9a-f-]{36})\.(json|csv)$/.exec(url.pathname);
		try {
			if (!match) throw new Error("无效编号");
			const artifact = await readChart(services.directory, match[1]);
			if (match[2] === "json") json(response, 200, artifact);
			else {
				response.writeHead(200, {
					"Content-Type": "text/csv; charset=utf-8",
					"Content-Disposition": `attachment; filename="DCMA-chart-${artifact.id}.csv"`,
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff",
				});
				response.end(chartCsv(artifact));
			}
		} catch {
			json(response, 404, { error: "图表不存在、已被归档或快照不可读取。" });
		}
		return true;
	}
	if (url.pathname === "/api/tools") {
		if (request.method !== "GET") json(response, 405, { error: "仅支持 GET" });
		else
			json(response, 200, {
				tools: createIndustrialTools("real_data_01", services).map(({ name, label, description, parameters }) => ({
					name,
					label,
					description,
					parameters,
				})),
			});
		return true;
	}
	if (url.pathname.startsWith("/api/tools/reports/")) {
		if (request.method !== "GET") {
			json(response, 405, { error: "仅支持 GET" });
			return true;
		}
		const name = url.pathname.slice("/api/tools/reports/".length);
		try {
			const content = await readReport(services.directory, name);
			response.writeHead(200, {
				"Content-Type": name.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
				"Content-Disposition": `attachment; filename="DCMA-${name}"`,
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "no-store",
			});
			response.end(content);
		} catch {
			json(response, 404, { error: "报告不存在或不可读取。" });
		}
		return true;
	}
	if (!url.pathname.startsWith("/api/monitoring/confirm/")) return false;
	const id = url.pathname.slice("/api/monitoring/confirm/".length);
	if (request.method === "GET") {
		const proposal = services.monitoring.getProposal(id);
		if (!proposal) {
			json(response, 404, { error: "操作已过期或已确认，请重新生成。" });
			return true;
		}
		const description = JSON.stringify(proposal, null, 2).replace(
			/[&<>"']/g,
			(character) => `&#${character.charCodeAt(0)};`,
		);
		const nonce = randomUUID();
		response.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Frame-Options": "DENY",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
		});
		response.end(
			`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>确认后台监测操作</title><style>body{font:16px system-ui;max-width:800px;margin:40px auto;padding:20px;background:#f5f7fb;color:#18233b}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:20px}button{padding:12px 24px;cursor:pointer}a{display:block;margin-top:20px}</style><h1>确认后台监测操作</h1><p>请核对设备、来源、规则与周期。确认后仅进行数据库只读查询并保存本机告警，不控制设备、不发送外部通知。关闭网页后，任务在本机后端运行期间继续；退出后端即停止执行，重启后恢复此前确认的活动任务。</p><pre>${description}</pre><button id="confirm">确认执行此操作</button><p id="status" role="status"></p><a href="/">返回 Agent 对话</a><script nonce="${nonce}">const button=document.getElementById('confirm');button.onclick=async()=>{button.disabled=true;try{const response=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json','X-DCMA-Client':'web'},body:'{}'});const result=await response.json();document.getElementById('status').textContent=response.ok?'已确认执行。请返回对话查询任务状态。':result.error;}catch{document.getElementById('status').textContent='请求失败，请查询任务状态后再决定是否重新操作。';}};</script></html>`,
		);
		return true;
	}
	if (request.method !== "POST") {
		json(response, 405, { error: "仅支持 GET 或 POST" });
		return true;
	}
	if (request.headers["x-dcma-client"] !== "web" || !request.headers["content-type"]?.startsWith("application/json")) {
		json(response, 403, { error: "必须在本机确认页面操作。" });
		return true;
	}
	try {
		json(response, 200, await services.monitoring.confirmProposal(id));
	} catch {
		json(response, 409, { error: "确认失败，操作可能已过期或本地存储不可用。请重新查询任务状态。" });
	}
	return true;
}
