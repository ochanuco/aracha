export { splitDocument, readMeta, writeArachaMeta } from "./frontmatter";
export type { SplitResult, Meta } from "./frontmatter";
export { extractLinks, rewriteLinks, resolveHref } from "./links";
export type { LinkRef } from "./links";
export { toTypedTree } from "./tree";
export type { TypedNode, Attr } from "./tree";

/** Bump when parsing behaviour changes so cached IR is rebuilt. */
export const PARSER_VERSION = "1";
/** Bump when the shape of the typed tree changes. */
export const IR_SCHEMA_VERSION = "1";
