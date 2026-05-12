# Archive

Legacy code kept here only for reference during the full clean rebuild.

Do not publish this directory.

The deploy workflow copies only `app/` and `404.html` into `dist/`. `archive/` must never be copied to `dist` or GitHub Pages.

Full pre-clean snapshot branch: `backup-before-full-clean-rebuild`
Base commit: `6b89d4b920f21dab86549a9c0b1cc15e4f2adaeb`

Archived here:
- root legacy public HTML files where blob SHA was available
- old root PWA files
- old cloud-sync/Auth support scripts

Large legacy surfaces removed from the public tree are recoverable from the backup branch:
- `index.html`
- `app-release/`
- `sync-cloud/`
- old recovery/email/Magic Link surfaces
