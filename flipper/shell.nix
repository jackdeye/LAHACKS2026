{ pkgs ? import <nixpkgs> { } }:

# `ufbt` is not packaged in nixpkgs and downloads a pre-built ARM toolchain
# whose dynamic linker assumes an FHS layout. We use buildFHSEnv so those
# downloaded binaries actually run on NixOS, then install ufbt into a local
# venv on first entry.
(pkgs.buildFHSEnv {
  name = "flipper-dev";

  targetPkgs = p: with p; [
    python3
    python3Packages.pip
    python3Packages.virtualenv
    git
    gnumake
    openssl
    zlib
    libusb1
    stdenv.cc.cc.lib
  ];

  profile = ''
    if [ ! -x .venv/bin/ufbt ]; then
      python3 -m venv .venv
      .venv/bin/pip install --upgrade pip ufbt
    fi
    export PATH="$PWD/.venv/bin:$PATH"
    echo "Flipper Zero dev shell ready — run 'ufbt' to build, 'ufbt flash' to deploy."
  '';

  runScript = "bash";
}).env
