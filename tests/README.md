# File upload regression tests

Run with Node.js 24 (the locked undici dependency requires Node.js 22.19 or newer):

```sh
npm ci --ignore-scripts
npx tsc -p tsconfig.json --noEmit
npm run test:upload
```

These tests use synthetic projects and a mock HTTP dispatcher. They do not
connect to Overleaf or read account credentials. They verify multipart file
bytes, API failure propagation, and creation of new Local Replica files and
their parent directories.
