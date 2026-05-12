# Removed large legacy surfaces

These were removed from the public tree on `rebuild/clean-root-app`.

They are preserved exactly in the backup branch:

- Branch: `backup-before-full-clean-rebuild`
- Base commit: `6b89d4b920f21dab86549a9c0b1cc15e4f2adaeb`

Removed paths:

- `index.html`
- `app-release/index.html`
- `sync-cloud/index.html`
- `sync-cloud/final.html`
- `src/main.js`

Reason: these files were old/experimental public app or recovery/Auth surfaces and should not remain deployable during the clean rebuild.
