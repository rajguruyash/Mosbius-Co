# Working on Mosbius & Co.

Read `BRANDING.md` before changing anything a user can see. Its rules are mandatory: the product is Mosbius & Co., the world is How I Met Your Mother in original pixel art, and nothing from The Office or the upstream project appears in user-facing screens.

- Rooms are painted by code in `tools/himym/`; run `python3 tools/himym/build.py` to re-export the art after changing them.
- Node 22 is required (`/usr/local/bin/node` on the owner's Mac; Homebrew's Node 26 breaks the native modules).
- Do not list AI assistants as contributors.
