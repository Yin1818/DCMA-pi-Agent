import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { getFaultKnowledgeHealth, getFaultKnowledgeIndex, searchFaultKnowledge } from "../knowledge-index.ts";
import { buildFaultKnowledgeVectorIndex, getVectorIndexPath } from "../knowledge-vectors.ts";

test("knowledge search uses cloud vectors while retaining exact fault-code matches", async () => {
	const vectorPath = getVectorIndexPath();
	let previousVectorIndex: Buffer | undefined;
	try {
		previousVectorIndex = await readFile(vectorPath);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const previous = {
		baseUrl: process.env.EMBEDDING_BASE_URL,
		apiKey: process.env.EMBEDDING_API_KEY,
		model: process.env.EMBEDDING_MODEL,
		fetch: globalThis.fetch,
	};
	process.env.EMBEDDING_BASE_URL = "https://mock.invalid/v1";
	process.env.EMBEDDING_API_KEY = "mock-key";
	process.env.EMBEDDING_MODEL = "mock-embedding-model";
	let embeddingRequests = 0;
	let throttleNextRequest = false;
	globalThis.fetch = async (_input, init) => {
		embeddingRequests++;
		if (throttleNextRequest) {
			throttleNextRequest = false;
			return new Response(null, { status: 429 });
		}
		const body = JSON.parse(String(init?.body)) as { input: string[] };
		return Response.json({
			data: body.input.map((value, index) => ({
				index,
				embedding: /语义测试召回|额定电流/u.test(value) ? [1, 0] : [0, 1],
			})),
		});
	};
	try {
		const records = await getFaultKnowledgeIndex();
		const built = await buildFaultKnowledgeVectorIndex(records);
		assert.equal(built.records, records.length);
		const semantic = await searchFaultKnowledge({ q: "语义测试召回", limit: 3 });
		assert.equal(embeddingRequests, 28);
		assert.equal(semantic.retrieval, "hybrid");
		const topMatch = semantic.results[0];
		assert.ok(topMatch);
		assert.ok(topMatch.text.includes("额定电流"));
		assert.ok(topMatch.source_file);
		const exact = await searchFaultKnowledge({ code: "F0011", limit: 3 });
		assert.ok(exact.results[0]?.codes.includes("F0011"));
		assert.equal(embeddingRequests, 28, "fault-code lookup should remain exact and avoid a query embedding call");
		const inferredCode = await searchFaultKnowledge({ q: "F0011 是什么故障？", limit: 3 });
		assert.equal(inferredCode.code, "F0011");
		assert.equal(inferredCode.count, 1);
		assert.ok(inferredCode.results[0]?.codes.includes("F0011"));
		assert.equal(embeddingRequests, 28, "a fault code embedded in the query should avoid a query embedding call");
		const health = await getFaultKnowledgeHealth();
		assert.ok(health.ok);
		assert.equal("vectors" in health ? health.vectors?.ready : false, true);
		throttleNextRequest = true;
		const retried = await searchFaultKnowledge({ q: "限流后重试", limit: 3 });
		assert.equal(retried.retrieval, "hybrid");
		assert.equal(embeddingRequests, 30, "HTTP 429 should be retried once before succeeding");
		process.env.EMBEDDING_MODEL = "changed-model";
		const stale = await searchFaultKnowledge({ q: "索引配置变更", limit: 3 });
		assert.equal(stale.retrieval, "keyword");
		assert.match(stale.retrieval_notice ?? "", /不匹配/u);
	} finally {
		globalThis.fetch = previous.fetch;
		for (const [key, value] of [
			["EMBEDDING_BASE_URL", previous.baseUrl],
			["EMBEDDING_API_KEY", previous.apiKey],
			["EMBEDDING_MODEL", previous.model],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (previousVectorIndex) await writeFile(vectorPath, previousVectorIndex);
		else await unlink(vectorPath).catch(() => {});
	}
});
