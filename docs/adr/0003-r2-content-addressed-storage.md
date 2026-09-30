# ADR-0003: R2 stores content-addressed raw blobs
Status: Accepted

Aracha stores raw document and attachment bytes in one R2 CAS.
cha computes BlobId.
Blob persistence must succeed before a Revision referring to it is committed.
Derived IR uses a separate disposable R2 namespace.
