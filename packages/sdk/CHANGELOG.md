# @flue/sdk

## 2.0.8

No changes in this release.

## 2.0.7

### Patch Changes

- 1f6238a: Installed packages once again include the bundled Flue documentation, so commands such as `flue docs read guide/sandboxes` work out of the box.
- ef0c89f: Fix delayed reconnects in `observe()`: after a stream has been healthy for a full stream lifetime, the reconnect backoff resets, so a subsequent disconnect reconnects promptly instead of applying a stale delay.
