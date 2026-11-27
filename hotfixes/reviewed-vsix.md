# Build the reviewed Local Replica VSIX

This package retains the `iamhyc.overleaf-workshop` extension ID so VS Code can reuse the existing extension settings and account storage. The original `overleaf-workshop-local.vsix` supplies the published extension assets and dependencies. Use the original local file with SHA-256 `2a27cbaea6af4800bf75c97f4a71ebc6d39f27bf794dd5be5c029bc22e942cc7`.

```sh
python3 hotfixes/package-reviewed-vsix.py \
  --base /path/to/overleaf-workshop-local.vsix \
  --output /path/to/overleaf-workshop-0.15.11.vsix
```

The packager copies `hotfixes/reviewed-runtime/` from the committed Git tree. It ignores working-tree edits. Pass `--revision <commit-or-ref>` to select a revision other than `HEAD`. The package manifest records the full commit and base VSIX digest. ZIP entries are sorted and normalized for repeatable builds with the same Python and zlib versions.

Install the resulting VSIX with the **Extensions: Install from VSIX...** command or with `code --install-extension /path/to/overleaf-workshop-0.15.11.vsix --force`. Reload the VS Code window and verify the displayed extension version. The installed `package.json` field `overleafWorkshopBuild.commit` identifies the Git revision.

## Test the packaged runtime

Unpack the built VSIX to a temporary directory. Run the file sync and transport
regressions against the unpacked extension. The activation retry tests read the
versioned runtime from the checkout.

\`\`\`sh
OVERLEAF_REPLICA_MODULE=/path/to/unpacked/extension/out/scm/localReplicaSCM.js \
  node --test tests/reviewed-runtime/*.test.js
\`\`\`

A directory created or moved into a watched Local Replica queues its files and
nested empty directories. When \`syncOnFileChange.enabled\` is enabled, a successful
startup or background check also queues previously missed local additions. Any
same-path cloud change stays subject to review. Offline deletions and changes to
already tracked files remain available for review in **Sync Local Replica**.
