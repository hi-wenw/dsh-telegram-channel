import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RICH_MESSAGE_MAX_CHARS,
  splitRichMarkdown,
} from '../src/rich-format.ts'

test('splitRichMarkdown keeps small markdown as one chunk', () => {
  const markdown = '# 标题\n\n- a\n- b\n\n```js\nx\n```\n'
  assert.deepEqual(splitRichMarkdown(markdown), [markdown])
})

test('splitRichMarkdown splits long plain text without losing content', () => {
  const markdown = 'a'.repeat(RICH_MESSAGE_MAX_CHARS + 100)
  const chunks = splitRichMarkdown(markdown)
  assert.ok(chunks.length > 1)
  assert.equal(chunks.join(''), markdown)
})

test('splitRichMarkdown keeps long fenced code blocks balanced', () => {
  const opening = '```js\n'
  const closing = '\n```'
  const markdown = `${opening}${'x'.repeat(RICH_MESSAGE_MAX_CHARS + 1000)}${closing}`
  const chunks = splitRichMarkdown(markdown)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.trimStart().startsWith('```'), 'chunk should start with a fence')
    assert.ok(chunk.trimEnd().endsWith('```'), 'chunk should end with a fence')
  }
  assert.equal(chunks.join('').replace(/```js\n/g, '').replace(/\n```/g, ''), 'x'.repeat(RICH_MESSAGE_MAX_CHARS + 1000))
})
