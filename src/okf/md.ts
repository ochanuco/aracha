import { fromMarkdown } from "mdast-util-from-markdown";

/** The subset of mdast node fields this module reads. */
export interface MNode {
  type: string;
  children?: MNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  url?: string;
  value?: string;
  depth?: number;
  lang?: string | null;
  ordered?: boolean | null;
}

export function parseMarkdown(body: string): MNode[] {
  return (fromMarkdown(body) as unknown as MNode).children ?? [];
}
