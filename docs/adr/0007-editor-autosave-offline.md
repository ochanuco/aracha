# ADR-0007: Raw Markdown editor with autosave and simple offline safety
Status: Accepted

Use a raw Markdown editor.
Autosave uses 1-second debounce and 10-second maximum interval.
Change closes after 5 minutes idle or important boundaries.
IndexedDB retains only the latest unsent full document plus base RevisionId.
