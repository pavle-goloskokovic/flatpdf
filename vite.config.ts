import { cpSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

// pdf.js fetches these at runtime (CJK character maps, the 14 standard fonts,
// JPEG 2000 / JBIG2 decoders, ICC profiles). Serve them from our own origin so
// the page never calls a third-party host.
const pdfjsDir = resolve(root, 'node_modules/pdfjs-dist');
const outDir = resolve(root, 'public/pdfjs');
rmSync(outDir, { recursive: true, force: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs'])
{
    cpSync(resolve(pdfjsDir, dir), resolve(outDir, dir), { recursive: true });
}

export default defineConfig({
    // Relative base so the build works under /<repo>/ on GitHub Pages and at
    // the root of any other static host.
    base: './',
    build: {
        target: 'es2022',
        chunkSizeWarningLimit: 2000,
    },
});
