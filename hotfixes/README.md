# Existing snapshot-review hotfix installations

`local-replica-snapshot-busy.patch` applies to the compiled Local Replica
synchronizer when it already contains the snapshot/conflict-review hotfix and
the file-upload fix from this pull request. It retains the review checks and
allows up to 15 seconds for active transfers to finish before abandoning a
snapshot refresh. Cancellation is checked during that wait.

The base TypeScript synchronizer in this repository does not have that snapshot
refresh guard. Do not apply this compiled-code patch to an unmodified build.

The additional regression cases can be run against the patched installation:

```sh
OVERLEAF_REPLICA_STAGE=/path/to/extension/out/scm/localReplicaSCM.js \
  node --test tests/local-replica-creation.test.js
```

These tests verify successful waiting beyond the previous 300 ms limit,
cancellation, and a bounded wait that never records a failed upload as synced.
