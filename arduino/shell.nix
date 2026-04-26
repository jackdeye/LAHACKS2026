{ pkgs ? import <nixpkgs> { } }:

(pkgs.buildFHSEnv {
  name = "arduino-dev";

  targetPkgs = p: with p; [
    arduino
    arduino-cli
    avrdude
    git
    stdenv.cc.cc.lib
  ];

  runScript = "bash";
}).env
