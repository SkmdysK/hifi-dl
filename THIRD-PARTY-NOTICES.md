# Third-Party Notices

HiFi-DL is built on top of the following upstream open-source projects. The
`LICENSE` file in the repository root covers the HiFi-DL source code authored by
this project only. Files under `vendor/` remain under their own upstream
licenses.

## Bundled / vendored

### qobuz-dl (GPL-3.0)

- Upstream: <https://github.com/infojunkie/qobuz-dlp.py>
- Vendored at: `vendor/qobuz-dl/`
- License: GNU General Public License v3.0
  (see `vendor/qobuz-dl/pylibs/qobuz_dl-0.9.9.10.dist-info/LICENSE`)

Because the packaged macOS / Windows builds and the web build redistribute this
GPL-3.0 component, **any distributed bundle of HiFi-DL that contains
`vendor/qobuz-dl/` must be distributed under GPL-3.0 terms as a whole**, and the
corresponding source must be made available.

## Referenced, not vendored

### lx-music-desktop (MIT)

- Upstream: <https://github.com/lyswhut/lx-music-desktop>
- License: Apache-2.0 (see upstream repository)
- HiFi-DL does not bundle source scripts or download links; user-supplied LX
  sources are loaded at runtime.

## Legal note

HiFi-DL contains no audio content, no source scripts and no download links
itself. Users are responsible for complying with the laws of their jurisdiction
and with the terms of service of any third-party service they configure.
