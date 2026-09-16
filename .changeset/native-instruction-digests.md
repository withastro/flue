---
'@flue/runtime': patch
---

Use native synchronous SHA-256 for instruction fingerprints to reduce rendering overhead. Hash UTF-16LE bytes to preserve distinctions between all JavaScript strings, including lone surrogates. Canonical journal fingerprints remain unchanged.

Persisted conversations using the previous FNV instruction fingerprint emit one extra "System instructions updated" marker when first compared with the new fingerprint, then use SHA-256 for subsequent comparisons. This preserves conversation history and requires no storage migration.
