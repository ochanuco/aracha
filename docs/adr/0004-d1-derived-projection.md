# ADR-0004: D1 is an eventually consistent derived projection
Status: Accepted

D1 stores document metadata, graph edges/backlinks, FTS5 content, and operation indexes.
Each Document DO publishes minimal Queue messages with workspace_id, document_id, revision_id, and monotonic projection_seq.
Consumers ignore duplicate/out-of-order older sequences.
