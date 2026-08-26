# Vendored colour themes

Marketplace themes that VS Code does not bundle, kept here verbatim so that
`npm run gen:themes` can read them the same way it reads the bundled ones.
Each directory is the theme's own files plus its licence; nothing is edited.
To pick up an upstream retune, replace the files and regenerate.

| Directory | Extension | Upstream | Version | Licence |
| --- | --- | --- | --- | --- |
| `monokai-plusplus/` | `dcasella.monokai-plusplus` | https://github.com/dcasella/monokai-plusplus (`e33ca6b`) | 2.0.4 | MIT, Davide Casella |
| `one-monokai/` | `azemoh.one-monokai` | https://github.com/azemoh/vscode-one-monokai (`4244482`) | 0.5.0 | MIT, Joshua Azemoh |

Only themes with an explicit open licence go here. Monokai Charcoal high
contrast (`74th.monokai-charcoal-high-contrast`) was considered and left out:
its repository carries no licence file and its manifest no `license` field.
