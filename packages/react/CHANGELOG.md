# @flue/react

## 2.0.7

### Patch Changes

- d45e52a: Fix `useFlueAgent` callbacks changing identity on every store update — they now stay stable until the underlying session changes, preventing unnecessary re-renders and stale-effect churn.
- Updated dependencies [d45e52a]
- Updated dependencies [d45e52a]
  - @flue/sdk@2.0.7
