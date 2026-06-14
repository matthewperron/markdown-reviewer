{
  # markdown-reviewer — browser-based markdown annotation tool (mdr).
  #
  #   nix run .                      -- file.md      # run mdr against a file
  #   nix run github:matthewperron/markdown-reviewer -- file.md
  #   nix build .#markdown-reviewer                  # build the package
  #   nix develop                                    # dev shell with bun
  #
  description = "markdown-reviewer — browser-based markdown annotation tool (mdr)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        # Single source of truth: keep version in sync with package.json.
        version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

        # ---------------------------------------------------------------------
        # Vendored node_modules.
        #
        # This is a fixed-output derivation: it is allowed network access to run
        # `bun install`, and its result is pinned by `outputHash`. The output is
        # a function of both the dependencies (package.json / bun.lock) *and* the
        # Bun version. Since nixpkgs is tracked at nixos-unstable, bumping the
        # flake inputs can move `pkgs.bun` and change the install output, so a
        # hash mismatch here may mean either a dependency change or a Bun bump.
        # Either way, update the hash — Nix prints the correct value on mismatch,
        # or run:
        #   nix build .#node_modules --rebuild
        # ---------------------------------------------------------------------
        node_modules = pkgs.stdenvNoCC.mkDerivation {
          pname = "markdown-reviewer-node_modules";
          inherit version;

          # Only the files that affect dependency resolution, so editing source
          # does not invalidate the vendored deps.
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./package.json
              ./bun.lock
              ./bunfig.toml
            ];
          };

          nativeBuildInputs = [ pkgs.bun ];

          dontConfigure = true;

          buildPhase = ''
            runHook preBuild
            export HOME=$TMPDIR
            bun install --frozen-lockfile --no-progress
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp -R node_modules $out/node_modules
            runHook postInstall
          '';

          # Skip the fixup phase — it would rewrite shebangs/RPATHs inside the
          # vendored package tree, which we want left byte-for-byte as Bun
          # installed it. The output is pinned per-platform by outputHash; if a
          # dependency embeds arch-specific paths, the hash differs per system
          # (each platform builds its own node_modules), which is expected.
          dontFixup = true;

          outputHashMode = "recursive";
          outputHashAlgo = "sha256";
          outputHash = "sha256-yg0K80Rhk/Gq9+y325/mt1+HfBKthSSLOOhypfVd4KM=";
        };

        # Full app source (used by the package and the test check).
        appSrc = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            ./package.json
            ./bun.lock
            ./bunfig.toml
            ./tsconfig.json
            ./src
            ./public
          ];
        };

        markdown-reviewer = pkgs.stdenvNoCC.mkDerivation {
          pname = "markdown-reviewer";
          inherit version;

          src = appSrc;

          nativeBuildInputs = [ pkgs.makeWrapper ];
          buildInputs = [ pkgs.bun ];

          dontConfigure = true;
          dontBuild = true;

          installPhase = ''
            runHook preInstall

            # App lives in libexec; assets are resolved relative to src/ via
            # import.meta.dir, so the layout (src/, public/) must be preserved.
            appdir=$out/libexec/markdown-reviewer
            mkdir -p "$appdir"
            cp -R src public package.json bun.lock bunfig.toml tsconfig.json "$appdir/"
            ln -s ${node_modules}/node_modules "$appdir/node_modules"

            makeWrapper ${pkgs.bun}/bin/bun $out/bin/mdr \
              --add-flags "run $appdir/src/cli/index.ts"

            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "Browser-based markdown annotation tool";
            homepage = "https://github.com/matthewperron/markdown-reviewer";
            license = licenses.mit;
            mainProgram = "mdr";
            platforms = platforms.unix;
          };
        };
      in
      {
        packages = {
          inherit node_modules markdown-reviewer;
          default = markdown-reviewer;
        };

        apps.default = {
          type = "app";
          program = "${markdown-reviewer}/bin/mdr";
        };

        devShells.default = pkgs.mkShell {
          # Bun-only project — no Node runtime needed.
          packages = [ pkgs.bun ];
        };

        # `nix flake check` runs the (network-free) Bun test suite against the
        # vendored node_modules.
        checks.default = pkgs.stdenvNoCC.mkDerivation {
          pname = "markdown-reviewer-tests";
          inherit version;
          src = appSrc;
          nativeBuildInputs = [ pkgs.bun ];
          dontConfigure = true;
          buildPhase = ''
            runHook preBuild
            export HOME=$TMPDIR
            ln -s ${node_modules}/node_modules node_modules
            bun test
            runHook postBuild
          '';
          installPhase = ''
            touch $out
          '';
        };
      });
}
