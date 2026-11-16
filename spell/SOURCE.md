# Spelling files (vendored, no install)

Used by `../check.js` (the planner's spelling and grammar check). Nothing here is installed at run time.

| File | Source | Version | License |
|---|---|---|---|
| `nspell.js` | [nspell](https://github.com/wooorm/nspell) by Titus Wormer, bundled once with esbuild 0.28.2 into a plain script that sets `globalThis.NSpell` (and `module.exports` under Node) | nspell 2.1.5 | MIT (`LICENSE-nspell`) |
| `index.aff`, `index.dic` | [dictionary-en](https://github.com/wooorm/dictionaries/tree/main/dictionaries/en) (Hunspell en_US from SCOWL, 2020.12.07), copied unchanged | dictionary-en 4.0.0 | MIT AND BSD (`LICENSE-dictionary-en`) |

Bundled on 2026-11-16 in a temporary folder outside the repositories: `npm install nspell dictionary-en esbuild`, then esbuild with `entry.cjs` = `module.exports = require('nspell')`, format `iife`, global name `NSpell`, platform `neutral`, target `es2018`.

SHA-256:
- `nspell.js` c3e5834a915b8bc5b545ab28b96e2e5e1e29a48d8722522e0bdf1d07aeedf5f7
- `index.aff` 8ae1f19d4840d957728ad90555d5a8dff6cc5c046279c95ff0c00fc0a0136c7b
- `index.dic` f0b1a234bd178bdd01875b2a392a9647f888b8fe879f79c52aae62c2759b3647

The same files sit in the page's repository (`planner-voice/spell/`); `tools/sync-page.mjs` copies them.
