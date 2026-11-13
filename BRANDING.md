# Mosbius & Co. — branding rules

These rules apply to every screen, image, string and document a user can see.

1. **The product is Mosbius & Co.** Spell it exactly that way. Never "Mosibius", "Mosby & Co" or the upstream name.
2. **The universe is How I Met Your Mother.** Characters, places and jokes come from it: Ted, Marshall, Lily, Robin, Barney and the people around them; Ted's apartment, MacLaren's, GNB, the rooftop, Barney's apartment, Columbia, laser tag.
3. **The look is HIMYM pixel art.** Use the art in `src/renderer/src/assets/himym/` and the character recipes in `src/renderer/src/scene/office/portraitArt.ts`. New art is painted by code in `tools/himym/`, never lifted from a third-party pack.
4. **No Office material in the product.** No characters, names, photos, screenshots, quotes or branding from The Office or Dunder Mifflin in any user-facing screen, text or image.
5. **No inherited upstream visuals.** Welcome, workspace, setup, settings, help, release-note and empty screens show Mosbius & Co. art only.
6. **New screens follow the theme**: dark by default, pixel display type for headings, the night-sky or photo-album backgrounds, Ted as the guide.
7. **The upstream project is credited, not shown.** Keep `LICENSE` and the attribution files exactly as required. In the README it is named once, in a single credit line at the end. Internal identifiers inherited from upstream (file names, hook names, protocol ids) may stay when renaming would break existing users' data.
8. **Fan-made disclaimer.** Wherever the product is described publicly, say it is a fan-made project not affiliated with the show.
9. **No AI tools listed as contributors** in credits, README or about screens.

Before shipping, search the user-facing text (`src/renderer`, `README.md`, `CHANGELOG.md`) for `Munder`, `Dunder`, `Mifflin`, `The Office` and the Office cast's names, and explain any hit that remains.
