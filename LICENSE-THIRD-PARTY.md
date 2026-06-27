# Third-Party Licenses

berth-control bundles and links against third-party code under permissive
licenses. Original copyright notices are reproduced below as required.

## macos-temperature-sensor

The Apple Silicon temperature reader in `src/lib/server/monitor/native/`
(`temps.h`, `temps.c`, `addon.c`) was ported into this repository from
[macos-temperature-sensor v1.0.4](https://github.com/sebhildebrandt/macos-temperature-sensor).
Function and type names were prefixed `bt_` (was `mt_`) and the native
module name changed to `berth_temp` (was `mac_temp_native`) to avoid
collision; the IOHIDEventSystem logic is otherwise unchanged.

Upstream license:

```
The MIT License (MIT)

Copyright (c) 2025 Sebastian Hildebrandt

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```
