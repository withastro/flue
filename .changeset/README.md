# Changesets

Add a changeset for every change that should appear in the next release:

```sh
pnpm changeset
```

Select the affected package or packages, choose the appropriate semantic version
bump, and describe the user-facing change. Commit the generated Markdown file
with the rest of the change.

All public Flue packages belong to one fixed group. Changesets uses the largest
requested bump to version and publish the complete package set together.
Add any new public package to the fixed group in `config.json`.
