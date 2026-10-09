/**
 * Minimal XML value-extraction helpers built on the browser-native
 * `DOMParser`. OOXML parts are XML documents whose namespace prefixes vary by
 * producer (`a:t`, `t`, or none at all), so every lookup here matches on the
 * *local* name and ignores the namespace URI entirely.
 *
 * Attribute names carry prefixes just as element names do (`w:val`,
 * `r:id`), so reads go through {@link attr}, which matches on local name.
 *
 * Known simplifications:
 * - No XPath, no namespace-aware queries, no entity-level validation beyond
 *   what `DOMParser` itself rejects. This is deliberately a value reader, not
 *   a DOM abstraction layer.
 * - `findAll` first tries the direct qualified-name lookup that `DOMParser`
 *   supports in XML mode, and only falls back to a `*` scan when that finds
 *   nothing (the prefixed-document case). That keeps unprefixed parts —
 *   spreadsheets, rels — on the fast path, which matters because a capped
 *   sheet still asks for thousands of tiny lookups.
 */

const utf8 = new TextDecoder('utf-8')

function fail(message: string): never {
  throw new Error(`[office/xml] ${message}`)
}

/** Strip any `prefix:` from a qualified name. */
function bareName(qname: string): string {
  const colon = qname.indexOf(':')
  return colon === -1 ? qname : qname.slice(colon + 1)
}

/**
 * Parse an OOXML part. `DOMParser` in XML mode reports failures as a
 * `<parsererror>` element rather than throwing, so it must be checked
 * explicitly — otherwise a corrupt part would silently parse as empty.
 */
export function parseXml(text: string): Document {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const ctor = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser
  if (!ctor) {
    fail('DOMParser is unavailable in this runtime; office preview needs a browser or jsdom')
  }
  const doc = new ctor().parseFromString(source, 'application/xml')
  const error = doc.getElementsByTagName('parsererror')[0]
  if (error) {
    fail(`malformed XML part: ${(error.textContent ?? 'parse error').trim().split('\n')[0] ?? 'parse error'}`)
  }
  if (!doc.documentElement) fail('XML part has no document element')
  return doc
}

/** UTF-8 decode a ZIP entry into XML text (BOM stripped). */
export function decodeXml(bytes: Uint8Array): string {
  return utf8.decode(bytes)
}

/**
 * All descendants of `root` whose local name is `tag`, in document order.
 * Covers prefixed (`a:t`) and unprefixed documents with one call.
 */
export function findAll(root: Document | Element, tag: string): Element[] {
  const direct = root.getElementsByTagName(tag)
  if (direct.length > 0) {
    const out: Element[] = []
    for (let i = 0; i < direct.length; i++) {
      const el = direct[i]
      // `getElementsByTagName` matches the qualified name and is
      // document-scoped, so BOTH the subtree and the local-name check are
      // mandatory: the direct lookup misses prefixed nodes, and it happily
      // returns same-named nodes from outside this subtree.
      if (el && isWithin(root, el) && bareName(el.tagName) === bareName(tag)) out.push(el)
    }
    if (out.length > 0) return out
  }
  const out: Element[] = []
  const nodes = root.getElementsByTagName('*')
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i]
    if (el && isWithin(root, el) && bareName(el.tagName) === tag) out.push(el)
  }
  return out
}

function isWithin(root: Document | Element, el: Element): boolean {
  // `instanceof Document` would throw wherever `Document` is not a global
  // (Node without a DOM lib), so the node type is checked instead: 9 is
  // DOCUMENT_NODE, everything else here is an element (1).
  const scope = root.nodeType === 9 ? (root as Document).documentElement : (root as Element)
  if (!scope) return false
  return scope === el || scope.contains(el)
}

/** First descendant with the given local name, or undefined. */
export function findFirst(root: Document | Element, tag: string): Element | undefined {
  const direct = root.getElementsByTagName(tag)
  const hit = direct[0]
  if (hit) return hit
  const all = findAll(root, tag)
  return all[0]
}

/** Direct element children with the given local name. */
export function childrenOf(el: Element, tag: string): Element[] {
  const out: Element[] = []
  const kids = el.childNodes
  for (let i = 0; i < kids.length; i++) {
    const node = kids[i]
    if (node && node.nodeType === 1) {
      const child = node as Element
      if (bareName(child.tagName) === tag) out.push(child)
    }
  }
  return out
}

/** First direct child with the given local name. */
export function childOf(el: Element, tag: string): Element | undefined {
  return childrenOf(el, tag)[0]
}

/** Concatenated text of every `tag` descendant (the DrawingML `<a:t>` case). */
export function runsText(el: Element | null | undefined, tag: string): string {
  if (!el) return ''
  let out = ''
  for (const node of findAll(el, tag)) out += node.textContent ?? ''
  return out
}

/** Text content of an element itself (not its descendants' tags). */
export function textOf(el: Element | null | undefined): string {
  return el?.textContent ?? ''
}

/** Every `tag` descendant's text content, in document order. */
export function textOfAll(root: Document | Element, tag: string): string[] {
  return findAll(root, tag).map((el) => el.textContent ?? '')
}

/** Own attributes of an element as a plain record. */
export function attrsOf(el: Element | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!el) return out
  const attrs = el.attributes
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i]
    if (attr) out[attr.name] = attr.value
  }
  return out
}

/** Attribute by local name, so `val` matches both `val` and `w:val`. */
export function attr(el: Element | null | undefined, name: string): string | undefined {
  if (!el) return undefined
  const attrs = el.attributes
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i]
    if (attr && bareName(attr.name) === name) return attr.value
  }
  return undefined
}

/**
 * Prefixed attribute lookup, for the relationship namespace.
 * `<p:sldId id="256" r:id="rId2"/>` carries both, and the relationship is the
 * prefixed one — matching on local name alone would return the numeric id.
 */
export function attrPrefixed(el: Element | null | undefined, name: string): string | undefined {
  if (!el) return undefined
  const attrs = el.attributes
  for (let i = 0; i < attrs.length; i++) {
    const candidate = attrs[i]
    if (candidate && candidate.name.includes(':') && bareName(candidate.name) === name) return candidate.value
  }
  return attr(el, name)
}

/**
 * Relationship-id → target map parsed from a `.rels` part.
 * `r:id` / `r:embed` / `r:link` attributes are matched by local name too,
 * so a producer that drops the `r:` prefix still resolves.
 */
export function relsMap(doc: Document): Map<string, { type: string; target: string; targetMode?: string }> {
  const map = new Map<string, { type: string; target: string; targetMode?: string }>()
  for (const rel of findAll(doc, 'Relationship')) {
    const attrs = attrsOf(rel)
    const id = attr(rel, 'Id')
    const target = attr(rel, 'Target')
    if (!id || target === undefined) continue
    const entry: { type: string; target: string; targetMode?: string } = { type: attr(rel, 'Type') ?? '', target }
    const mode = attr(rel, 'TargetMode')
    if (mode !== undefined) entry.targetMode = mode
    map.set(id, entry)
  }
  return map
}

/**
 * Resolve a relationship target that is relative to the part's own folder.
 * Absolute targets (`/ppt/media/x.png`) and external ones
 * (`TargetMode="External"`) are returned as-is for the caller to filter.
 */
export function resolveRelTarget(baseDir: string, target: string): string {
  const raw = target.replace(/\\/g, '/')
  // Join BEFORE collapsing: normalising a bare `../media/x` on its own would
  // pop nothing and quietly turn it into `media/x`.
  if (raw.startsWith('/')) return normalisePath(raw)
  return normalisePath(`${baseDir}/${raw}`)
}

function normalisePath(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

/** The folder part of a zip entry path (`ppt/slides/slide1.xml` → `ppt/slides`). */
export function dirOf(entryPath: string): string {
  const at = entryPath.lastIndexOf('/')
  return at === -1 ? '' : entryPath.slice(0, at)
}
