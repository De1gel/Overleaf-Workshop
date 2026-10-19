import * as path from 'path';
import * as Mocha from 'mocha';
import { installModuleMocks } from './vscodeMock';

// Exercise actual providers and HTTP encoding with in-memory VS Code storage
// and a stubbed HTTP transport. Never connect to a real Overleaf project.
async function main() {
    const restore = installModuleMocks();
    try {
        const mocha = new Mocha({ui: 'tdd', color: true, timeout: 5000});
        mocha.addFile(path.join(__dirname, 'localReplica.test.js'));
        mocha.addFile(path.join(__dirname, 'lifecycle.test.js'));
        mocha.addFile(path.join(__dirname, 'upload.test.js'));
        mocha.addFile(path.join(__dirname, 'uploadFailure.test.js'));
        const failures = await new Promise<number>(resolve => mocha.run(resolve));
        process.exitCode = failures === 0 ? 0 : 1;
    } finally {
        restore();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
