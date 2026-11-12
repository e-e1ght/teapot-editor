// 개발용: MCP 서버를 띄우고 탭 연결을 기다린 뒤 도구를 차례로 호출한다.
// 사용: node scripts/try.mjs '[["teapot_status",{}],["teapot_overview",{}]]'
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const calls = JSON.parse(process.argv[2] ?? '[["teapot_status",{}]]');

const client = new Client({ name: "try", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "server/index.js")], stderr: "inherit" }));

const out = (r) => r.content.map((c) => c.text).join("\n");
const deadline = Date.now() + 90_000;
for (;;) {
  const s = JSON.parse(out(await client.callTool({ name: "teapot_status", arguments: {} })));
  if (s.tabs.length) { console.log("탭 연결됨:", JSON.stringify(s.tabs)); break; }
  if (Date.now() > deadline) { console.log("탭 연결 대기 시간 초과", JSON.stringify(s)); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1000));
}
for (const [name, args] of calls) {
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n=== ${name} ${r.isError ? "(오류)" : ""}\n${out(r).slice(0, 4000)}`);
}
await client.close();
process.exit(0);
