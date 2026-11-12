// 실행 중인 teapot-agent 허브를 종료한다. 사용: npm run hub:stop
const port = Number(process.env.TEAPOT_BRIDGE_PORT ?? 18765);
try {
  const r = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Teapot-Agent": "1" },
    body: "{}",
    signal: AbortSignal.timeout(3000),
  });
  console.log(r.ok ? "허브를 종료했습니다." : `허브 종료 요청 실패 (HTTP ${r.status})`);
} catch {
  console.log(`실행 중인 허브가 없습니다 (포트 ${port}).`);
}
