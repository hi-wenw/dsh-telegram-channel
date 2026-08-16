export const RICH_MESSAGE_MAX_CHARS = 32768
export const RICH_MESSAGE_MAX_BLOCKS = 500

function normalizeTelegramNativeMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let fence: { marker: '`' | '~'; length: number } | undefined
  let displayMath = false

  const hasClosingDisplayMathDelimiter = (source: string[], index: number): boolean => {
    for (let i = index + 1; i < source.length; i++) {
      if (source[i]!.trim() === '$$') return true
      if (/^ {0,3}(`{3,}|~{3,})/.test(source[i]!)) return false
    }
    return false
  }

  return lines
    .map((line, index) => {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
      const inFence = fence !== undefined

      if (!inFence && line.trim() === '$$') {
        if (displayMath) {
          displayMath = false
          return '```'
        }
        if (hasClosingDisplayMathDelimiter(lines, index)) {
          displayMath = true
          return '```math'
        }
      }

      if (displayMath) return line

      if (!inFence && fenceMatch) {
        const markerText = fenceMatch[1]!
        fence = {
          marker: markerText[0] as '`' | '~',
          length: markerText.length,
        }
        return line
      }

      if (
        inFence
        && new RegExp(`^ {0,3}${fence!.marker}{${fence!.length},}\\s*$`).test(line)
      ) {
        fence = undefined
        return line
      }

      return line
    })
    .join('\n')
}

function countTelegramNativeMarkdownBlocks(block: string): number {
  if (/^ {0,3}(`{3,}|~{3,})/.test(block)) return 1
  const lines = block.split('\n').filter((line) => line.trim().length > 0)
  if (lines.some((line) => /^\s*([-*+] |\d+\. |>|\|)/.test(line))) {
    return Math.max(1, lines.length)
  }
  return 1
}

function splitTelegramNativeMarkdownBlocks(markdown: string): string[] {
  const blocks: string[] = []
  const current: string[] = []
  let fence: { marker: '`' | '~'; length: number } | undefined

  const flush = (): void => {
    if (current.length === 0) return
    blocks.push(current.join('\n'))
    current.length = 0
  }

  for (const line of markdown.split('\n')) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)

    if (!fence && line.trim().length === 0) {
      flush()
      continue
    }

    current.push(line)

    if (!fence && fenceMatch) {
      const markerText = fenceMatch[1]!
      fence = { marker: markerText[0] as '`' | '~', length: markerText.length }
      continue
    }

    if (
      fence
      && new RegExp(`^ {0,3}${fence!.marker}{${fence!.length},}\\s*$`).test(line)
    ) {
      fence = undefined
    }
  }

  flush()
  return blocks
}

function splitTelegramNativeMarkdownCountedBlocks(block: string): string[] {
  if (countTelegramNativeMarkdownBlocks(block) <= RICH_MESSAGE_MAX_BLOCKS) {
    return [block]
  }

  const chunks: string[] = []
  let current: string[] = []
  let fence: { marker: '`' | '~'; length: number } | undefined

  for (const line of block.split('\n')) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)

    if (!fence && current.length >= RICH_MESSAGE_MAX_BLOCKS) {
      chunks.push(current.join('\n'))
      current = []
    }

    current.push(line)

    if (!fence && fenceMatch) {
      const markerText = fenceMatch[1]!
      fence = { marker: markerText[0] as '`' | '~', length: markerText.length }
      continue
    }

    if (
      fence
      && new RegExp(`^ {0,3}${fence!.marker}{${fence!.length},}\\s*$`).test(line)
    ) {
      fence = undefined
    }
  }

  if (current.length > 0) chunks.push(current.join('\n'))
  return chunks
}

function findTelegramNativeMarkdownSplitIndex(
  text: string,
  hardLimit = RICH_MESSAGE_MAX_CHARS,
): number {
  const paragraphIndex = text.lastIndexOf('\n\n', hardLimit)
  if (paragraphIndex > 0) return paragraphIndex + 2
  const lineIndex = text.lastIndexOf('\n', hardLimit)
  if (lineIndex > 0) return lineIndex + 1
  const spaceIndex = text.lastIndexOf(' ', hardLimit)
  if (spaceIndex > 0) return spaceIndex + 1
  return hardLimit
}

function splitTelegramNativeMarkdownWrappedContent(
  content: string,
  maxContentLength: number,
  wrap: (chunk: string) => string,
): string[] {
  const chunks: string[] = []
  let remaining = content

  while (remaining.length > maxContentLength) {
    const window = remaining.slice(0, maxContentLength + 1)
    const splitIndex = findTelegramNativeMarkdownSplitIndex(window, maxContentLength)
    chunks.push(wrap(remaining.slice(0, splitIndex)))
    remaining = remaining.slice(splitIndex)
  }

  if (remaining.length > 0) chunks.push(wrap(remaining))
  return chunks
}

function splitTelegramNativeMarkdownLongFenceBlock(block: string): string[] | undefined {
  const lines = block.split('\n')
  const opening = lines[0] ?? ''
  const closing = lines[lines.length - 1] ?? ''
  const openingMatch = opening?.match(/^ {0,3}(`{3,}|~{3,})/)

  if (!openingMatch || !closing || lines.length < 2) return undefined

  const markerText = openingMatch[1] ?? '```'
  const marker = markerText[0] as '`' | '~'
  if (!new RegExp(`^ {0,3}${marker}{${markerText.length},}\\s*$`).test(closing)) {
    return undefined
  }

  const maxContentLength = RICH_MESSAGE_MAX_CHARS - opening.length - closing.length - 2
  if (maxContentLength <= 0) return undefined

  const content = lines.slice(1, -1).join('\n')
  return splitTelegramNativeMarkdownWrappedContent(
    content,
    maxContentLength,
    (chunk) => `${opening}\n${chunk}${chunk.endsWith('\n') ? '' : '\n'}${closing}`,
  )
}

function splitTelegramNativeMarkdownLongWrappedInlineBlock(block: string): string[] | undefined {
  const delimiter = ['**', '__', '~~', '`', '*', '_'].find(
    (candidate) =>
      block.startsWith(candidate)
      && block.endsWith(candidate)
      && block.length > candidate.length * 2,
  )

  if (!delimiter) return undefined

  const maxContentLength = RICH_MESSAGE_MAX_CHARS - delimiter.length * 2
  if (maxContentLength <= 0) return undefined

  return splitTelegramNativeMarkdownWrappedContent(
    block.slice(delimiter.length, -delimiter.length),
    maxContentLength,
    (chunk) => `${delimiter}${chunk}${delimiter}`,
  )
}

function splitTelegramNativeMarkdownLongPlainBlock(block: string): string[] {
  const chunks: string[] = []
  let remaining = block

  while (remaining.length > RICH_MESSAGE_MAX_CHARS) {
    const window = remaining.slice(0, RICH_MESSAGE_MAX_CHARS + 1)
    const splitIndex = findTelegramNativeMarkdownSplitIndex(window)
    chunks.push(remaining.slice(0, splitIndex).trimEnd())
    remaining = remaining.slice(splitIndex).trimStart()
  }

  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

function splitTelegramNativeMarkdownLongBlock(block: string): string[] {
  return (
    splitTelegramNativeMarkdownLongFenceBlock(block)
    ?? splitTelegramNativeMarkdownLongWrappedInlineBlock(block)
    ?? splitTelegramNativeMarkdownLongPlainBlock(block)
  )
}

export function splitRichMarkdown(markdown: string): string[] {
  const normalizedMarkdown = normalizeTelegramNativeMarkdown(markdown)

  if (
    normalizedMarkdown.length <= RICH_MESSAGE_MAX_CHARS
    && countTelegramNativeMarkdownBlocks(normalizedMarkdown) <= RICH_MESSAGE_MAX_BLOCKS
  ) {
    return [normalizedMarkdown]
  }

  const chunks: string[] = []
  let current = ''
  let currentBlockCount = 0

  for (const rawBlock of splitTelegramNativeMarkdownBlocks(normalizedMarkdown)) {
    for (const block of splitTelegramNativeMarkdownCountedBlocks(rawBlock)) {
      const blockCount = countTelegramNativeMarkdownBlocks(block)
      const candidate = current ? `${current}\n\n${block}` : block
      const exceedsChars = candidate.length > RICH_MESSAGE_MAX_CHARS
      const exceedsBlocks = currentBlockCount + blockCount > RICH_MESSAGE_MAX_BLOCKS

      if (!exceedsChars && !exceedsBlocks) {
        current = candidate
        currentBlockCount += blockCount
        continue
      }

      if (current) chunks.push(current.trimEnd())

      if (
        block.length <= RICH_MESSAGE_MAX_CHARS
        && blockCount <= RICH_MESSAGE_MAX_BLOCKS
      ) {
        current = block
        currentBlockCount = blockCount
        continue
      }

      chunks.push(...splitTelegramNativeMarkdownLongBlock(block))
      current = ''
      currentBlockCount = 0
    }
  }

  if (current) chunks.push(current.trimEnd())
  return chunks
}
