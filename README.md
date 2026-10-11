# swim website

The website of [swim](https://github.com/pjako/csharp-ui), an immediate-mode UI library in C. The site is itself a swim app:
`index.html` loads `index.wasm` (swim compiled to WebAssembly) and draws with Canvas 2D; `playground.html` is the widget
playground, with Canvas 2D and WebGL2 (swim_render).

This repository holds build output only. The source is `examples/site/site.c` and `bindings/web/` in the swim repository, built
with `examples/site/build.sh <dir> --split`.

Fonts in `fonts/`: IBM Plex Sans and its script companions, Copyright 2018-2019 IBM Corp., licensed under the SIL Open Font
License 1.1 (https://openfontlicense.org, https://github.com/IBM/plex/blob/master/LICENSE.txt). "Plex" is a Reserved Font Name.
