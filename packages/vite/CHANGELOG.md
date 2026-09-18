# @flue/vite

## 2.1.0-next.0

### Patch Changes

- Updated dependencies [4def7b6]
- Updated dependencies [4def7b6]
- Updated dependencies [12464d7]
- Updated dependencies [d9e7f5c]
- Updated dependencies [4827d6e]
- Updated dependencies [12464d7]
  - @flue/runtime@2.1.0-next.0

## 2.0.8

### Patch Changes

- Updated dependencies [aaefa69, 3d7a0ef, 3a6242f, 9d649bc, 2d800f5, 3f3daae, 28e1afe, c5b1e25]
  - @flue/runtime@2.0.8

## 2.0.7

### Patch Changes

- d830034: Markdown importers written in JSX (`.tsx`/`.jsx`) are now scanned correctly. SKILL.md imports that belong to the Agents SDK's virtual skill registry are left to its owning plugin instead of being claimed by Flue's transform.
- Updated dependencies [b8c07bb, 4b436f7, c1ceacd, c663410, 96b8f0b, 1f6238a, da7c085, 21c6240, 2227864, 68dbb37, 7527739, 750f1f1, 4a86eaa]
  - @flue/runtime@2.0.7

## 2.0.5

### Patch Changes

- Published packages once again resolve internal Flue dependencies to the release version.

## 2.0.3

### Patch Changes

- The Cloudflare Agents SDK (`agents`) is now a dependency of `@flue/vite` — projects no longer declare it.

## 2.0.0

### Patch Changes

- Flue is now a Vite plugin — `flue dev` and `flue build` are removed.
- `vite preview` now works on the Node target.
- The local CORS defaults now apply to Cloudflare-target `vite dev` and `vite preview`, tightened to localhost origins.
- Watcher event bursts (branch switch, format-on-save across files) now coalesce into at most one queued pass.
- `@flue/vite` hardening from a comparative review against SvelteKit's and TanStack Start's Vite plugins.
