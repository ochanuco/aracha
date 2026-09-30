# ADR-0006: Concept rename updates known backlinks and preserves aliases
Status: Accepted

Rename is the required PoC multi-document Operation.
Known inbound references are discovered from D1 and updated through the coordinator.
Because D1 is eventually consistent, the old path remains an alias until repair/reindex confirms no references remain.
