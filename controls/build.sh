#!/bin/sh
# builds controls.wasm from controls.cpp
# needs clang + wasm-ld (LLVM 15 or newer)
cd "$(dirname "$0")"
clang++ --target=wasm32 -O2 -std=c++17 -nostdlib -fno-exceptions -fno-rtti \
  -Wall -Wextra \
  -Wl,--no-entry -Wl,--strip-all \
  -o controls.wasm controls.cpp && echo "ok -> controls/controls.wasm"
