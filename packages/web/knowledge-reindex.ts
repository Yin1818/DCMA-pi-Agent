import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { buildFaultKnowledgeVectorIndex } from "./knowledge-vectors.ts";
import { getFaultKnowledgeIndex } from "./knowledge-index.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
try {
	loadEnvFile(resolve(root, ".env"));
} catch (error) {
	if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

try {
	const result = await buildFaultKnowledgeVectorIndex(await getFaultKnowledgeIndex());
	console.log(`向量索引已更新：${result.records} 条，模型 ${result.model}，维度 ${result.dimensions}`);
} catch (error) {
	console.error(error instanceof Error ? error.message : "向量索引构建失败");
	process.exitCode = 1;
}
