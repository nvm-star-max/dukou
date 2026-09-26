# Contributing

Use English for code comments, identifiers, commit messages, and the default README. Keep the full Chinese guide in `README.zh-CN.md`, linked from the English homepage. `README.en.md` is a compatibility link to the default guide.

Chinese localization text, language-switch labels, and tests of Chinese behavior are intentional and must remain available. Do not replace user-provided filenames, paths, or device names during translation. Documentation changes must preserve security warnings and distinguish full peer mode from browser-only direct mode.

Before submitting a change, run `npm test` and the formatting check in `.github/workflows/ci.yml`. The language checks verify English comments and README links without banning localization strings. Never commit runtime data, credentials, downloaded files, or private keys.
