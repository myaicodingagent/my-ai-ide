// A fake Anthropic API for tests that run the agent on another machine (the cloud runner): `node fake-anthropic.cjs <port> [delay ms]`.
// It plays one script, chosen by how many assistant turns the conversation already has: write a file, run a command, say it is done.
// Requests are appended to <port>.requests.log in the current folder. Plain Node, no packages (it runs inside WSL or a container).
const http = require('http'), fs = require('fs')
const port = Number(process.argv[2] || 8799), delay = Number(process.argv[3] || 0)
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  res.end()
}
const start = () => [['message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }]]
const textBlock = (i, text) => [
  ['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text } }],
  ['content_block_stop', { type: 'content_block_stop', index: i }]
]
const toolBlock = (i, id, name, input) => [
  ['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id, name, input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
  ['content_block_stop', { type: 'content_block_stop', index: i }]
]
const end = (stop) => [['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }], ['message_stop', { type: 'message_stop' }]]
const toolReply = (pre, id, name, input) => [...start(), ...textBlock(0, pre), ...toolBlock(1, id, name, input), ...end('tool_use')]
const textReply = (t) => [...start(), ...textBlock(0, t), ...end('end_turn')]
const script = [
  () => toolReply('Creating the file. ', 'toolu_1', 'write_file', { path: 'cloud-made.txt', content: 'made on the server\n' }),
  () => toolReply('Checking it. ', 'toolu_2', 'run_command', { command: 'cat cloud-made.txt > cloud-ran.txt; echo ran-ok', timeout_seconds: 30 }),
  () => textReply('Done: cloud task finished.')
]
http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) } catch { /* not json */ }
    fs.appendFileSync(`${port}.requests.log`, JSON.stringify({ url: req.url, auth: req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer /i, ''), model: body.model, turns: (body.messages || []).length }) + '\n')
    const turn = (body.messages || []).filter((m) => m.role === 'assistant').length
    setTimeout(() => sse(res, (script[Math.min(turn, script.length - 1)])()), delay)
  })
}).listen(port, '127.0.0.1', () => console.log('fake api on ' + port))
