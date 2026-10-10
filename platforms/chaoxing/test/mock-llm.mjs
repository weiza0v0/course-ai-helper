/**
 * 本地 mock 大模型服务（OpenAI 兼容 /chat/completions），仅用于自检：
 * 第一次调用返回一个 calc 工具调用，拿到工具结果后第二次调用返回最终答案 JSON。
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8899);

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch {}
      const messages = payload.messages || [];
      const userMsg = messages.find(m => m.role === 'user');
      const images = Array.isArray(userMsg && userMsg.content)
        ? userMsg.content.filter(p => p.type === 'image_url').length : 0;
      const usedTool = messages.some(m => m.role === 'tool');

      let message;
      if (!usedTool) {
        message = {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {name: 'calc', arguments: JSON.stringify({expression: 'det([[1,0,2,1],[0,-1,3,-1],[-1,-1,5,-1],[-1,1,4,0]])'})},
          }],
        };
      } else {
        const toolMsg = messages.filter(m => m.role === 'tool').pop();
        message = {
          role: 'assistant',
          content: JSON.stringify({
            answer: 'D',
            confidence: 0.99,
            reason: `mock 模型：收到 ${images} 张图片，calc 返回 ${String(toolMsg && toolMsg.content).split('\n').pop()}`,
            evidence: 'calc',
          }),
        };
      }
      const out = JSON.stringify({id: 'chatcmpl-mock', object: 'chat.completion', model: payload.model || 'mock',
        choices: [{index: 0, message, finish_reason: 'stop'}], usage: {prompt_tokens: 10, completion_tokens: 10, total_tokens: 20}});
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(out);
    });
    return;
  }
  res.writeHead(404, {'Content-Type': 'application/json'});
  res.end('{"error":{"message":"not found"}}');
});

server.listen(PORT, '127.0.0.1', () => console.log('mock-llm on ' + PORT));
