import YAML, { CST, isMap, isScalar, isSeq, type Node } from "yaml";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function updateNode(doc: YAML.Document, node: Node | null, value: unknown): Node {
  if (isMap(node) && isObject(value)) {
    for (const pair of [...node.items]) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") throw new Error("Configuration keys must be strings.");
      const key = pair.key.value;
      if (!(key in value)) node.delete(key);
      else pair.value = updateNode(doc, YAML.isNode(pair.value) ? pair.value : null, value[key]);
    }
    for (const [key, next] of Object.entries(value)) if (!node.has(key)) node.add({ key, value: next });
    return node;
  }
  if (isSeq(node) && Array.isArray(value)) {
    node.items = value.map((next, i) => updateNode(doc, YAML.isNode(node.items[i]) ? node.items[i] : null, next));
    return node;
  }
  if (isScalar(node) && (value === null || typeof value !== "object")) {
    node.value = value;
    return node;
  }
  const next = doc.createNode(value);
  if (node) {
    next.comment = node.comment;
    next.commentBefore = node.commentBefore;
    next.spaceBefore = node.spaceBefore;
  }
  return next;
}

type Collection = CST.BlockMap | CST.BlockSequence | CST.FlowCollection;
const collection = (token: CST.Token): token is Collection =>
  token.type === "block-map" || token.type === "block-seq" || token.type === "flow-collection";
const itemKey = (item: CST.CollectionItem, i: number) => item.key ? CST.resolveAsScalar(item.key)?.value ?? CST.stringify(item.key) : i;

function comments(token: CST.Token): CST.SourceToken[] {
  const found: CST.SourceToken[] = [];
  const scan = (part: CST.Token) => {
    if (part.type === "comment") found.push(part, { type: "newline", source: "\n", indent: part.indent, offset: part.offset });
    if (part.type === "document") {
      part.start.forEach(scan);
      if (part.value) scan(part.value);
      part.end?.forEach(scan);
    } else if (collection(part)) {
      for (const item of part.items) {
        item.start.forEach(scan);
        item.sep?.forEach(scan);
        if (item.key) scan(item.key);
        if (item.value) scan(item.value);
      }
      if (part.type === "flow-collection") part.end.forEach(scan);
    } else if (part.type === "block-scalar") part.props.forEach(scan);
    else if ("end" in part) part.end?.forEach(scan);
  };
  scan(token);
  return found;
}

/** Keep the original trivia and scalar spelling wherever a document edit did not change a value. */
function retainSource(old: CST.Token, next: CST.Token): CST.Token {
  if (CST.stringify(old) === CST.stringify(next)) return old;
  if (collection(old) && collection(next) && old.type === next.type) {
    const remaining = new Map(old.items.map((item, i) => [itemKey(item, i), item]));
    const items: CST.CollectionItem[] = next.items.map((item, i) => {
      const key = itemKey(item, i), prev = remaining.get(key);
      if (!prev) return item;
      remaining.delete(key);
      if (prev.value && item.value) prev.value = retainSource(prev.value, item.value);
      else prev.value = item.value;
      return prev;
    });
    // Comments on removed overrides still document the config; leave them at the collection's end.
    const orphaned = [...remaining.values()].flatMap((item) => comments({ type: "document", offset: 0, start: [...item.start, ...(item.sep ?? [])], value: item.value }));
    if (old.type === "flow-collection") {
      items.forEach((item, i) => {
        item.start = item.start.filter((t) => t.type !== "comma");
        if (i) item.start.unshift({ type: "comma", source: ",", offset: 0, indent: old.indent });
      });
      old.items = items;
      old.end.unshift(...orphaned);
    } else {
      // The parent separator already supplies the first item's indentation.
      if (items[0] && old.items[0] && items[0] !== old.items[0]) {
        const last = items[0].start.at(-1);
        if (last?.type === "space") items[0].start.pop();
      }
      items.forEach((item, i) => {
        if (i && !CST.stringify(items[i - 1]).endsWith("\n") && !CST.stringify(item).startsWith("\n")) {
          item.start.unshift({ type: "newline", source: "\n", offset: 0, indent: old.indent });
        }
      });
      if (old.type === "block-map") {
        old.items = items.map((item) => item.key !== undefined
          ? { start: item.start, key: item.key, sep: item.sep ?? [], value: item.value }
          : { start: item.start });
      } else old.items = items.map((item) => ({ start: item.start, value: item.value }));
      if (orphaned.length) old.items.push({ start: orphaned });
    }
    return old;
  }
  if (CST.isScalar(old) && CST.isScalar(next)) {
    const a = CST.resolveAsScalar(old), b = CST.resolveAsScalar(next);
    if (a?.value === b?.value && a?.type === b?.type) return old;
    // End tokens contain inline comments and whitespace; only the scalar's spelling changes.
    if (old.type !== "block-scalar" && next.type !== "block-scalar") {
      old.source = next.source;
      old.type = next.type;
      return old;
    }
  }
  const newComments = comments(next).filter((t) => t.type === "comment").map((t) => t.source);
  const missing = comments(old).filter((t) => {
    if (t.type !== "comment") return false;
    const i = newComments.indexOf(t.source);
    if (i < 0) return true;
    newComments.splice(i, 1);
    return false;
  }).flatMap((t): CST.SourceToken[] => [t, { type: "newline", source: "\n", offset: 0, indent: t.indent }]);
  if (missing.length) {
    const newline: CST.SourceToken = { type: "newline", source: "\n", offset: 0, indent: 0 };
    if (next.type === "block-map" || next.type === "block-seq") next.items.push({ start: [newline, ...missing] });
    else if ("end" in next) next.end = [...(next.end ?? []), newline, ...missing];
  }
  return next;
}

/** Edit a parsed YAML document, then reconcile its CST to preserve the original file's formatting. */
export function editConfigYaml(source: string, value: unknown): string {
  const tokens = [...new YAML.Parser().parse(source)];
  const docs = [...new YAML.Composer({ keepSourceTokens: true }).compose(tokens, true, source.length)];
  if (docs.length !== 1) throw new Error("Configuration must contain one YAML document.");
  const doc: YAML.Document = docs[0];
  if (doc.errors.length) throw doc.errors[0];
  doc.contents = updateNode(doc, doc.contents, value);
  const indent = source.match(/\n( +)\S/)?.[1].length ?? 2;
  const rendered = doc.toString({ lineWidth: 0, indent });
  const updated = [...new YAML.Parser().parse(rendered)].find((t) => t.type === "document");
  const original = tokens.find((t) => t.type === "document");
  if (!original || original.type !== "document" || !updated || updated.type !== "document") return rendered;
  if (original.value && updated.value) original.value = retainSource(original.value, updated.value);
  else original.value = updated.value;
  return tokens.map(CST.stringify).join("");
}
