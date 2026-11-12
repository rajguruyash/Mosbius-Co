# Asset attribution

Every image in `assets/himym/` (the world backdrop, the tall-piece atlas, the
street shot, the cab) is original pixel art, painted by the code in
`tools/himym/`. Nothing in it is taken from a third-party pack.

Every character — card portraits and floor sprites — is drawn procedurally in
`scene/office/portraitArt.ts` from per-character recipes. That code comes from
the upstream project and is MIT licensed like the rest of the source.

The upstream project (Munder Difflin) bundled the paid "Modern Interiors" tile
pack by LimeZu for its office map. That pack may not be redistributed, so this
fork removed the tiles, the two maps built on them, and the tools that read
them. The fonts in `assets/fonts/` keep their own licence (see `LICENSE.txt`
there).

Mosby & Co is a fan-made parody. It is not affiliated with or endorsed by the
makers or owners of How I Met Your Mother.
