# First-party colour themes

Palettes written here rather than read out of somebody else's extension.
`npm run gen:themes` loads these the same way it loads the bundled VS Code
themes and the copies under `vendor/themes/`: a theme JSON in, one
`:root[data-theme="…"]` block out.

A palette only belongs here when there is no licensed original to vendor. If a
theme ships as an extension with an open licence, vendor it verbatim instead so
an upstream retune is a file replacement rather than a re-transcription.

| Directory | Theme | Origin |
| --- | --- | --- |
| `monokai-sun/` | Monokai Sun | The light palette of `sjdash`, its Monokai companion for a warm paper ground. Monokai Pro's Sun filter is the inspiration and is not the source: it is a paid theme, so nothing of it is copied here. |
| `light-modern-warm/` | Light Modern Warm | Light Modern's ink and accent on a cream editor with yellow-paper panels, and a louder status palette (green, blue, pink) picked to clear 3:1 on those panels so the generator does not darken it back. Syntax colours are Light+'s. |
