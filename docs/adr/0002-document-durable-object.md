# ADR-0002: One Document Durable Object per document
Status: Accepted

One DocumentId maps to one SQLite-backed Durable Object.
It owns heads, Change/Revision history, single-document Operations, projection sequence, and operation idempotency records.
Stale base edits become competing heads rather than being rejected.
