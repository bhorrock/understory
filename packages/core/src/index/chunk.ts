/**
 * Concept → embedding chunks. Bodies are split on top-level "# " headings,
 * oversize pieces are sub-split on paragraph boundaries, and EVERY chunk is
 * prefixed with a `title — description:` identity line so a chunk carries its
 * own topical anchor into the vector space (helps recall when the body text is
 * terse or shares vocabulary with unrelated concepts).
 */

/** A body chunk: its ordinal within the concept and the (prefixed) text. */
export interface Chunk {
  seq: number;
  text: string;
}

/** Minimal concept shape the chunker needs (decoupled from the full Concept). */
export interface ChunkInput {
  path: string;
  frontmatter: { title?: unknown; description?: unknown };
  body: string;
}

/** Sub-split threshold: pieces longer than this are broken on paragraphs. */
const MAX_PIECE_CHARS = 1400;
/** Never emit more than this many chunks for one concept. */
const MAX_CHUNKS = 24;

export function chunkConcept(c: ChunkInput): Chunk[] {
  const title = typeof c.frontmatter.title === "string" && c.frontmatter.title.trim()
    ? c.frontmatter.title
    : c.path;
  const description =
    typeof c.frontmatter.description === "string" ? c.frontmatter.description : "";
  const prefix = `${title} — ${description}:\n`;

  const pieces: string[] = [];
  for (const section of splitOnH1(c.body)) {
    for (const piece of subSplit(section, MAX_PIECE_CHARS)) {
      const trimmed = piece.trim();
      if (trimmed.length > 0) pieces.push(trimmed);
    }
  }
  // Bodyless (or heading-only) concepts still get one chunk carrying the
  // identity prefix — title/description are the semantically-rich part.
  if (pieces.length === 0) pieces.push("");

  return pieces.slice(0, MAX_CHUNKS).map((text, seq) => ({
    seq,
    text: prefix + text,
  }));
}

/**
 * Split a markdown body into sections that each begin at a top-level "# "
 * heading. `^#\s` matches a single-hash H1 but not `## ` (H2+), since the second
 * char there is `#`, not whitespace. Content before the first H1 is its own
 * section.
 */
function splitOnH1(body: string): string[] {
  const lines = body.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  const isH1 = (line: string) => /^#\s+/.test(line);
  for (const line of lines) {
    if (isH1(line) && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join("\n"));
  return sections;
}

/**
 * Break a piece longer than `max` on paragraph (blank-line) boundaries,
 * greedily packing paragraphs into <= max-sized buffers. A single paragraph
 * that alone exceeds `max` is hard-split by length so nothing is dropped.
 */
function subSplit(section: string, max: number): string[] {
  if (section.length <= max) return [section];
  const paragraphs = section.split(/\n{2,}/);
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.length > 0) out.push(buf);
    buf = "";
  };
  for (const para of paragraphs) {
    if (para.length > max) {
      flush();
      for (let i = 0; i < para.length; i += max) out.push(para.slice(i, i + max));
      continue;
    }
    if (buf.length === 0) {
      buf = para;
    } else if (buf.length + 2 + para.length <= max) {
      buf = `${buf}\n\n${para}`;
    } else {
      flush();
      buf = para;
    }
  }
  flush();
  return out;
}
