# Install Shared Blueprint Interactive Preview

Shared Blueprint Interactive Preview requires Node.js `^22.19` or `>=24`, pnpm `11.19.0`, and credentials for a model provider supported by DSH. The release artifacts never include credentials, local sessions, presets, browser profiles, or cache data.

## Complete Build

The Complete Build is the recommended download. It contains prebuilt DSH `0.1.0-rc.7` packages with the frozen generic compatibility changes and `dsh-shared-blueprint@0.1.0-beta.1`; it does not contain `node_modules`.

```sh
tar -xzf shared-blueprint-interactive-preview-complete-build-0.1.0-beta.1.tgz
cd package
pnpm install --frozen-lockfile --config.optional=false
pnpm start
```

`pnpm start` installs the included Blueprint bundle into an isolated `.dsh` home on first run, then starts the ordinary DSH Web app at `http://127.0.0.1:3080`. Set `DSH_HOME` before starting if you want to use another DSH home.

Configure your provider through the existing DSH credential path. For the standard DeepSeek provider, supply `DEEPSEEK_API_KEY` to the process; a local `.env` file is also supported by DSH but is never included in the release artifact.

```sh
export DEEPSEEK_API_KEY="your-key"
pnpm start
```

PowerShell uses `$env:DEEPSEEK_API_KEY = "your-key"` for the same process environment. Without a usable provider, the Web app can start, but agent creation and Try Agent cannot complete real model work.

## Standalone Bundle

The standalone tarball is for developers who want to install the out-of-tree package into a compatible DSH checkout. Use the exact branch and commit recorded in the companion compatibility JSON and `RELEASE_MANIFEST.json`; do not start from untouched official rc.7.

```sh
git clone --branch release/interactive-preview-v0.1 https://github.com/afterDDL/dsh-creator-shared-blueprint.git
cd dsh-creator-shared-blueprint
git checkout <commit-from-compatibility-json>
pnpm install --frozen-lockfile
pnpm run build
pnpm dsh plugin --profile web add /absolute/path/to/dsh-shared-blueprint-0.1.0-beta.1.tgz
pnpm dsh web
```

The absolute tarball path in the command is supplied by the installer at runtime; no machine path is embedded in the artifact. Configure the provider through the same DSH mechanism described above.

## Verify the download

Run the platform's SHA-256 utility against the downloaded files and compare the result with `SHA256SUMS.txt`. On PowerShell, use `Get-FileHash -Algorithm SHA256 <file>`; on systems with GNU coreutils, use `sha256sum -c SHA256SUMS.txt` from the release staging directory.
