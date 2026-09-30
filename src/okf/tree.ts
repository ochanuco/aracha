import { parseFrontmatter, splitDocument } from "./frontmatter";
import { parseMarkdown, type MNode } from "./md";
import { isMap, isNode, isScalar, parseDocument } from "yaml";

export type Attr = string | number | boolean;

export interface TypedNode {
  kind: string;
  attributes: Record<string, Attr>;
  text: string;
  children: TypedNode[];
}

const node = (
  kind: string,
  attributes: Record<string, Attr> = {},
  text = "",
  children: TypedNode[] = [],
): TypedNode => ({ kind, attributes, text, children });

function plain(n: MNode): string {
  if (n.children) return n.children.map(plain).join("");
  return n.value ?? "";
}

function linksIn(n: MNode, out: TypedNode[]): void {
  if (n.type === "link") {
    out.push(node("link", { target: n.url ?? "" }, plain(n)));
    return;
  }
  for (const c of n.children ?? []) linksIn(c, out);
}

function convert(n: MNode): TypedNode {
  switch (n.type) {
    case "heading":
      return node("heading", { level: n.depth ?? 1 }, plain(n));
    case "paragraph": {
      const links: TypedNode[] = [];
      linksIn(n, links);
      return node("paragraph", {}, plain(n), links);
    }
    case "definition":
      return node("link", { target: n.url ?? "" }, "");
    case "list":
      return node("list", { ordered: n.ordered === true }, "", (n.children ?? []).map(convert));
    case "listItem":
      return node("list_item", {}, "", (n.children ?? []).map(convert));
    case "code":
      return node("code_block", { lang: n.lang ?? "" }, n.value ?? "");
    case "blockquote":
      return node("other", { type: n.type }, "", (n.children ?? []).map(convert));
    default:
      return node("other", { type: n.type }, plain(n));
  }
}

function frontmatterNode(text: string): TypedNode {
  const fm = node("frontmatter");
  if (parseFrontmatter(text) === null) return fm;
  const doc = parseDocument(text);
  if (!isMap(doc.contents)) return fm;
  for (const pair of doc.contents.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    const value = isNode(pair.value) ? pair.value.toJS(doc) : null;
    fm.children.push(node("metadata", { key }, JSON.stringify(value ?? null)));
  }
  return fm;
}

export function toTypedTree(bytes: Uint8Array): TypedNode {
  const { frontmatter, body } = splitDocument(bytes);
  const root = node("document");
  if (frontmatter !== null) root.children.push(frontmatterNode(frontmatter));

  const stack: { level: number; node: TypedNode }[] = [];
  for (const block of parseMarkdown(body)) {
    const converted = convert(block);
    if (block.type === "heading") {
      const level = block.depth ?? 1;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      const section = node("section", { level }, "", [converted]);
      (stack.length > 0 ? stack[stack.length - 1]!.node : root).children.push(section);
      stack.push({ level, node: section });
    } else {
      (stack.length > 0 ? stack[stack.length - 1]!.node : root).children.push(converted);
    }
  }
  return root;
}
