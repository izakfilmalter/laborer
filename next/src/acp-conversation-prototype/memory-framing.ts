export const MEMORY_ENTRY_FRAME_START = "<!-- laborer-memory-entry:start -->\n";
export const MEMORY_ENTRY_FRAME_END = "\n<!-- laborer-memory-entry:end -->";
const MEMORY_ENTRY_SEPARATOR = "\n\n";

export interface FramedMemoryEntry {
  readonly content: string;
  readonly contentEnd: number;
  readonly contentStart: number;
  readonly frameEnd: number;
  readonly frameStart: number;
}

export const containsMemoryEntryFrameDelimiter = (value: string): boolean =>
  value.includes(MEMORY_ENTRY_FRAME_START.trimEnd()) ||
  value.includes(MEMORY_ENTRY_FRAME_END.trimStart());

export const renderFramedMemoryEntry = (content: string): string =>
  `${MEMORY_ENTRY_FRAME_START}${content}${MEMORY_ENTRY_FRAME_END}`;

export const framedMemoryEntries = (
  source: string
): readonly FramedMemoryEntry[] => {
  const entries: FramedMemoryEntry[] = [];
  let fromIndex = 0;
  while (fromIndex < source.length) {
    const frameStart = source.indexOf(MEMORY_ENTRY_FRAME_START, fromIndex);
    if (frameStart === -1) {
      break;
    }
    const startsAtEntryBoundary =
      frameStart === 0 ||
      source.slice(frameStart - MEMORY_ENTRY_SEPARATOR.length, frameStart) ===
        MEMORY_ENTRY_SEPARATOR;
    if (!startsAtEntryBoundary) {
      fromIndex = frameStart + 1;
      continue;
    }
    const contentStart = frameStart + MEMORY_ENTRY_FRAME_START.length;
    const endStart = source.indexOf(MEMORY_ENTRY_FRAME_END, contentStart);
    if (endStart === -1) {
      break;
    }
    const nestedStart = source.indexOf(MEMORY_ENTRY_FRAME_START, contentStart);
    if (nestedStart !== -1 && nestedStart < endStart) {
      fromIndex = nestedStart;
      continue;
    }
    const frameEnd = endStart + MEMORY_ENTRY_FRAME_END.length;
    const endsAtEntryBoundary =
      frameEnd === source.length ||
      source.slice(frameEnd, frameEnd + MEMORY_ENTRY_SEPARATOR.length) ===
        MEMORY_ENTRY_SEPARATOR;
    if (!endsAtEntryBoundary) {
      fromIndex = frameStart + 1;
      continue;
    }
    entries.push({
      content: source.slice(contentStart, endStart),
      contentEnd: endStart,
      contentStart,
      frameEnd,
      frameStart,
    });
    fromIndex = frameEnd;
  }
  return entries;
};

export const stripMemoryEntryFraming = (source: string): string => {
  const visibleParts: string[] = [];
  let fromIndex = 0;
  for (const entry of framedMemoryEntries(source)) {
    visibleParts.push(source.slice(fromIndex, entry.frameStart), entry.content);
    fromIndex = entry.frameEnd;
  }
  visibleParts.push(source.slice(fromIndex));
  return visibleParts.join("");
};
