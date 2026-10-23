import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanForWeChat, looksLikeTaskUnderstanding, splitChunks } from '../src/text.ts'

test('textutil: plain heading', () => {
  assert.equal(looksLikeTaskUnderstanding('【任务理解】统计 /tmp 文件'), true)
})

test('textutil: leading markdown and whitespace', () => {
  assert.equal(looksLikeTaskUnderstanding('  \n## 【任务理解】\n整理清单'), true)
  assert.equal(looksLikeTaskUnderstanding('- 【任务理解】检查端口'), true)
})

test('textutil: other text', () => {
  assert.equal(looksLikeTaskUnderstanding('我先看看目录结构'), false)
  assert.equal(looksLikeTaskUnderstanding('任务理解：...'), false)
  assert.equal(looksLikeTaskUnderstanding(''), false)
})

test('textutil: links and images', () => {
  const text = '看这个 ![图](https://x/y.png) 和 [文档](https://example.com)'
  assert.equal(cleanForWeChat(text), '看这个  和 文档')
})

test('textutil: lists and headings', () => {
  const text = '##### 小标题\n- 第一项\n* 第二项\n1. 编号项\n> 引用'
  assert.equal(cleanForWeChat(text), '小标题\n• 第一项\n• 第二项\n编号项\n引用')
})

test('textutil: code fence is preserved', () => {
  const text = "```python\nprint('hi')\n```"
  assert.equal(cleanForWeChat(text), text)
})

test('textutil: collapses blank lines', () => {
  assert.equal(cleanForWeChat('a\n\n\n\nb'), 'a\n\nb')
})

test('textutil: empty', () => {
  assert.deepEqual(splitChunks(''), [])
  assert.deepEqual(splitChunks('   \n\n'), [])
})

test('textutil: short text unchanged', () => {
  assert.deepEqual(splitChunks('你好，世界', 100), ['你好，世界'])
})

test('textutil: respects byte limit', () => {
  const chunks = splitChunks('中文段落。'.repeat(200), 300)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(Buffer.byteLength(chunk, 'utf8') <= 300)
})

test('textutil: hard split long line', () => {
  assert.deepEqual(splitChunks('x'.repeat(95), 10), [...Array<string>(9).fill('x'.repeat(10)), 'x'.repeat(5)])
})

test('textutil: prefers newlines and preserves content', () => {
  const text = Array.from({ length: 80 }, (_, index) => `第${index}行内容`).join('\n')
  const chunks = splitChunks(text, 120)
  assert.ok(chunks.length > 1)
  assert.ok(Math.max(...chunks.map((chunk) => Buffer.byteLength(chunk, 'utf8'))) <= 120)
  assert.equal(chunks.join('').replaceAll(/\s/g, ''), text.replaceAll(/\s/g, ''))
})
