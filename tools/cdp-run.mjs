/**
 * CDP 驱动的真机自用验证（临时工具）
 * 直接在 WebView 里执行 JS，绕开坐标点击的不稳定性。
 * 用法：node tools/cdp-run.mjs "<js 表达式>"
 */
import WebSocket from 'ws';

const expr = process.argv[2];
const list = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
const page = list.find((p) => p.webSocketDebuggerUrl) || list[0];
const url = page.webSocketDebuggerUrl;

const ws = new WebSocket(url);
ws.on('open', () => {
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: expr, returnByValue: true, awaitPromise: true },
  }));
});
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id === 1) {
    const { result, exceptionDetails } = msg.result ?? msg;
    if (exceptionDetails) {
      console.log('EXCEPTION:', exceptionDetails.exception?.description || exceptionDetails.text);
      process.exit(2);
    }
    const v = result.value;
    console.log(typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v));
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (e) => { console.log('WS ERROR:', e.message); process.exit(3); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 15000);
