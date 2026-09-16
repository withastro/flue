# @flue/react

## 2.0.8

### Patch Changes

- Updated dependencies [9d649bc]
  - @flue/sdk@2.0.8

## 2.0.7

### Patch Changes

- 6e62278: Fix `useFlueAgent` callbacks changing identity on every store update — they now stay stable until the underlying session changes, preventing unnecessary re-renders and stale-effect churn.
- Updated dependencies [1f6238a, ef0c89f]
  - @flue/sdk@2.0.7
