# ADR-0005: Multi-document operations use OperationCoordinator Durable Objects
Status: Accepted

Each multi-document Operation gets a dedicated Coordinator DO.
Strict distributed ACID is not required.
State includes pending, applying, partially_applied, completed.
Per-document application is idempotent by (OperationId, DocumentId).
Cancellation creates a compensating Operation.
