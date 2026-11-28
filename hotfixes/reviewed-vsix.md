# Build the reviewed Local Replica VSIX

This package retains the `iamhyc.overleaf-workshop` extension ID so VS Code can reuse the existing settings and account storage. Either the original 0.15.10 local VSIX or the reviewed 0.15.12 VSIX supplies the published extension assets and dependencies. The packager checks the base against the recorded SHA-256 digests.

```sh
python3 hotfixes/package-reviewed-vsix.py \
  --base /path/to/overleaf-workshop-0.15.12.vsix \
  --output /path/to/overleaf-workshop-0.15.13.vsix
```

The packager copies `hotfixes/reviewed-runtime/` from the committed Git tree. It ignores working-tree edits. Pass `--revision <commit-or-ref>` to select a revision other than `HEAD`. The package manifest records the full commit and base VSIX digest. ZIP entries are sorted and normalized for repeatable builds with the same Python and zlib versions.

Install the resulting VSIX with the **Extensions: Install from VSIX...** command or with `code --install-extension /path/to/overleaf-workshop-0.15.13.vsix --force`. Reload the VS Code window and verify the displayed extension version. The installed `package.json` field `overleafWorkshopBuild.commit` identifies the Git revision.

## Test the packaged runtime

Unpack the built VSIX to a temporary directory. Run the file sync and transport
regressions against the unpacked extension. The activation retry tests read the
versioned runtime from the checkout.

```sh
OVERLEAF_REPLICA_MODULE=/path/to/unpacked/extension/out/scm/localReplicaSCM.js \
  node --test tests/reviewed-runtime/*.test.js
```

A directory created or moved into a watched Local Replica queues its contents.
Routine v2 document checks reuse the active collaboration connection. A
confirmed tree mismatch can rebuild it after pending writes finish.
With `syncOnFileChange.enabled` enabled, startup and background checks recover
missed local additions and saved edits to existing files. An existing file's
update is retried when the cloud version still matches the last verified shared
version. The replica stores that version's checksum in
`.overleaf/remote-sync-state.json`. Offline deletions, remote changes awaiting
review, and differences with no verified base stay in **Sync Local Replica**.
On upgrade, a file gets its first checksum when the copies agree or a chosen
sync is verified.
